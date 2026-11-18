// Videos de zona (barrio o calle) para campañas: un video por zona, en test/zona-*.json
// Uso: node render/zonas.js
'use strict';
const fs = require('fs');
const path = require('path');

const UA = { 'User-Agent': 'location-video-3d/0.1 (+https://github.com/gaelmusa/location-video-3d)', 'Accept-Language': 'es' };
const R = 6371008.8, rad = d => d * Math.PI / 180;
const dist = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const bearing = (a, b) => { const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat)); const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng)); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function nominatim(q) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&polygon_geojson=1&polygon_threshold=0.0002&q=' + encodeURIComponent(q), { headers: UA });
  await sleep(1100);
  return r.json();
}
async function overpass(q) {
  for (const u of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']) {
    try {
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: UA, signal: AbortSignal.timeout(60000) });
      if (r.ok) return (await r.json()).elements;
    } catch (e) {}
    await sleep(3000);
  }
  throw new Error('Overpass no respondió');
}

async function barrio(nombre) {
  const r = (await nominatim(nombre + ', Ciudad Autónoma de Buenos Aires')).find(x => x.addresstype === 'suburb' && /Polygon/.test(x.geojson.type));
  const g = r.geojson;
  const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(p => p[0]);
  const all = rings.reduce((a, r) => r.length > a.length ? r : a); // el anillo principal del barrio
  const c = { lng: all.reduce((a, p) => a + p[0], 0) / all.length, lat: all.reduce((a, p) => a + p[1], 0) / all.length };
  const ext = Math.max(...all.map(([lng, lat]) => dist(c, { lat, lng })));
  return { rings, center: c, extent: ext };
}

// Calle completa dentro de CABA, uniendo todos sus tramos
async function calle(nombreOsm) {
  const els = await overpass(`[out:json][timeout:50];area["name"="Ciudad Autónoma de Buenos Aires"]["boundary"="administrative"]->.a;way(area.a)[highway][name="${nombreOsm}"];out geom;`);
  const lines = els.filter(e => e.geometry).map(e => e.geometry.map(g => [g.lon, g.lat]));
  const all = lines.flat();
  let a = all[0], b = all[0], best = 0;
  for (const p of all) for (const q of all.filter((_, i) => i % 7 === 0)) { const d = dist({ lat: p[1], lng: p[0] }, { lat: q[1], lng: q[0] }); if (d > best) { best = d; a = p; b = q; } }
  const c = { lng: (a[0] + b[0]) / 2, lat: (a[1] + b[1]) / 2 };
  return { lines, center: c, extent: best / 2, axis: bearing({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }) };
}

async function punto(q) {
  const r = (await nominatim(q + ', Ciudad Autónoma de Buenos Aires'))[0];
  return r ? { name: q, lat: +r.lat, lng: +r.lon } : null;
}

const ZONAS = [
  { slug: 'florida', titulo: 'Calle Florida', tipo: 'calle', osm: 'Florida', etiqueta: 'Florida', ref: 'Galerías Pacífico' },
  { slug: 'cabildo', titulo: 'Avenida Cabildo', tipo: 'calle', osm: 'Avenida Cabildo', etiqueta: 'Av. Cabildo', ref: 'Barrancas de Belgrano' },
  { slug: 'recoleta', titulo: 'Recoleta', tipo: 'barrio', etiqueta: 'Recoleta', ref: 'Cementerio de la Recoleta' },
  { slug: 'palermo', titulo: 'Palermo', tipo: 'barrio', etiqueta: 'Palermo', ref: 'Planetario Galileo Galilei' },
  { slug: 'belgrano', titulo: 'Belgrano', tipo: 'barrio', etiqueta: 'Belgrano', ref: 'Barrancas de Belgrano' },
];

(async () => {
  const solo = process.argv[2];
  for (const z of ZONAS.filter(z => !solo || z.slug === solo)) {
    const geo = z.tipo === 'barrio' ? await barrio(z.titulo) : await calle(z.osm);
    const ref = z.ref ? await punto(z.ref) : null;
    // Al final la zona entera tiene que entrar en el cuadro vertical (FOV horizontal ~36°)
    const endRange = Math.max(1400, geo.extent * (z.tipo === 'calle' ? 2.1 : 1.9));
    const job = {
      mode: 'zona', lat: geo.center.lat, lng: geo.center.lng, seconds: 7, accent: '#C9A45C',
      title: z.titulo, subtitle: 'Ciudad de Buenos Aires', pinLabel: null,
      zone: { kind: z.tipo, label: z.etiqueta, rings: geo.rings || null, lines: geo.lines || null },
      refs: ref ? [{ ...ref, dist: Math.round(dist(geo.center, ref)), landmark: true }] : [],
      startRange: 26000, endRange, heading0: z.tipo === 'calle' ? (geo.axis + 180) % 360 - 25 : -10, heading1: z.tipo === 'calle' ? (geo.axis + 180) % 360 : 15,
    };
    fs.mkdirSync(path.join(__dirname, '..', 'test'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'test', `zona-${z.slug}.json`), JSON.stringify(job));
    console.log(z.slug, z.tipo, 'tramos/anillos', (geo.lines || geo.rings).length, 'extensión', Math.round(geo.extent), 'm', 'endRange', Math.round(endRange), 'ref', ref && ref.name);
  }
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
