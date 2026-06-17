require('dotenv').config();
const { google } = require('googleapis');

let _client = null;

function getClient() {
  if (_client) return _client;
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://127.0.0.1:8080'
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  _client = google.gmail({ version: 'v1', auth });
  return _client;
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
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBody(payload) {
  const plain = extractPart(payload, 'text/plain');
  if (plain) return plain;
  const html = extractPart(payload, 'text/html');
  if (html) return stripHtml(html);
  return '';
}

function getHeader(headers, name) {
  return (headers ?? []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function encodeMimeHeader(value) {
  const text = (value ?? '').toString();
  if (!text || /^[\x00-\x7F]*$/.test(text)) return text;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildRawMessage({ from, to, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit'
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }
  lines.push('', body);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

module.exports = { getClient, extractBody, getHeader, buildRawMessage };
