import 'dotenv/config';
import ical from 'node-ical';
import fetch from 'node-fetch';

const shopifyEndpoint = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-07/graphql.json`;
const shopifyToken = process.env.SHOPIFY_ADMIN_TOKEN;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(shopifyEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyToken
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Shopify GraphQL error');
  }
  return json.data;
}

export async function runSync() {
  console.log('Iniciando sincronización');

  const configData = await shopifyGraphQL(`
    {
      metaobject(id: "gid://shopify/Metaobject/${process.env.CALENDAR_CONFIG_ID}") {
        field(key: "ics_url") { value }
        field(key: "lookahead_days") { value }
      }
    }
  `);

  const icsUrl = configData.metaobject.field[0].value;
  const lookaheadDays = parseInt(configData.metaobject.field[1].value, 10) || 180;
  console.log('Config ICS:', icsUrl);
  console.log('Lookahead días:', lookaheadDays);

  const currentData = await shopifyGraphQL(`
    {
      metaobjects(type: "event", first: 250) {
        edges {
          node {
            id
            handle
          }
        }
      }
    }
  `);
  const currentHandles = currentData.metaobjects.edges.map(e => e.node.handle);
  console.log('Eventos actuales en Shopify:', currentHandles.length);

  console.log('Descargando feed ICS');
  const parsed = await ical.async.fromURL(icsUrl);
  const vevents = Object.values(parsed).filter(ev => ev.type === 'VEVENT');

  const now = new Date();
  const cutoff = new Date();
  cutoff.setDate(now.getDate() + lookaheadDays);

  const occ = vevents
    .filter(ev => ev.start && ev.start >= now && ev.start <= cutoff)
    .map(ev => {
      const handle = (ev.uid && String(ev.uid)) ||
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
        start_date: ev.start ? new Date(ev.start).toISOString() : null,
        end_date: ev.end ? new Date(ev.end).toISOString() : null
      };
    });

  const newHandles = occ.map(ev => ev.handle);
  console.log('Eventos a procesar:', occ.length);

  for (const ev of occ) {
    if (currentHandles.includes(ev.handle)) {
      await shopifyGraphQL(`
        mutation UpdateEvent($handle: String!, $title: String!, $location: String!, $description: String!, $start_date: String, $end_date: String) {
          metaobjectUpdate(handle: $handle, type: "event", metaobject: {
            status: ACTIVE,
            fields: [
              { key: "title", value: $title },
              { key: "location", value: $location },
              { key: "description", value: $description },
              { key: "start_date", value: $start_date },
              { key: "end_date", value: $end_date }
            ]
          }) {
            metaobject { id }
            userErrors { field message }
          }
        }
      `, ev);
    } else {
      await shopifyGraphQL(`
        mutation CreateEvent($handle: String!, $title: String!, $location: String!, $description: String!, $start_date: String, $end_date: String) {
          metaobjectCreate(metaobject: {
            type: "event",
            handle: $handle,
            status: ACTIVE,
            fields: [
              { key: "title", value: $title },
              { key: "location", value: $location },
              { key: "description", value: $description },
              { key: "start_date", value: $start_date },
              { key: "end_date", value: $end_date }
            ]
          }) {
            metaobject { id }
            userErrors { field message }
          }
        }
      `, ev);
    }
  }

  const toDelete = currentHandles.filter(h => !newHandles.includes(h));
  console.log('Eventos a borrar:', toDelete.length);
  for (const handle of toDelete) {
    await shopifyGraphQL(`
      mutation DeleteEvent($handle: String!) {
        metaobjectDelete(handle: $handle, type: "event") {
          deletedId
          userErrors { field message }
        }
      }
    `, { handle });
  }

  console.log('Sincronización completada');
}