import 'dotenv/config';
import ical from 'node-ical';
import fetch from 'node-fetch';

const shopifyEndpoint = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`;
const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;
const META_TYPE = 'event';

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(shopifyEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Access-Token': shopifyToken, 'X-Shopify-Access-Token': shopifyToken },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(json.errors || json, null, 2));
    throw new Error('Shopify GraphQL error');
  }
  return json.data;
}

function toHandle(str) {
  return (str || 'evento')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function getCalendarConfig() {
  const byId = process.env.CALENDAR_CONFIG_ID
    ? await shopifyGraphQL(
        `
        query Config($id: ID!) {
          metaobject(id: $id) {
            ics_url: field(key: "ics_url") { value }
            lookahead_days: field(key: "lookahead_days") { value }
          }
        }`,
        { id: `gid://shopify/Metaobject/${process.env.CALENDAR_CONFIG_ID}` }
      ).catch(() => null)
    : null;

  const icsFromId = byId?.metaobject?.ics_url?.value || null;
  const lookaheadFromId = byId?.metaobject?.lookahead_days?.value || null;

  let byType = null;
  if (!icsFromId) {
    byType = await shopifyGraphQL(`
      query {
        metaobjects(type: "calendar_config", first: 1, query: "status:active") {
          nodes {
            ics_url: field(key: "ics_url") { value }
            lookahead_days: field(key: "lookahead_days") { value }
          }
        }
      }
    `).catch(() => null);
  }

  const icsFromType = byType?.metaobjects?.nodes?.[0]?.ics_url?.value || null;
  const lookaheadFromType = byType?.metaobjects?.nodes?.[0]?.lookahead_days?.value || null;

  const ics = icsFromId || icsFromType || process.env.ICS_URL || null;
  const lookahead = Number(lookaheadFromId || lookaheadFromType || process.env.LOOKAHEAD_DAYS || 180);

  return { ics, lookahead };
}

const MUT_CREATE = `
mutation Create($handle:String!, $fields:[MetaobjectFieldInput!]!) {
  metaobjectCreate(metaobject:{
    type:"${META_TYPE}",
    handle:$handle,
    fields:$fields,
    capabilities:{ publishable:{ status: ACTIVE } }
  }) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

const MUT_UPDATE = `
mutation Update($id:ID!, $fields:[MetaobjectFieldInput!]!) {
  metaobjectUpdate(id:$id, metaobject:{
    fields:$fields,
    capabilities:{ publishable:{ status: ACTIVE } }
  }) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;

const MUT_DELETE = `
mutation Del($id:ID!) {
  metaobjectDelete(id:$id) {
    deletedId
    userErrors { field message code }
  }
}`;

export async function runSync() {
  console.log('Iniciando sincronización');

  const cfg = await getCalendarConfig();
  if (!cfg.ics) throw new Error('ICS_URL no configurado (calendar_config o env)');
  console.log('Config ICS:', cfg.ics);
  console.log('Lookahead días:', cfg.lookahead);

  const current = await shopifyGraphQL(`
    { metaobjects(type:"${META_TYPE}", first:250) { edges { node { id handle } } } }
  `);
  const currentNodes = current.metaobjects.edges.map(e => e.node);
  const currentMap = new Map(currentNodes.map(n => [n.handle, n.id]));
  console.log('Eventos actuales en Shopify:', currentNodes.length);

  const icsUrl = cfg.ics + (cfg.ics.includes('?') ? '&' : '?') + 't=' + Date.now();
  console.log('Descargando feed ICS');
  const parsed = await ical.async.fromURL(icsUrl);

  const now = new Date();
  const futureLimit = new Date(now.getTime() + cfg.lookahead * 24 * 60 * 60 * 1000);

  const vevents = Object.values(parsed)
    .filter(ev => ev && ev.type === 'VEVENT')
    .filter(ev => ev.start && ev.start >= now && ev.start <= futureLimit);

  console.log('Eventos en el feed ICS tras filtro:', vevents.length);

  const occ = vevents.map(ev => {
    const base = ev.uid ? String(ev.uid) : (ev.summary || 'evento');
    const handle = toHandle(base);
    return {
      handle,
      title: ev.summary || '',
      location: ev.location || '',
      description: ev.description || '',
      start_iso: ev.start ? new Date(ev.start).toISOString() : null,
      end_iso: ev.end ? new Date(ev.end).toISOString() : null
    };
  }).filter(e => e.handle && e.start_iso);

  const newHandles = occ.map(e => e.handle);
  console.log('Eventos a procesar:', occ.length);

  for (const ev of occ) {
    const fields = [
      { key: 'title', value: ev.title || '' },
      { key: 'location', value: ev.location || '' },
      { key: 'description', value: ev.description || '' },
      { key: 'start_date', value: ev.start_iso }
    ];
    if (ev.end_iso) fields.push({ key: 'end_date', value: ev.end_iso });

    const existingId = currentMap.get(ev.handle);
    if (existingId) {
      const out = await shopifyGraphQL(MUT_UPDATE, { id: existingId, fields });
      const errs = out?.metaobjectUpdate?.userErrors || [];
      if (errs.length) throw new Error('userErrors update: ' + JSON.stringify(errs));
    } else {
      const out = await shopifyGraphQL(MUT_CREATE, { handle: ev.handle, fields });
      const errs = out?.metaobjectCreate?.userErrors || [];
      if (errs.length) throw new Error('userErrors create: ' + JSON.stringify(errs));
    }
  }

  const toDelete = currentNodes.filter(n => !newHandles.includes(n.handle));
  console.log('Eventos a borrar:', toDelete.length);
  for (const n of toDelete) {
    const out = await shopifyGraphQL(MUT_DELETE, { id: n.id });
    const errs = out?.metaobjectDelete?.userErrors || [];
    if (errs.length) throw new Error('userErrors delete: ' + JSON.stringify(errs));
  }

  console.log('Sincronización completada');
}