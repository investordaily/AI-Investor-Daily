/**
 * AI Investor Daily — Master Generator Script
 * - Fetches free AI news
 * - Extracts first 100 words
 * - Computes top 5 AI stock picks (>= 3 small-caps)
 * - Builds HTML email
 * - Writes output/daily-email-YYYY-MM-DD.html
 * - Reads subscriber list from Google Sheets
 */

const axios = require("axios");
const cheerio = require("cheerio");
const Parser = require("rss-parser");
const { DateTime } = require("luxon");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const brandColor = "#355E3B";
const logoUrl = "https://drive.google.com/uc?export=view&id=1MS2N2mFlmgffzZFQVDdD2AEsvXBup8I4";

const SHEET_ID = "1wGOA7BD94fF2itKauDbvMD3aqw583PjL2pXp7mjsLiw";
const SHEET_NAME = "Subscribers";

// ----------------------
// GOOGLE AUTH
// ----------------------
async function getGoogleAuth() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return auth.getClient();
}

async function getEmailList() {
  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const range = `${SHEET_NAME}!A:A`;
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range,
    });

    const rows = response.data.values || [];

    return rows
      .map(r => (r[0] || "").trim())
      .filter(email => email && email.includes("@"));
  } catch (err) {
    console.error("❌ Error reading Google Sheet:", err);
    return [];
  }
}

// ----------------------
// FETCH ARTICLES
// ----------------------
async function fetchFreeArticles() {
  const parser = new Parser();
  const feeds = [
    "https://news.google.com/rss/search?q=artificial+intelligence+technology+investment+finance&hl=en-US&gl=US&ceid=US:en",
    "https://www.marketwatch.com/rss/tech",
    "https://www.theverge.com/rss/index.xml",
  ];

  const articles = [];

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed);
      for (const item of parsed.items.slice(0, 8)) {
        const preview = await extractFirst100Words(item.link);
        articles.push({
          title: item.title,
          link: item.link,
          preview,
        });
      }
    } catch (err) {
      console.error("Feed error:", feed, err);
    }
  }

  return articles.slice(0, 10);
}

async function extractFirst100Words(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(res.data);
    const text = $("p").text().replace(/\s+/g, " ").trim();

    return text.split(" ").slice(0, 100).join(" ") + "...";

  } catch (err) {
    console.error("Preview error:", url, err);
    return "No preview available.";
  }
}

// ----------------------
// STOCK PICKS
// ----------------------
async function fetchStockData() {
  const tickers = [
    "AI", "PATH", "PLTR", "UPST", "SOUN", "BBAI", "NVDA", "AMD", "SMCI",
    "GOOGL", "AMZN", "TSLA", "CRWD", "ZS", "SNOW"
  ];

  const picks = [];

  for (const t of tickers) {
    try {
      // Yahoo Finance API substitute
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${t}?modules=price`;
      const res = await axios.get(url);

      const price = res.data.quoteSummary?.result?.[0]?.price;

      if (!price || !price.marketCap) continue;

      picks.push({
        ticker: t,
        fullName: price.shortName || t,
        marketCap: price.marketCap.raw,
        reason: `AI-related company with recent momentum and strong market activity.`,
        link: `https://finance.yahoo.com/quote/${t}`
      });

    } catch {
      continue;
    }
  }

  return picks;
}

function selectTop5(picks) {
  const smallCaps = picks.filter(p => p.marketCap < 2_000_000_000);
  const largeCaps = picks.filter(p => p.marketCap >= 2_000_000_000);

  const chosen = [
    ...smallCaps.sort((a,b) => b.marketCap - a.marketCap).slice(0,3),
    ...largeCaps.sort((a,b) => b.marketCap - a.marketCap).slice(0,2)
  ];

  return chosen.slice(0,5);
}

// ----------------------
// EMAIL HTML BUILDER
// ----------------------
function escapeHtml(str = "") {
  return str.replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  );
}

