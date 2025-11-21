const fs = require('fs');
const path = require('path');
const RSSParser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const { DateTime } = require('luxon');
const nlp = require('compromise');

const parser = new RSSParser({ timeout: 15000 });

const FEEDS = [
  'https://www.reuters.com/technology/rss',
  'https://techcrunch.com/feed/',
  'https://venturebeat.com/category/ai/feed/',
  'https://www.theverge.com/rss/index.xml',
  'https://www.wired.com/feed/rss',
  'https://arstechnica.com/feed/'
];

const KEYWORDS = ['AI', 'artificial intelligence', 'machine learning', 'LLM', 'large language model', 'GPT', 'Claude', 'Copilot', 'chatbot', 'neural', 'deep learning'];
const IGNORE_KEYWORDS = ['podcast', 'jobs', 'careers', 'opinion', 'editorial', 'review', 'security vulnerability', 'hacker', 'malware'];

const MAX_ARTICLES_PER_FEED = 10; // Limit articles fetched per feed
const OUTPUT_DIR = path.join(__dirname, 'output');

const SMALL_CAP_RANGE = { min: 50_000_000, max: 2_000_000_000 }; // Market cap in USD
const DESIRED_SMALL_CAP_COUNT = 3;

// --- Helper Functions ---

function matchesKeywords(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  // Check if any main keyword is present
  const hasKeyword = KEYWORDS.some(k => t.includes(k.toLowerCase()));
  if (!hasKeyword) return false;
  // Check if any ignore keyword is present
  const hasIgnore = IGNORE_KEYWORDS.some(k => t.includes(k.toLowerCase()));
  return !hasIgnore;
}

async function fetchRSSItems() {
  const items = [];
  console.log('Fetching RSS feeds...');
  for (const feed of FEEDS) {
    try {
      console.log(`  Fetching ${feed}`);
      const f = await parser.parseURL(feed);
      if (f && f.items) {
        const relevantItems = f.items
          .filter(it => matchesKeywords(it.title) || matchesKeywords(it.contentSnippet || it.content))
          .slice(0, MAX_ARTICLES_PER_FEED);

        for (const it of relevantItems) {
          items.push({
            title: it.title || '',
            link: it.link || it.guid || '',
            pubDate: it.pubDate ? new Date(it.pubDate) : new Date(), // Fallback to now if pubDate is null or invalid
            source: f.title || feed,
            contentSnippet: it.contentSnippet || ''
          });
        }
      }
    } catch (err) {
      console.warn(`  Failed to parse feed ${feed}: ${err.message}`);
    }
  }
  // Sort all collected items by date, newest first
  items.sort((a, b) => (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0));
  console.log(`Fetched ${items.length} relevant RSS items.`);
  return items;
}

async function isLikelyPaywalled(url) {
  try {
    const r = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AI-Investor-Daily-Bot/1.0; +https://github.com/investordaily/ai-investor-daily)' }
    });
    const $ = cheerio.load(r.data);
    const text = $(
      'article p, .post-content p, .entry-content p, .article-body p, p'
    ).map((i, el) => $(el).text()).get().join('\n\n').slice(0, 4000).toLowerCase();

    const paywallHints = [
      'subscribe',
      'sign in to continue',
      'full article is for subscribers',
      'to continue reading',
      'please subscribe',
      'log in to view',
      'become a member',
      'subscription required',
      'metered paywall'
    ];
    if (paywallHints.some(h => text.includes(h))) return true;

    // More specific selectors based on common patterns
    if ($('.paywall, .paywall-module, .subscription-overlay, .meteredContent, .subscription-required, #paywall').length > 0) return true;

    // Check if content seems truncated
    if (text.length < 200 && text.includes('continue reading')) return true;

    return false;
  } catch (err) {
    // console.warn(`Paywall check failed for ${url}: ${err.message}`);
    return true; // Assume paywalled on error
  }
}

