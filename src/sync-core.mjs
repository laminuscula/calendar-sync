// src/sync-core.mjs
import 'dotenv/config';
import ical from 'node-ical';

/**
 * ENV esperadas
 * SHOP=tu-tienda.myshopify.com
 * ADMIN_TOKEN=shpat_xxx (Custom App Admin API)
 * METAOBJECT_TYPE=event
 * LOOKAHEAD_DAYS=180
 * (opcional) GOOGLE_CAL_ICS_URL=...
 */
const {
  SHOP,
  ADMIN_TOKEN,
  METAOBJECT_TYPE = 'event',
  LOOKAHEAD_DAYS: ENV_LOOKAHEAD = '180',
  GOOGLE_CAL_ICS_URL: ENV_ICS
} = process.env;

if (!SHOP || !ADMIN_TOKEN) {
  console.error('❌ Faltan SHOP o ADMIN_TOKEN en .env / Render env vars');
  process.exit(1);
}

const API_VERSION = '2025-07';

// ---------------------- Shopify GraphQL helper ----------------------
async function shopifyGql(query, variables = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const msg = JSON.stringify(json.errors || json, null, 2);
    throw new Error(`GraphQL error: ${msg}`);
  }
  return json.data;
}

// Lee configuración dinámica (metaobjeto calendar_config en ACTIVE) si existe
async function getCalendarConfig() {
  const q = `
    query Config {
      metaobjects(type:"calendar_config", first: 1, query:"status:active") {
        nodes {
          id
          ics_url: field(key:"ics_url"){ value }
          lookahead_days: field(key:"lookahead_days"){ value }
        }
      }
    }
  `;
  try {
    const data = await shopifyGql(q);
    const node = data?.metaobjects?.nodes?.[0];
    return {
      ics: node?.ics_url?.value || null,
      lookahead: Number(node?.lookahead_days?.value || ENV_LOOKAHEAD || 180)
    };
  } catch {
    // Si no existe la definición, seguimos con ENV
    return { ics: ENV_ICS || null, lookahead: Number(ENV_LOOKAHEAD || 180) };
  }
}