function formatMoney(num) {
  if (!num) return "";
  return "$" + (num / 1_000_000_000).toFixed(2) + "B";
}

function buildEmailHtml(dateStr, picks, articles) {
  const displayPicks = picks || [];

  const picksHtml = displayPicks.map((p, idx) => {
    const name = escapeHtml(p.fullName);
    const ticker = p.ticker;

    const tickerLink = `
      <a href="https://finance.yahoo.com/quote/${ticker}"
         style="color:${brandColor};text-decoration:underline;"
         target="_blank">${ticker}</a>
    `;

    return `
      <div style="padding:14px;border-left:4px solid ${brandColor};margin-bottom:18px;background:#f9faf8;border-radius:6px;">
        <h3 style="margin:0;color:#2b4b3a;font-size:17px;">
          <a href="${p.link}" style="color:inherit;text-decoration:none;" target="_blank">
            ${idx+1}. ${name}
          </a> — ${tickerLink}
        </h3>
        <p style="margin:6px 0 0 0;font-size:14px;color:#333;">
          ${escapeHtml(p.reason)}
          <br><strong>Market cap:</strong> ${formatMoney(p.marketCap)}
        </p>
        <a href="${p.link}" target="_blank"
           style="display:inline-block;margin-top:8px;padding:6px 12px;background:#111;color:#fff;text-decoration:none;border-radius:5px;font-size:13px;">
          View Chart & News
        </a>
      </div>
    `;
  }).join("");

  const articlesHtml = articles.map(a => `
    <div style="margin-bottom:20px;">
      <h3 style="margin:0 0 5px;font-size:16px;"><a href="${a.link}" style="color:${brandColor};">${escapeHtml(a.title)}</a></h3>
      <p style="margin:0;font-size:14px;line-height:1.5;text-align:left;">${escapeHtml(a.preview)}</p>
    </div>
  `).join("");

  return `
  <div style="font-family:Arial, sans-serif;max-width:600px;margin:auto;padding:20px;color:#222;">
    <div style="text-align:center;margin-bottom:20px;">
      <img src="${logoUrl}" style="max-width:180px;" />
      <h1 style="color:${brandColor};margin:5px 0 0;font-size:24px;">AI Investor Daily</h1>
      <p style="font-size:14px;color:#444;margin:4px 0 0;">${dateStr}</p>
    </div>

    <h2 style="color:${brandColor};border-bottom:2px solid ${brandColor};padding-bottom:6px;">Top 5 AI Investment Picks</h2>
    ${picksHtml}

    <h2 style="color:${brandColor};border-bottom:2px solid ${brandColor};padding-bottom:6px;margin-top:30px;">AI News to Watch</h2>
    ${articlesHtml}
  </div>`;
}

// ----------------------
// MAIN EXECUTION
// ----------------------
(async () => {
  try {
    const now = DateTime.now().setZone("America/Los_Angeles");
    const dateStr = now.toFormat("MMMM d, yyyy");
    const fileDate = now.toFormat("yyyy-MM-dd");

    console.log("📡 Fetching articles...");
    const articles = await fetchFreeArticles();

    console.log("📈 Fetching stock data...");
    const stockData = await fetchStockData();
    const picks = selectTop5(stockData);

    console.log("🧱 Building HTML...");
    const html = buildEmailHtml(dateStr, picks, articles);

    const outPath = path.join("output", `daily-email-${fileDate}.html`);
    fs.mkdirSync("output", { recursive: true });
    fs.writeFileSync(outPath, html);

    console.log("📬 HTML generated:", outPath);

    console.log("📧 Fetching subscriber list...");
    const emails = await getEmailList();
    console.log("Subscriber emails:", emails);

    // Expose for GitHub Actions mail step
    fs.writeFileSync("output/recipients.txt", emails.join(","));

    console.log("✅ Done.");

  } catch (err) {
    console.error("❌ FATAL ERROR in index.js:", err);
    process.exit(1);
  }
})();