async function fetchArticleText(url) {
  try {
    const r = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0' } // Be a polite scraper
    });
    const $ = cheerio.load(r.data);
    // Try common article content selectors
    let paragraphs = $('article p, .post-content p, .entry-content p, .article-body p').map((i, el) => $(el).text()).get();
    if (paragraphs.length < 3) { // If too few paragraphs, fall back to all <p> tags
      paragraphs = $('p').map((i, el) => $(el).text()).get();
    }
    const text = paragraphs.join('\n\n').replace(/\s+/g, ' ').trim();
    // Simple cleaning: remove excessive newlines, trim whitespace
    return text.split('\n').filter(Boolean).join('\n').trim();
  } catch (err) {
    console.warn(`Failed fetchArticleText ${url}: ${err.message}`);
    return '';
  }
}

function firstNWords(text, n) {
  if (!text) return '';
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(' ');
}

async function yahooSearch(query) {
  try {
    // Use the correct Yahoo Finance API endpoint
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`;
    const r = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.data && r.data.quotes) return r.data.quotes;
  } catch (err) {
    // console.warn(`Yahoo search failed for ${query}: ${err.message}`);
  }
  return [];
}

async function fetchQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const r = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.data && r.data.quoteResponse && r.data.quoteResponse.result && r.data.quoteResponse.result[0]) {
      return r.data.quoteResponse.result[0];
    }
  } catch (err) {
    // console.warn(`Yahoo quote fetch failed for ${symbol}: ${err.message}`);
  }
  return null;
}

function formatMoney(num) {
  if (num === null || typeof num === 'undefined' || isNaN(num)) return 'N/A';
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

function formatPercentChange(percent) {
  if (percent === null || typeof percent === 'undefined' || isNaN(percent)) return 'N/A';
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
}

function extractSymbols(text) {
  if (!text) return [];
  const potentialSymbols = new Set();
  const doc = nlp(text);

  // Rule 1: Uppercase words (1-5 letters) possibly followed by Corp, Inc etc.
  doc.match('( #UpperCase | #ProperNoun ){1,2} (Corp | Inc | Ltd | LLC | Co | Group | Tech | AI | ML | Labs)?').forEach(match => {
    const potential = match.text().toUpperCase();
    // Filter based on length and common non-tickers
    if (potential.length >= 1 && potential.length <= 5 && !KEYWORDS.includes(potential.toLowerCase())) {
      potentialSymbols.add(potential);
    }
  });

  // Rule 2: Specific patterns like $XYZ, (XYZ), or just XYZ
  const tickerRegex = /\$?([A-Z]{1,5})\)?\b|\( *([A-Z]{1,5}) *\)/g;
  let match;
  while ((match = tickerRegex.exec(text)) !== null) {
    const symbol = (match[1] || match[2])?.toUpperCase();
    if (symbol && symbol.length > 1 && symbol.length <= 5 && !KEYWORDS.includes(symbol.toLowerCase())) {
      potentialSymbols.add(symbol);
    }
  }

  // Filter out common words missed earlier
  const filteredSymbols = Array.from(potentialSymbols).filter(s => {
    return ![
      'AI',
      'ML',
      'LLM',
      'GPT',
      'COM',
      'NET',
      'ORG',
      'CO',
      'INC',
      'LTD',
      'INC.',
      'LTD.',
      'AI.',
      'ML.'
    ].includes(s) && s.length > 1;
  });

  return filteredSymbols;
}

async function fetchAnalystRatings(symbol) {
  // Placeholder: Replace with actual scraping or API access
  // This mock logic favors symbols starting with AI/ML/GOOG/MSFT
  try {
    await new Promise(resolve => setTimeout(resolve, 150)); // Simulate network latency
    if (symbol.startsWith('AI') || symbol.startsWith('ML') || symbol.startsWith('GEN')) return { buy: 4, hold: 1, sell: 0 };
    if (['GOOG', 'MSFT', 'NVDA', 'AMZN', 'META'].includes(symbol)) return { buy: 3, hold: 2, sell: 0 }; // Larger caps
    if (symbol.startsWith('CL') || symbol.startsWith('OC')) return { buy: 2, hold: 3, sell: 1 }; // Assume mixed for Claude/OpenAI related symbols
    return { buy: 1, hold: 2, sell: 2 }; // Default: Mixed rating
  } catch (err) {
    console.warn(`Ratings fetch failed for ${symbol}: ${err.message}`);
    return { buy: 0, hold: 0, sell: 0 };
  }
}

async function analyzeNewsSentiment(urlOrText) {
  let text = '';
  try {
    if (urlOrText.startsWith('http')) {
      // Fetch text from Yahoo News URL
      const r = await axios.get(urlOrText, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const $ = cheerio.load(r.data);
      // Try to find main article content, fallback to paragraphs
      let contentSelector = 'article p, .caas-body p, .story-content p';
      text = $(contentSelector).map((i, el) => $(el).text()).get().join('\n\n');
      if (text.length < 100) { // If too short, try general paragraphs
        text = $('p').map((i, el) => $(el).text()).get().join('\n\n');
      }
    } else {
      text = urlOrText; // Use provided text directly
    }

    if (!text) return 0;
    text = text.toLowerCase().slice(0, 7000); // Limit analysis scope

    const doc = nlp(text);
    const positiveWords = ['buy', 'strong', 'growth', 'innovative', 'outperform', 'leader', 'success', 'upgrade', 'new tech', 'launch', 'profitable', 'expand', 'advance', 'boost', 'significant', 'breakthrough', 'optimistic'];
    const negativeWords = ['sell', 'weak', 'decline', 'warning', 'miss', 'struggle', 'downgrade', 'delay', 'problem', 'concern', 'halt', 'reduce', 'cut', 'challenging', 'risk', 'volatile', 'uncertainty', 'unprofitable'];

    let score = 0;
    positiveWords.forEach(w => score += (text.match(new RegExp(w, 'g')) || []).length);
    negativeWords.forEach(w => score -= (text.match(new RegExp(w, 'g')) || []).length);

    // Normalize score by sentence count for better consistency
    const sentences = doc.sentences().length;
    return sentences > 0 ? score / sentences : 0;

  } catch (err) {
    console.warn(`Sentiment analysis failed for ${urlOrText}: ${err.message}`);
    return 0;
  }
}

async function rankStocks(candidates) {
  const ranked = [];
  const fetchedQuotes = new Map(); // Cache quotes to avoid repeated calls

  console.log(`Ranking ${candidates.length} candidates...`);
  for (const candidate of candidates) {
    try {
      // Fetch or retrieve quote from cache
      let quote = fetchedQuotes.get(candidate.symbol);
      if (!quote) {
        quote = await fetchQuote(candidate.symbol);
        if (quote) fetchedQuotes.set(candidate.symbol, quote);
      }
      if (!quote || !quote.regularMarketPrice) continue;

      // Check criteria: Small Cap & AI Related
      const isSmallCap = quote.marketCap >= SMALL_CAP_RANGE.min && quote.marketCap <= SMALL_CAP_RANGE.max;
      const isAiRelated = KEYWORDS.some(k => candidate.title.toLowerCase().includes(k) || (candidate.articleText || '').toLowerCase().includes(k));

      // Skip if not small cap AND not AI related (adjust logic if needed)
      if (!isSmallCap && !isAiRelated) continue;

      // Fetch Ratings & Sentiment
      const ratings = await fetchAnalystRatings(candidate.symbol);
      const newsUrl = `https://finance.yahoo.com/quote/${candidate.symbol}/news`;
      // Prefer Yahoo News sentiment, fallback to article sentiment if available
      let sentiment = await analyzeNewsSentiment(newsUrl);
      if ((sentiment === 0 || sentiment === undefined) && candidate.articleText) {
          sentiment = await analyzeNewsSentiment(candidate.articleText);
      }

      // Calculate Score (weights are adjustable)
      let score = 0;
      if (isSmallCap) score += 40; // Higher weight for small caps
      if (isAiRelated) score += 20; // Weight for AI relevance
      score += (ratings.buy * 15) + (ratings.hold * 3); // Favor buy ratings
      score += sentiment * 25; // Favor positive sentiment
      score += (quote.regularMarketChangePercent || 0) * 4; // Boost recent positive movers

      ranked.push({
        ...candidate,
        quote,
        ratings,
        sentiment,
        score,
        isSmallCap,
        isAiRelated
      });

    } catch (err) {
      console.warn(`Failed to rank stock ${candidate.symbol}: ${err.message}`);
    }
  }

  // Sort: Score (desc) -> Buy Ratings (desc) -> Positive Change (desc)
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.ratings.buy !== a.ratings.buy) return b.ratings.buy - a.ratings.buy;
    return (b.quote.regularMarketChangePercent || 0) - (a.quote.regularMarketChangePercent || 0);
  });

  // Select top N: Mix of small caps and other strong candidates
  const topSmallCaps = ranked.filter(s => s.isSmallCap && s.isAiRelated).slice(0, DESIRED_SMALL_CAP_COUNT);
  const otherCandidates = ranked.filter(s => !s.isSmallCap || !s.isAiRelated);
  const topOthers = otherCandidates.slice(0, 5 - topSmallCaps.length);

  return [...topSmallCaps, ...topOthers].slice(0, 5); // Final top 5
}

