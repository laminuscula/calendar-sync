import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { runSync } from './sync-core.mjs'; // tu función actual

const app = express();
const PORT = process.env.PORT || 3000;

// Seguridad sencilla: HMAC en query ?hmac=...
function verifyHmac(req) {
  const secret = process.env.HMAC_SECRET || '';
  const hmac = req.query.hmac || '';
  const base = 'sync'; // mensaje fijo
  const calc = crypto.createHmac('sha256', secret).update(base).digest('hex');
  return secret && hmac && hmac === calc;
}

app.get('/sync', async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
  try {
    await runSync();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/', (_req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Server on :${PORT}`));