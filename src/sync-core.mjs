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

  // Leer URL ICS desde metaobjeto config_calendar
  const configData = await shopifyGraphQL(`
    {
      metaobjects(type: "config_calendar", first: 1) {
        edges {
          node {
            field(key: "ics_url") { value }
            field(key: "lookahead_days") { value }
          }
        }
      }
    }
  `);
  if (!configData.metaobjects.edges.length) throw new Error('No config_calendar metaobject found');
  const configNode = configData.metaobjects.edges[0].node;
  const icsUrl = configNode.field.find(f => f && f.value && f.key === 'ics_url')?.value || configNode.field[0]?.value;
  const lookaheadDays = parseInt(
    configNode.field.find(f => f && f.value && f.key === 'lookahead_days')?.value ||
    configNode.field[1]?.value ||
    '180',
    10
  );
  console.log(`Config ICS: ${icsUrl}`);
  console.log(`Lookahead días: ${lookaheadDays}`);

  // Obtener eventos actuales
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
  const currentEvents = currentData.metaobjects.edges.map(e => ({ id: e.node.id, handle: e.node.handle }));
  console.log('Eventos actuales en Shopify:', currentEvents.length);

  // Descargar y filtrar eventos ICS
  console.log('Descargando feed ICS');
  const parsed = await ical.async.fromURL(icsUrl);
  const now = new Date();
  const futureLimit = new Date(now.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);

  const vevents = Object.values(parsed)
    .filter(ev => ev.type === 'VEVENT')
    .filter(ev => ev.start && ev.start >= now && ev.start <= futureLimit);

  console.log('Eventos en el feed ICS tras filtro:', vevents.length);

  // Mapear a formato Shopify
  const occ = vevents.map(ev => {
    const handle =
      (ev.uid && String(ev.uid).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) ||
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
      start: ev.start ? new Date(ev.start).toISOString() : '',
      end: ev.end ? new Date(ev.end).toISOString() : ''
    };
  });
  const newHandles = occ.map(ev => ev.handle);
  console.log('Eventos a procesar:', occ.length);

  // Crear o actualizar
  for (const ev of occ) {
    const existing = currentEvents.find(e => e.handle === ev.handle);
    if (existing) {
      console.log('Actualizando evento existente:', ev.handle);
      await shopifyGraphQL(`
        mutation Update($id: ID!, $title: String!, $location: String!, $description: String!, $start: String!, $end: String!) {
          metaobjectUpdate(id: $id, metaobject: {
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
      `, { id: existing.id, ...ev });
    } else {
      console.log('Creando evento nuevo:', ev.handle);
      await shopifyGraphQL(`
        mutation Create($handle: String!, $title: String!, $location: String!, $description: String!, $start: String!, $end: String!) {
          metaobjectCreate(metaobject: {
            type: "event",
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

  // Borrar eventos que ya no existen
  const toDelete = currentEvents.filter(e => !newHandles.includes(e.handle));
  console.log('Eventos a borrar:', toDelete.length);
  for (const ev of toDelete) {
    console.log('Borrando evento:', ev.handle);
    await shopifyGraphQL(`
      mutation Delete($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors { field message }
        }
      }
    `, { id: ev.id });
  }

  console.log('Sincronización completada');
}