import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { runSync } from './sync-core.mjs'; // tu función actual

const app = express();
const PORT = process.env.PORT || 3000;

let running = false;

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

app.get('/sync', (req, res) => {
  if (!verifyHmac(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
  const quiet = req.query.quiet === '1';

  // Responder inmediatamente para evitar timeouts en cron-job.org
  if (quiet) {
    res.status(200).send('OK');
  } else {
    res.json({ ok: true, started: true });
  }

  // Evitar solapes: si ya hay una sync en marcha, no lanzamos otra
  if (running) return;
  running = true;

  // Ejecutar la sincronización en segundo plano (no bloquea la respuesta)
  Promise.resolve()
    .then(() => runSync())
    .catch((e) => console.error('runSync error:', e))
    .finally(() => { running = false; });
});

// Endpoint de diagnóstico temporal para confirmar el HMAC calculado por el servidor
app.get('/_hmac', (_req, res) => {
  const secret = getSecret();
  const calc = secret ? crypto.createHmac('sha256', secret).update('sync').digest('hex') : null;
  res.json({ hasSecret: !!secret, secretLen: secret.length || 0, calc });
});

app.get('/', (_req, res) => res.send('OK'));
app.listen(PORT, () => console.log(`Server on :${PORT}`));