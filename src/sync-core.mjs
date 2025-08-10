// server/sync-core.mjs (o src/sync-core.mjs si no estás en Remix)
import 'dotenv/config';
import ical from 'node-ical';

const {
  SHOP,
  ADMIN_TOKEN,
  METAOBJECT_TYPE = 'event',
  LOOKAHEAD_DAYS: ENV_LOOKAHEAD = '180',
  GOOGLE_CAL_ICS_URL: ENV_ICS
} = process.env;

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
    throw new Error(JSON.stringify(json.errors || json, null, 2));
  }
  return json.data;
}

// Lee calendar_config ACTIVE (si hay)
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
  const data = await shopifyGql(q);
  const node = data?.metaobjects?.nodes?.[0];
  return {
    ics: node?.ics_url?.value || null,
    lookahead: Number(node?.lookahead_days?.value || ENV_LOOKAHEAD || 180)
  };
}

// … (slugify, buildHandle, toFields, setActive, etc. como ya tienes)

export async function runSync() {
  // 1) Config dinámica
  const cfg = await getCalendarConfig();
  const ICS_URL = cfg.ics || ENV_ICS;
  const LOOKAHEAD_DAYS = cfg.lookahead;

  if (!ICS_URL) throw new Error('No hay ICS_URL (ni en metaobject ni en .env)');

  console.log('→ Usando ICS:', ICS_URL);
  console.log('→ Lookahead días:', LOOKAHEAD_DAYS);

  // 2) Leer y parsear ICS
  const parsed = await ical.async.fromURL(ICS_URL);

  // 3) Resto de tu lógica tal cual:
  //   - expandir recurrencias
  //   - filtrar futuros o en curso
  //   - upsert metaobjects `event` + set ACTIVE
  // (usa tu versión actual con slugify y activación)
}