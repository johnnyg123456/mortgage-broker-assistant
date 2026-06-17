require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Mortgage Broker Assistant',
    version: '1.0.0',
    runtime: process.env.RENDER ? 'render' : 'local',
    dryRun: process.env.DRY_RUN === 'true',
    digestHours: process.env.DIGEST_HOURS || '8,12,16',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /api/scan         — poll Gmail, classify, create drafts',
      'GET /api/digest       — send digest if scheduled hour',
      'GET /api/digest?force=true — send digest now'
    ]
  });
});

app.get('/api/scan', (req, res) => {
  const handler = require('./api/scan');
  handler(req, res);
});

app.get('/api/digest', (req, res) => {
  const handler = require('./api/digest');
  handler(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Broker Assistant running on http://localhost:${PORT}`);
});
