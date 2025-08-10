import 'dotenv/config';
import ical from 'node-ical';

const {
  SHOP,
  ADMIN_TOKEN,
  GOOGLE_CAL_ICS_URL,
  METAOBJECT_TYPE = 'event',
  LOOKAHEAD_DAYS = '180',
  TIMEZONE = 'Europe/Madrid'
} = process.env;

if (!SHOP || !ADMIN_TOKEN || !GOOGLE_CAL_ICS_URL) {
  console.error('Faltan variables .env (SHOP, ADMIN_TOKEN, GOOGLE_CAL_ICS_URL)');
  process.exit(1);
}

const API_VERSION = '2025-07';

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

const CREATE = `
mutation MetaobjectCreate($handle: String!, $fields: [MetaobjectFieldInput!]!) {
  metaobjectCreate(metaobject: {
    type: "${METAOBJECT_TYPE}",
    handle: $handle,
    fields: $fields
  }) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

const UPDATE = `
mutation MetaobjectUpdate($id: ID!, $fields: [MetaobjectFieldInput!]!) {
  metaobjectUpdate(id: $id, metaobject: { fields: $fields }) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

const GET_BY_HANDLE = `
query MetaobjectByHandle($handle: String!) {
  metaobjectByHandle(handle: {type: "${METAOBJECT_TYPE}", handle: $handle}) {
    id handle
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

const clean = (s) => (s ?? '').toString().trim();
const iso = (d) => d ? new Date(d).toISOString() : null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildHandle(uid, start) {
  const base = `${clean(uid)}-${Math.floor(new Date(start).getTime()/1000)}`
    .toLowerCase()
    .replace(/[^a-z0-9\-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return base || `e-${Date.now()}`;
}

function toFields(ev) {
  const fields = [
    { key: 'uid', value: clean(ev.uid) },
    { key: 'title', value: clean(ev.summary) },
    ev.description ? { key: 'description', value: clean(ev.description) } : null,
    ev.location ? { key: 'location', value: clean(ev.location) } : null,
    ev.url ? { key: 'url', value: clean(ev.url) } : null,
    { key: 'start_date', value: iso(ev.start) },
    ev.end ? { key: 'end_date', value: iso(ev.end) } : null
    // ojo: no mandamos "timezone" porque tu definición no lo tiene
  ].filter(Boolean);
  return fields;
}

async function upsertMetaobject(handle, fields) {
  try {
    const out = await shopifyGql(UPSERT, { handle, fields });
    const errs = out.metaobjectUpsert?.userErrors || [];
    if (errs.length) throw new Error(`Upsert userErrors: ${JSON.stringify(errs)}`);
    return out.metaobjectUpsert?.metaobject?.id;
  } catch (e) {
    const lookup = await shopifyGql(GET_BY_HANDLE, { handle });
    const existing = lookup.metaobjectByHandle;
    if (!existing) {
      const cr = await shopifyGql(CREATE, { handle, fields });
      const errs = cr.metaobjectCreate?.userErrors || [];
      if (errs.length) throw new Error(`Create userErrors: ${JSON.stringify(errs)}`);
      return cr.metaobjectCreate?.metaobject?.id;
    } else {
      const up = await shopifyGql(UPDATE, { id: existing.id, fields });
      const errs = up.metaobjectUpdate?.userErrors || [];
      if (errs.length) throw new Error(`Update userErrors: ${JSON.stringify(errs)}`);
      return up.metaobjectUpdate?.metaobject?.id;
    }
  }
}

async function setActive(id) {
  const out = await shopifyGql(SET_STATUS_ACTIVE, { id, status: "ACTIVE" });
  const errs = out.metaobjectUpdate?.userErrors || [];
  if (errs.length) throw new Error(`Set ACTIVE userErrors: ${JSON.stringify(errs)}`);
}

function isAllDay(ev) {
  const start = ev.start instanceof Date && ev.start.getHours() === 0 && ev.start.getMinutes() === 0;
  const end = ev.end instanceof Date && ev.end.getHours() === 0 && ev.end.getMinutes() === 0;
  return start && end && ((ev.end - ev.start) % 86400000 === 0);
}

async function run() {
  console.log('→ Descargando ICS…');
  const res = await fetch(GOOGLE_CAL_ICS_URL);
  if (!res.ok) throw new Error(`ICS fetch error ${res.status}`);
  const icsText = await res.text();

  console.log('→ Parseando ICS…');
  const parsed = ical.parseICS(icsText);

  const now = new Date();
  const until = new Date(now.getTime() + Number(LOOKAHEAD_DAYS) * 86400000);

  const occurrences = [];

  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (ev.type !== 'VEVENT') continue;
    if (ev.status === 'CANCELLED') continue;

    if (ev.rrule) {
      const iter = ev.rrule.between(now, until, true);
      const exdates = ev.exdate ? Object.values(ev.exdate).map(d => +d) : [];
      for (const dt of iter) {
        if (exdates.includes(+dt)) continue;
        const dur = ev.duration ? ev.duration : (ev.end ? (ev.end - ev.start) : 0);
        const start = new Date(dt);
        const end = dur ? new Date(+start + dur) : null;
        occurrences.push({ ...ev, start, end, recurrenceid: dt });
      }
    } else if (ev.start) {
      occurrences.push(ev);
    }
  }

  const future = occurrences.filter(ev => ev.start >= now && ev.start <= until);
  future.sort((a, b) => a.start - b.start);

  console.log(`→ Encontrados ${future.length} eventos futuros (ventana ${LOOKAHEAD_DAYS} días).`);
  let count = 0;

  for (const ev of future) {
    if (isAllDay(ev)) {
      // all-day ya correcto
    }
    const handle = buildHandle(ev.uid, ev.start);
    const fields = toFields(ev);

    try {
      const id = await upsertMetaobject(handle, fields);
      await setActive(id);
      count++;
      if (count % 5 === 0) console.log(`   · ${count} sincronizados…`);
      await sleep(350);
    } catch (e) {
      console.error(`Error en ${handle}:`, e.message);
      await sleep(1000);
    }
  }

  console.log(`✓ Sincronizados ${count} metaobjects "${METAOBJECT_TYPE}".`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});