const UPSERT = `
mutation MetaobjectUpsert($handle: String!, $fields: [MetaobjectFieldInput!]!) {
  metaobjectUpsert(
    handle: { type: "${METAOBJECT_TYPE}", handle: $handle }
    metaobject: { fields: $fields }
  ) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

const SET_STATUS_ACTIVE = `
mutation SetMetaobjectStatus($id: ID!, $status: MetaobjectStatus!) {
  metaobjectUpdate(id: $id, metaobject: {
    capabilities: { publishable: { status: $status } }
  }) {
    metaobject { id }
    userErrors { field message code }
  }
}`;

// ---------------------- Utils ----------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => (s ?? '').toString().trim();
const iso = (d) => (d ? new Date(d).toISOString() : null);

function slugify(str) {
  return (str ?? '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function buildHandle(uid, start) {
  const base = slugify(uid) || 'e';
  const ts = Math.floor(new Date(start).getTime() / 1000);
  return `${base}-${ts}`;
}

function toFields(ev) {
  return [
    { key: 'uid',        value: clean(ev.uid) },
    { key: 'title',      value: clean(ev.summary) },
    ev.description ? { key: 'description', value: clean(ev.description) } : null,
    ev.location   ? { key: 'location',   value: clean(ev.location) }   : null,
    ev.url        ? { key: 'url',        value: clean(ev.url) }        : null,
    { key: 'start_date', value: iso(ev.start) },
    ev.end ? { key: 'end_date', value: iso(ev.end) } : null
  ].filter(Boolean);
}

async function upsertMetaobject(handle, fields) {
  const out = await shopifyGql(UPSERT, { handle, fields });
  const errs = out?.metaobjectUpsert?.userErrors || [];
  if (errs.length) throw new Error(`Upsert userErrors: ${JSON.stringify(errs)}`);
  return out.metaobjectUpsert.metaobject.id;
}

async function setActive(id) {
  const out = await shopifyGql(SET_STATUS_ACTIVE, { id, status: 'ACTIVE' });
  const errs = out?.metaobjectUpdate?.userErrors || [];
  if (errs.length) throw new Error(`Set ACTIVE userErrors: ${JSON.stringify(errs)}`);
}

function isAllDay(ev) {
  const s = ev.start instanceof Date && ev.start.getHours() === 0 && ev.start.getMinutes() === 0;
  const e = ev.end   instanceof Date && ev.end   .getHours() === 0 && ev.end   .getMinutes() === 0;
  return s && e && ((ev.end - ev.start) % 86400000 === 0);
}

// ---------------------- MAIN SYNC ----------------------
export async function runSync() {
  // 0) Config
  const cfg = await getCalendarConfig();
  const LOOKAHEAD_DAYS = Number(cfg.lookahead || 180);
  const ICS_URL = cfg.ics || ENV_ICS;

  console.log('🏬 Tienda destino:', SHOP);
  if (!ICS_URL) throw new Error('No hay ICS_URL (ni en metaobject calendar_config ni en env)');

  // 1) Descargar y parsear ICS (con cache-buster)
  console.log('→ Usando ICS:', ICS_URL);
  console.log('→ Lookahead días:', LOOKAHEAD_DAYS);
  const icsUrl = ICS_URL + (ICS_URL.includes('?') ? '&' : '?') + 't=' + Date.now();

  let parsed;
  try {
    parsed = await ical.async.fromURL(icsUrl);
  } catch (e) {
    throw new Error(`No se pudo descargar/parsear el ICS: ${e.message}`);
  }

  const vevents = Object.values(parsed).filter(e => e?.type === 'VEVENT');
  console.log('📄 Eventos en ICS:', vevents.length);

  // 2) Expandir RRULE a ocurrencias (respeta EXDATE)
  const now = new Date();
  const until = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000);

  const occ = []; // <- aseguramos que existe ANTES de log
  for (const ev of vevents) {
    if (ev.status === 'CANCELLED') continue;

    if (ev.rrule) {
      const iter = ev.rrule.between(now, until, true);
      const exdates = ev.exdate ? Object.values(ev.exdate).map(d => +d) : [];
      for (const dt of iter) {
        if (exdates.includes(+dt)) continue;
        const dur = ev.duration ? ev.duration : (ev.end ? (ev.end - ev.start) : 0);
        const start = new Date(dt);
        const end   = dur ? new Date(+start + dur) : null;
        occ.push({ ...ev, start, end, recurrenceid: dt });
      }
    } else if (ev.start) {
      occ.push(ev);
    }
  }
  console.log('🧮 Ocurrencias después de RRULE:', occ.length);

  // 3) Filtrar: futuros o EN CURSO dentro de ventana
  const list = occ.filter(ev => {
    const hasEnd = !!ev.end;
    const inWindow = ev.start <= until;
    const inFutureOrOngoing = (hasEnd && ev.end >= now) || (!hasEnd && ev.start >= now);
    return inWindow && inFutureOrOngoing;
  }).sort((a, b) => a.start - b.start);

  console.log('🎯 Eventos en ventana:', list.length);
  list.slice(0, 10).forEach(ev => {
    // muestra hasta 10 para no spamear logs
    const s = ev.start ? ev.start.toISOString() : 'NA';
    const e = ev.end ? ev.end.toISOString() : 'NA';
    console.log(`   • ${clean(ev.summary)} (${s} → ${e})${isAllDay(ev) ? ' [ALL DAY]' : ''}`);
  });

  // 4) Upsert + activar
  let count = 0;
  for (const ev of list) {
    try {
      const uid = clean(ev.uid) || clean(ev.summary) || `event-${Date.now()}`;
      const handle = buildHandle(uid, ev.start);
      const fields = toFields(ev);

      const id = await upsertMetaobject(handle, fields);
      await setActive(id);

      count++;
      if (count % 5 === 0) console.log(`   · ${count} sincronizados…`);
      await sleep(300); // throttle
    } catch (e) {
      console.error(`⚠️ Error en "${clean(ev.summary) || ev.uid}": ${e.message}`);
      await sleep(800);
    }
  }

  console.log(`✓ Sync OK: ${count} eventos`);
}