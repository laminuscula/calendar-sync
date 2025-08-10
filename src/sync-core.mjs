import 'dotenv/config';
import ical from 'node-ical';
import fetch from 'node-fetch';

const icsUrl = process.env.ICS_URL;
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
  const currentData = await shopifyGraphQL(`
    {
      metaobjects(type: "evento", first: 250) {
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
  console.log('Eventos en el feed ICS:', vevents.length);

  const occ = vevents.map(ev => {
    const start = ev.start.toISOString();
    const end = ev.end.toISOString();
    const handle = ev.uid || ev.summary.replace(/\s+/g, '-').toLowerCase();
    return {
      handle,
      title: ev.summary || '',
      location: ev.location || '',
      description: ev.description || '',
      start,
      end
    };
  });
  const newHandles = occ.map(ev => ev.handle);
  console.log('Eventos a procesar:', occ.length);

  for (const ev of occ) {
    console.log('Procesando evento:', ev.title);
    if (currentHandles.includes(ev.handle)) {
      console.log('Actualizando evento existente:', ev.handle);
      await shopifyGraphQL(`
        mutation UpdateEvent($handle: String!, $title: String!, $location: String!, $description: String!, $start: String!, $end: String!) {
          metaobjectUpdate(handle: $handle, type: "evento", metaobject: {
            fields: [
              { key: "title", value: $title },
              { key: "location", value: $location },
              { key: "description", value: $description },
              { key: "start", value: $start },
              { key: "end", value: $end }
            ]
          }) {
            metaobject { id }
            userErrors { field message }
          }
        }
      `, ev);
    } else {
      console.log('Creando evento nuevo:', ev.handle);
      await shopifyGraphQL(`
        mutation CreateEvent($handle: String!, $title: String!, $location: String!, $description: String!, $start: String!, $end: String!) {
          metaobjectCreate(metaobject: {
            type: "evento",
            handle: $handle,
            fields: [
              { key: "title", value: $title },
              { key: "location", value: $location },
              { key: "description", value: $description },
              { key: "start", value: $start },
              { key: "end", value: $end }
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
    console.log('Borrando evento:', handle);
    await shopifyGraphQL(`
      mutation DeleteEvent($handle: String!) {
        metaobjectDelete(handle: $handle, type: "evento") {
          deletedId
          userErrors { field message }
        }
      }
    `, { handle });
  }

  console.log('Sincronización completada');
}