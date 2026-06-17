/**
 * One-time script: analyzes last 6 months of John's sent mail to learn
 * his writing style, tone, sign-offs, and important sender patterns.
 *
 * Run: node scripts/learn-from-history.js
 * Output: data/style-context.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function makeGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://127.0.0.1:8080'
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

function extractPart(payload, mimeType) {
  function search(part) {
    if (part.mimeType === mimeType && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    for (const child of part.parts ?? []) {
      const r = search(child);
      if (r) return r;
    }
    return null;
  }
  return search(payload);
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractBody(payload) {
  const plain = extractPart(payload, 'text/plain');
  if (plain) return plain.slice(0, 800);
  const html = extractPart(payload, 'text/html');
  if (html) return stripHtml(html).slice(0, 800);
  return '';
}

function getHeader(headers, name) {
  return (headers ?? []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function sixMonthsAgoDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchSentEmails(gmail, maxCount = 100) {
  const after = sixMonthsAgoDate();
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: maxCount,
    q: `in:sent after:${after} -subject:"[mortgage bot]" -subject:"[broker assistant]"`
  });

  const messages = listRes.data.messages ?? [];
  console.log(`Fetching ${messages.length} sent emails...`);

  const emails = [];
  for (const msg of messages.slice(0, maxCount)) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload?.headers ?? [];
      const body = extractBody(full.data.payload);
      if (body.length < 20) continue; // skip empty/boilerplate
      emails.push({
        to: getHeader(headers, 'to'),
        subject: getHeader(headers, 'subject'),
        body
      });
    } catch { /* skip */ }
  }

  return emails;
}

async function fetchInboxEmailsFrom(gmail, maxCount = 150) {
  // Also sample received emails to understand who John communicates with
  const after = sixMonthsAgoDate();
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: maxCount,
    q: `in:inbox after:${after} -label:broker-assistant-processed`
  });
  const messages = listRes.data.messages ?? [];
  const senderCounts = {};
  for (const msg of messages.slice(0, maxCount)) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From'] });
      const from = getHeader(full.data.payload?.headers ?? [], 'from');
      const domain = (from.match(/@([a-z0-9.-]+)/i) ?? [])[1] ?? '';
      if (domain && !domain.includes('libertygroupfunding')) {
        senderCounts[from] = (senderCounts[from] ?? 0) + 1;
      }
    } catch { /* skip */ }
  }
  return senderCounts;
}

async function analyzeWithClaude(sentEmails, senderCounts) {
  const emailSamples = sentEmails.slice(0, 40).map((e, i) =>
    `--- Email ${i + 1} ---\nTo: ${e.to}\nSubject: ${e.subject}\n${e.body}`
  ).join('\n\n');

  const topSenders = Object.entries(senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([from, count]) => `${from} (${count} emails)`);

  const prompt = `Analyze these sent emails from John, a mortgage broker at Liberty Group Funding.

SENT EMAILS (${sentEmails.length} total, showing 40 samples):
${emailSamples}

TOP SENDERS TO JOHN (by frequency):
${topSenders.join('\n')}

Based on this analysis, respond with a JSON object (raw JSON only, no markdown):
{
  "tone": "describe John's writing style in 2-3 sentences — formality level, typical length, directness",
  "sampleSignOff": "the most common sign-off John uses",
  "importantSenders": ["list of email addresses or domains that appear frequently and seem important"],
  "ignorePatterns": ["list of subject/sender patterns that are clearly automated or noise — add to defaults, don't replace"],
  "urgentKeywords": ["any domain-specific urgency terms John deals with — add to defaults"],
  "observations": "2-3 sentences about John's email patterns and priorities"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = (response.content[0]?.text ?? '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(raw);
}

async function main() {
  console.log('Learning from email history...');
  const gmail = makeGmailClient();

  const [sentEmails, senderCounts] = await Promise.all([
    fetchSentEmails(gmail, 100),
    fetchInboxEmailsFrom(gmail, 150)
  ]);

  console.log(`Analyzing ${sentEmails.length} sent emails and ${Object.keys(senderCounts).length} unique senders...`);

  const analysis = await analyzeWithClaude(sentEmails, senderCounts);
  analysis.learnedAt = new Date().toISOString();
  analysis.emailsAnalyzed = sentEmails.length;

  const outputPath = path.join(__dirname, '..', 'data', 'style-context.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(analysis, null, 2));

  console.log('\nStyle context saved to data/style-context.json');
  console.log('\nTone:', analysis.tone);
  console.log('Sign-off:', analysis.sampleSignOff);
  console.log('Important senders:', (analysis.importantSenders ?? []).slice(0, 5).join(', '));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
