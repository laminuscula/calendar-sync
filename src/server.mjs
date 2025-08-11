import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { runSync } from './sync-core.mjs'; // tu función actual

const app = express();
const PORT = process.env.PORT || 3000;

// Utiliza SYNC_SECRET por defecto; admite HMAC_SECRET por compatibilidad
function getSecret() {
  return process.env.SYNC_SECRET || process.env.HMAC_SECRET || '';
}

// Verificación HMAC opcional: si no hay secreto, no exige hmac
function verifyHmac(req) {
  const secret = getSecret();
  if (!secret) return true;
  const fromQuery = (req.query.hmac || '').toString().trim().toLowerCase();
  const calc = crypto.createHmac('sha256', secret).update('sync').digest('hex');
  return fromQuery && fromQuery === calc;
}

app.get('/sync', async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
  const quiet = req.query.quiet === '1';

  try {
    await runSync();
    if (quiet) return res.status(204).end(); // sin cuerpo para cron-job.org
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (quiet) return res.status(500).end();
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// Endpoint de diagnóstico temporal para confirmar el HMAC calculado por el servidor
app.get('/_hmac', (_req, res) => {
  const secret = getSecret();
  const calc = secret ? crypto.createHmac('sha256', secret).update('sync').digest('hex') : null;
  res.json({ hasSecret: !!secret, secretLen: secret.length || 0, calc });
});

app.get('/', (_req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Server on :${PORT}`));