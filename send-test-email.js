const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Get email file from output directory
const outputDir = path.join(__dirname, 'output');
const files = fs.readdirSync(outputDir);
const htmlFile = files.find(f => f.startsWith('daily-email') && f.endsWith('.html'));

if (!htmlFile) {
  console.error('No email HTML file found!');
  process.exit(1);
}

const htmlContent = fs.readFileSync(path.join(outputDir, htmlFile), 'utf8');

const senderEmail = process.env.GMAIL_USER || 'jobhunterapplication@gmail.com';
const gmailPass = process.env.GMAIL_PASS || 'oqlj sfyc rekf ttqz';
const testEmail = process.env.TEST_EMAIL || 'jobhunterapplication@gmail.com';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: senderEmail,
    pass: gmailPass,
  },
});

const mailOptions = {
  from: senderEmail,
  to: testEmail,
  subject: '⚡ AI Investor Daily Newsletter',
  html: htmlContent,
  text: 'Please view this email in HTML format.',
  mimeMultipart: 'mixed',
};

transporter.sendMail(mailOptions, (err, info) => {
  if (err) {
    console.error('Error sending email:', err);
    process.exit(1);
  } else {
    console.log('✅ Email sent successfully!');
    console.log('📧 Test email sent to:', testEmail);
    process.exit(0);
  }
});
