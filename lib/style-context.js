const fs = require('fs');
const path = require('path');

const CONTEXT_FILE = path.join(__dirname, '..', 'data', 'style-context.json');

const FALLBACK = {
  tone: 'Professional and direct. Keep responses concise. Sign off as John.',
  importantSenders: [],
  ignorePatterns: [
    'lock confirmation', 'lock update', 'rate lock', 'change of circumstance',
    'coc notice', 'missing items for loan submission', 'recall:',
    'noreply', 'no-reply', 'donotreply', 'notifications@'
  ],
  urgentKeywords: [
    'urgent', 'asap', 'today', 'by eod', 'end of day', 'time sensitive',
    'expires', 'expiring', 'expired', 'suspended', 'denied', 'declined',
    'closing tomorrow', 'closing today', 'clear to close', 'ctc'
  ],
  sampleSignOff: 'Thanks,\nJohn',
  learnedAt: null
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
    return { ...FALLBACK, ...raw };
  } catch {
    return FALLBACK;
  }
}

function buildSystemPrompt(ctx) {
  return `You are an email assistant for John, a mortgage broker at Liberty Group Funding.

JOHN'S WRITING STYLE:
${ctx.tone}

SAMPLE SIGN-OFF:
${ctx.sampleSignOff}

IMPORTANT SENDERS (respond quickly, treat as high priority):
${ctx.importantSenders.length ? ctx.importantSenders.join(', ') : 'None learned yet'}

IGNORE THESE PATTERNS (do not flag or draft for):
${ctx.ignorePatterns.join(', ')}

URGENT SIGNALS (escalate immediately):
${ctx.urgentKeywords.join(', ')}

Always match John's tone. Keep drafts professional, warm, and brief. Do not add filler phrases.`;
}

module.exports = { load, buildSystemPrompt };
