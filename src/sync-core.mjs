// src/sync-core.mjs
import 'dotenv/config';
import ical from 'node-ical';

const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2024-07';
const META_TYPE = 'event';

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(json.errors || json, null, 2));
    throw new Error('Shopify GraphQL error');
  }
  return json.data;
}

async function getCalendarConfig() {
  const q = `
    query Config {
      metaobjects(type:"calendar_config", first:1, query:"status:active") {
        nodes {
          ics_url: field(key:"ics_url"){ value }
          lookahead_days: field(key:"lookahead_days"){ value }
        }
      }
    }`;
  try {
    const data = await shopifyGraphQL(q);
    const node = data?.metaobjects?.nodes?.[0];
    return {
      ics: node?.ics_url?.value || process.env.ICS_URL || null,
      lookahead: Number(node?.lookahead_days?.value || process.env.LOOKAHEAD_DAYS || 180)
    };
  } catch {
    return { ics: process.env.ICS_URL || null, lookahead: Number(process.env.LOOKAHEAD_DAYS || 180) };
  }
}

const MUT_CREATE = `
mutation Create($handle:String!, $fields:[MetaobjectFieldInput!]!) {
  metaobjectCreate(metaobject:{ type:"${META_TYPE}", handle:$handle, fields:$fields }) {
    metaobject{ id handle }
    userErrors{ field message code }
  }
}`;

const MUT_UPDATE = `
mutation Update($id:ID!, $fields:[MetaobjectFieldInput!]!) {
  metaobjectUpdate(id:$id, metaobject:{ fields:$fields }) {
    metaobject{ id handle }
    userErrors{ field message code }
  }
}`;

const MUT_DELETE = `
mutation Del($id:ID!) {
  metaobjectDelete(id:$id) {
    deletedId
    userErrors{ field message code }
  }
}`;

export async function runSync() {
  console.log('Iniciando sincronización');

  const cfg = await getCalendarConfig();
  if (!cfg.ics) throw new Error('ICS_URL no está configurado (metaobjeto calendar_config o env)');
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
  const vevents = Object.values(parsed).filter(ev => ev && ev.type === 'VEVENT');
  console.log('Eventos en el feed ICS:', vevents.length);

  const occ = vevents.map(ev => {
    const handle =
      (ev.uid && String(ev.uid)) ||
      (ev.summary || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return {
      handle,
      title: ev.summary || '',
      location: ev.location || '',
      description: ev.description || '',
      start: ev.start ? new Date(ev.start).toISOString() : null,
      end: ev.end ? new Date(ev.end).toISOString() : null
    };
  }).filter(e => e.handle && e.start);

  const newHandles = occ.map(e => e.handle);
  console.log('Eventos a procesar:', occ.length);

  for (const ev of occ) {
    const fields = [
      { key: 'title', value: ev.title || '' },
      { key: 'location', value: ev.location || '' },
      { key: 'description', value: ev.description || '' },
      { key: 'start', value: ev.start }
    ];
    if (ev.end) fields.push({ key: 'end', value: ev.end });

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