// --- HTML Generation ---

function generateNewsletterHTML(relevantArticles, topPicks) {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Investor Daily - ${DateTime.now().toFormat('LLLL d, yyyy')}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #f4f7f6; }
    .container { max-width: 700px; margin: 20px auto; background-color: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
    h1 { color: #2c3e50; font-size: 2.2em; margin-bottom: 0.5em; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
    h2 { color: #2c3e50; font-size: 1.6em; margin-top: 1.5em; margin-bottom: 0.8em; }
    h3 { color: #34495e; font-size: 1.3em; margin-bottom: 0.4em; }
    a { color: #3498db; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .stock-card {
      margin-top: 15px;
      padding: 15px;
      background-color: #ecf0f1;
      border-radius: 8px;
      border-left: 5px solid #3498db;
      transition: all 0.3s ease;
    }
    .stock-card:hover { background-color: #e0e8ea; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .stock-card h3 { margin-top: 0; margin-bottom: 8px; }
    .stock-card p { margin: 5px 0; }
    .price-info { font-size: 1.1em; font-weight: bold; }
    .positive { color: #27ae60; }
    .negative { color: #e74c3c; }
    .neutral { color: #95a5a6; }
    .buttons-container a {
      display: inline-block;
      margin-right: 12px;
      padding: 8px 16px;
      background-color: #2980b9;
      color: white;
      text-decoration: none;
      border-radius: 5px;
      font-weight: bold;
      font-size: 0.9em;
      transition: background-color 0.3s ease;
    }
    .buttons-container a:hover { background-color: #3498db; }
    .meta-info { font-size: 0.85em; color: #7f8c8d; margin-top: 10px; }
    .article-summary { margin-top: 10px; color: #555; font-size: 0.95em; }
    .footer { text-align: center; margin-top: 40px; font-size: 0.8em; color: #95a5a6; }
  </style>
</head>
<body>
  <div class="container">
    <h1>AI Investor Daily</h1>
    <p class="meta-info">${DateTime.now().toFormat('LLLL d, yyyy')}</p>

    ${topPicks.length > 0 ? `
    <h2>📈 Today's Top 5 AI Investment Picks</h2>
    ${topPicks.map(stock => {
      if (!stock.quote) return ''; // Skip if no quote available

      const symbol = stock.quote.symbol;
      const shortName = stock.quote.shortName;
      const price = formatMoney(stock.quote.regularMarketPrice);
      const change = stock.quote.regularMarketChange;
      const changePercent = stock.quote.regularMarketChangePercent;
      const isPositive = change >= 0;
      const changeClass = isPositive ? 'positive' : 'negative';

      // LINK UPDATED to Yahoo News Topic page
      const newsUrl = `https://finance.yahoo.com/news/topic/${symbol}`;
      const newsButton = `<a href="${newsUrl}" target="_blank">View News</a>`;

      const ratingText = stock.ratings ? `(${stock.ratings.buy} Buy, ${stock.ratings.hold} Hold, ${stock.ratings.sell} Sell)` : '';
      const sentimentScore = stock.sentiment !== undefined ? parseFloat(stock.sentiment.toFixed(1)) : undefined;
      let sentimentClass = 'neutral';
      if (sentimentScore > 0.2) sentimentClass = 'positive';
      else if (sentimentScore < -0.2) sentimentClass = 'negative';
      const sentimentText = sentimentScore !== undefined ? `(Sentiment: <span class="${sentimentClass}">${sentimentScore > 0 ? '+' : ''}${sentimentScore}</span>)` : '';

      return `
        <div class="stock-card">
          <h3>${symbol} (${shortName})</h3>
          <p class="price-info">
            Price: $${price} <span class="${changeClass}">
              ${isPositive ? '+' : ''}${formatMoney(change)} (${formatPercentChange(changePercent)})
            </span>
          </p>
          <p class="article-summary">${stock.summary || 'No summary available.'}</p>
          <div class="buttons-container">
            ${newsButton}
            <span class="meta-info">${ratingText} ${sentimentText}</span>
          </div>
        </div>
      `;
    }).join('')}
    ` : ''} {/* End of topPicks section */}

    {/* --- Other Relevant Articles --- */}
    {relevantArticles.length > 0 && (
      html += `<h2>Latest AI & Tech News</h2>`
    )}
    {relevantArticles.slice(0, 8).map(article => {
      const formattedDate = article.pubDate ? DateTime.fromJSDate(article.pubDate).toFormat('LLL d, yyyy') : '';
      const source = article.source ? ` from ${article.source}` : '';
      return `
        <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #eee;">
          <h3><a href="${article.link}" target="_blank">${article.title}</a></h3>
          <p class="meta-info">${formattedDate}${source}</p>
          <p class="article-summary">${article.summary}</p>
        </div>
      `;
    }).join('')}

    <div class="footer">
      <p>AI Investor Daily - Curated AI & Tech Insights</p>
      <p>Market data from Yahoo Finance. Ratings and sentiment are informational.</p>
      <p>No financial advice. DYOR.</p>
    </div>
  </div>
</body>
</html>`;

  return html;
}

// --- Main Execution Logic ---

async function main() {
  console.log('Starting AI Investor Daily Newsletter Generation...');

  // Clean output directory
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR);

  const items = await fetchRSSItems();
  const candidates = [];
  const relevantArticles = []; // For articles without clear stock picks

  console.log(`Processing ${items.length} items to find candidates and articles...`);
  for (const item of items) {
    if (!item.link) continue;

    const combinedText = (item.title || '') + ' ' + (item.contentSnippet || ''); // Prioritize snippet for quick matching
    if (!matchesKeywords(combinedText)) continue;

    try {
      const isPaywalled = await isLikelyPaywalled(item.link);
      if (isPaywalled) {
        console.log(`  Skipping paywalled: ${item.title.substring(0, 50)}...`);
        continue;
      }

      const articleText = await fetchArticleText(item.link);
      if (!articleText) {
        console.log(`  Skipping (no text): ${item.title.substring(0, 50)}...`);
        continue;
      }

      const summary = firstNWords(articleText, 70) + '...';
      const symbols = extractSymbols(item.title + ' ' + articleText);

      if (symbols.length > 0) {
        for (const symbol of symbols) {
          candidates.push({
            symbol,
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            source: item.source,
            summary,
            articleText // Pass full text for potential sentiment analysis
          });
        }
      } else {
        // Add non-stock related articles too
        relevantArticles.push({ ...item, summary });
      }
    } catch (err) {
      console.warn(`  Error processing item ${item.link}: ${err.message}`);
    }
  }

  console.log(`Found ${candidates.length} potential stock candidates related to AI.`);
  console.log(`Found ${relevantArticles.length} other relevant AI/tech articles.`);

  // Rank candidates and select top picks
  const topPicks = await rankStocks(candidates);

  // Ensure quotes are available for formatting in generateNewsletterHTML
  for (const pick of topPicks) {
    if (!pick.quote) {
      pick.quote = await fetchQuote(pick.symbol);
    }
  }
  const validTopPicks = topPicks.filter(p => p.quote && p.quote.regularMarketPrice);

  console.log(`Top AI Picks Selected (${validTopPicks.length}): ${validTopPicks.map(p => `${p.symbol} (${p.score.toFixed(0)})`).join(', ')}`);

  // Generate HTML
  const htmlContent = generateNewsletterHTML(relevantArticles, validTopPicks);

  // Save to file
  const filename = `newsletter_${DateTime.now().toFormat('yyyy-MM-dd')}.html`;
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, htmlContent);
  console.log(`Newsletter saved successfully to: ${filepath}`);
}

// --- Run the main function ---
main().catch(err => {
  console.error('❌ Newsletter generation failed:', err);
  process.exit(1);
});
