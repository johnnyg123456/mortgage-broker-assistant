require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getClient, extractBody, getHeader } = require('../lib/gmail-client');
const { classify } = require('../lib/classifier');
const { handle: createDraft } = require('../lib/draft-handler');
const { load: loadState, save: saveState, pruneProcessed } = require('../lib/state');
const { load: loadStyleCtx } = require('../lib/style-context');
const { runIfDue } = require('../lib/digest-builder');

const DRY_RUN = process.env.DRY_RUN === 'true';
const TIMEZONE = process.env.GMAIL_SCAN_TIMEZONE || 'America/New_York';
const PROCESSED_LABEL = process.env.GMAIL_PROCESSED_LABEL || 'broker-assistant-processed';
const MAX_PER_SCAN = Number(process.env.GMAIL_MAX_MESSAGES_PER_SCAN) || 30;

const labelIdCache = {};

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), module: 'scan', action, ...detail }));
}

function getTodayDate() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return `${parts.year}/${parts.month}/${parts.day}`;
}

async function getProcessedLabelId(gmail) {
  if (labelIdCache[PROCESSED_LABEL]) return labelIdCache[PROCESSED_LABEL];
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels ?? []).find(l => l.name === PROCESSED_LABEL);
  if (existing) {
    labelIdCache[PROCESSED_LABEL] = existing.id;
    return existing.id;
  }
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: PROCESSED_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  labelIdCache[PROCESSED_LABEL] = created.data.id;
  return created.data.id;
}

async function markProcessed(gmail, msgId) {
  const labelId = await getProcessedLabelId(gmail);
  await gmail.users.messages.modify({
    userId: 'me', id: msgId,
    requestBody: { addLabelIds: [labelId] }
  });
}

async function runScan() {
  const gmail = getClient();
  const state = loadState();
  const styleCtx = loadStyleCtx();

  const query = `in:inbox after:${getTodayDate()} -label:${PROCESSED_LABEL}`;
  log('scan-start', { query });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: MAX_PER_SCAN,
    q: query
  });

  const messages = listRes.data.messages ?? [];
  if (!messages.length) {
    log('no-messages', {});
    // Still check if digest is due even when no new mail
    const digestResult = await runIfDue();
    return { scanned: 0, digest: digestResult };
  }

  const processedIds = new Set(state.processedIds ?? []);
  let scanned = 0, ignored = 0, urgent = 0, respond = 0, fyi = 0;
  let ignoredCount = 0;

  for (const msg of messages) {
    if (processedIds.has(msg.id)) {
      log('already-processed', { msgId: msg.id });
      continue;
    }

    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const { payload } = full.data;
      const headers = payload.headers ?? [];

      const subject = getHeader(headers, 'subject');
      const from    = getHeader(headers, 'from');
      const body    = extractBody(payload);
      const email   = {
        messageId: msg.id,
        threadId: full.data.threadId,
        subject,
        from,
        body
      };

      const classification = await classify(email, styleCtx);
      scanned++;

      if (classification.category === 'IGNORE') {
        ignoredCount++;
        log('ignored', { msgId: msg.id, subject, reason: classification.reason });
      } else {
        let draftId = null;
        if (classification.draftNeeded && (classification.category === 'URGENT' || classification.category === 'RESPOND')) {
          draftId = await createDraft(email, classification, styleCtx);
        }

        const item = {
          messageId: msg.id,
          category: classification.category,
          priority: classification.priority,
          summary: classification.summary,
          from,
          subject,
          draftId,
          ts: new Date().toISOString()
        };

        state.pendingItems = state.pendingItems ?? [];
        state.pendingItems.push(item);

        if (classification.category === 'URGENT') urgent++;
        else if (classification.category === 'RESPOND') respond++;
        else fyi++;

        log('queued', { msgId: msg.id, subject, category: classification.category, draftId });
      }

      // Mark processed in Gmail and in local state
      if (!DRY_RUN) await markProcessed(gmail, msg.id);
      processedIds.add(msg.id);

    } catch (err) {
      log('message-error', { msgId: msg.id, error: err.message });
    }
  }

  state.processedIds = [...processedIds];
  state._ignoredCount = (state._ignoredCount ?? 0) + ignoredCount;
  if (state.pendingItems) state.pendingItems._ignoredCount = state._ignoredCount;
  pruneProcessed(state);
  saveState(state);

  log('scan-complete', { scanned, urgent, respond, fyi, ignored: ignoredCount });

  // Attach ignored count to pending items for digest
  if (state.pendingItems) state.pendingItems._ignoredCount = state._ignoredCount;

  const digestResult = await runIfDue();

  return { scanned, urgent, respond, fyi, ignored: ignoredCount, digest: digestResult };
}

module.exports = async (req, res) => {
  const syncScan = req.query?.wait === 'true'
    || process.env.GMAIL_SCAN_SYNC === 'true'
    || process.env.RENDER === 'true';

  if (syncScan) {
    try {
      const result = await runScan();
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), action: 'scan-error', error: err.message }));
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // Background for Vercel
  runScan().catch(err => console.error(err.message));
  return res.status(202).json({ ok: true, message: 'Scan started' });
};
