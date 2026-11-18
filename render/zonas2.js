// Videos de campaña con varias zonas (barrios aproximados y suavizados, calles, CABA).
// Uso: node render/zonas2.js            → arma test/z2-*.json
'use strict';
const fs = require('fs');
const path = require('path');
const turf = require('@turf/turf');

const UA = { 'User-Agent': 'location-video-3d/0.1 (+https://github.com/gaelmusa/location-video-3d)', 'Accept-Language': 'es' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = path.join(__dirname, '..', 'test', 'cache-zonas.json');
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache));

async function nominatim(q, extra = '') {
  if (cache['n:' + q + extra]) return cache['n:' + q + extra];
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&polygon_geojson=1' + extra + '&q=' + encodeURIComponent(q), { headers: UA });
  await sleep(1100);
  const j = await r.json();
  cache['n:' + q + extra] = j; saveCache();
  return j;
}
async function overpass(q) {
  if (cache['o:' + q]) return cache['o:' + q];
  for (let i = 0; i < 6; i++) {
    const u = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'][i % 3];
    try {
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: UA, signal: AbortSignal.timeout(60000) });
      if (r.ok) { const els = (await r.json()).elements; cache['o:' + q] = els; saveCache(); return els; }
    } catch (e) {}
    await sleep(4000);
  }
  throw new Error('Overpass no respondió');
}

// Contorno "lindo y aproximado": anillo principal, simplificado, achicado un poco para que
// los barrios vecinos no se pisen, y con las esquinas redondeadas (Chaikin).
function mayor(f) {
  if (f.geometry.type !== 'MultiPolygon') return turf.polygon([f.geometry.coordinates[0]]);
  return f.geometry.coordinates.map(c => turf.polygon([c[0]])).reduce((a, p) => turf.area(p) > turf.area(a) ? p : a);
}
// Contorno "lindo y aproximado": sobre el contorno oficial se hace un cierre (rellena muescas)
// y una apertura (borra franjas angostas de vías, puerto o costanera) con radio R; queda todo
// redondeado a esa escala. Después se achica un poco para que los vecinos no se pisen.
function prolijo(feature, { R = 250, shrinkM = 0, tolM = 50, iter = 3 }) {
  const o = { units: 'meters', steps: 12 };
  let f = mayor(feature);
  f = mayor(turf.buffer(f, R, o));
  f = mayor(turf.buffer(f, -2 * R, o));
  f = mayor(turf.buffer(f, R - shrinkM, o));
  f = turf.simplify(f, { tolerance: tolM / 111000, highQuality: true });
  f = turf.polygonSmooth(f, { iterations: iter }).features[0];
  return f.geometry.coordinates[0].map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
}

// Ajuste por barrio: tolerancia de simplificación y apertura (franjas angostas que se borran)
const AJUSTE = { Recoleta: { R: 260 }, Palermo: { R: 320 }, Belgrano: { R: 300 }, Retiro: { R: 300 } };
const CRUDO = {};
async function barrio(nombre) {
  let r;
  for (const q of [nombre + ', Ciudad Autónoma de Buenos Aires', nombre + ', Comuna 1, Ciudad Autónoma de Buenos Aires', 'Barrio ' + nombre + ', Buenos Aires']) {
    r = (await nominatim(q, '&featureType=settlement')).find(x => x.addresstype === 'suburb' && /Polygon/.test(x.geojson.type));
    if (r) break;
  }
  if (!r) throw new Error('Sin contorno para ' + nombre);
  CRUDO[nombre] = (r.geojson.type === 'Polygon' ? [r.geojson.coordinates] : r.geojson.coordinates).map(c => c[0]);
  return prolijo(turf.feature(r.geojson), { shrinkM: 60, ...(AJUSTE[nombre] || {}) });
}

async function caba() {
  const r = (await nominatim('Ciudad Autónoma de Buenos Aires')).find(x => /Polygon/.test(x.geojson.type));
  return prolijo(turf.feature(r.geojson), { R: 600, tolM: 120 });
}

// Barrio Norte no es un barrio oficial: se aproxima con las avenidas Córdoba, 9 de Julio,
// del Libertador y Coronel Díaz (Wikipedia). Cada avenida se ajusta a una recta y las
// esquinas son los cruces de esas rectas; después se redondean.
async function barrioNorte() {
  // Overpass suele caerse: los tramos de cada avenida salen de Nominatim, limitados a la zona
  const names = ['Avenida Córdoba', 'Avenida 9 de Julio', 'Avenida Del Libertador', 'Avenida Coronel Díaz'];
  const els = [];
  for (const n of names) {
    const r = await nominatim(n, '&limit=40&bounded=1&viewbox=-58.428,-34.568,-58.362,-34.612');
    for (const x of r) if (/LineString/.test(x.geojson.type) && x.name.toLowerCase() === n.toLowerCase()) {
      const ls = x.geojson.type === 'LineString' ? [x.geojson.coordinates] : x.geojson.coordinates;
      for (const l of ls) els.push({ tags: { name: n }, geometry: l.map(([lon, lat]) => ({ lon, lat })) });
    }
  }
  const fit = name => {
    const pts = els.filter(e => e.tags.name === name).flatMap(e => e.geometry.map(g => [g.lon, g.lat]));
    if (pts.length < 2) throw new Error('Sin trazado para ' + name);
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) { const dx = (x - mx) * Math.cos(my * Math.PI / 180), dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const k = 0.2; // recta larga para que siempre se crucen
    const ux = Math.cos(ang) / Math.cos(my * Math.PI / 180), uy = Math.sin(ang);
    return turf.lineString([[mx - ux * k, my - uy * k], [mx + ux * k, my + uy * k]]);
  };
  const [cor, nueve, lib, cdiaz] = names.map(fit);
  const x = (a, b) => turf.lineIntersect(a, b).features[0].geometry.coordinates;
  const ring = [x(cor, nueve), x(nueve, lib), x(lib, cdiaz), x(cdiaz, cor)];
  ring.push(ring[0]);
  return prolijo(turf.polygon([ring]), { R: 250, shrinkM: 40, tolM: 10 });
}

async function calle(nombreOsm, previo) {
  // si ya se bajó para los videos anteriores, se reutiliza
  const f = path.join(__dirname, '..', 'test', `zona-${previo}.json`);
  if (previo && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).zone.lines;
  const els = await overpass(`[out:json][timeout:50];area["name"="Ciudad Autónoma de Buenos Aires"]["boundary"="administrative"]->.a;way(area.a)[highway][name="${nombreOsm}"];out geom;`);
  return els.filter(e => e.geometry).map(e => e.geometry.map(g => [+g.lon.toFixed(6), +g.lat.toFixed(6)]));
}

// ---------- cámara: puntos de paso ----------
const centroid = rings => { const c = turf.centroid(turf.multiPoint(rings.flat())).geometry.coordinates; return { lng: c[0], lat: c[1] }; };
const extentM = rings => { const b = turf.bbox(turf.multiPoint(rings.flat())); return Math.max(turf.distance([b[0], b[1]], [b[2], b[1]], { units: 'meters' }), turf.distance([b[0], b[1]], [b[0], b[3]], { units: 'meters' })) / 2; };
// distancia de cámara para que la zona entre de ancho en el cuadro vertical (medio ancho ≈ 0,33 × distancia)
const fitRange = (ext, k = 1) => Math.max(2600, ext / 0.33 * 0.8 * k);

function zonaDe(kind, label, geo, t) {
  const rings = kind === 'calle' ? geo : [geo];
  const c = centroid(rings);
  let labelPt = c;
  if (kind === 'barrio') {
    const pole = turf.centerOfMass(turf.polygon([geo])).geometry.coordinates; // dentro del barrio
    labelPt = { lng: pole[0], lat: pole[1] };
  }
  return { kind, label, rings: kind === 'calle' ? null : rings, lines: kind === 'calle' ? geo : null, labelPt, center: c, ext: extentM(rings), t };
}

function armar(slug, subtitle, zonas, { overview = true, overviewRange = 0, heading0 = -12, headingStep = 9 } = {}) {
  const all = zonas.flatMap(z => z.rings || z.lines);
  const c = centroid(all);
  const keys = [];
  if (overview) keys.push({ t: 0, lat: c.lat, lng: c.lng, range: overviewRange || fitRange(extentM(all), 1.25), pitch: -80, heading: heading0 });
  zonas.forEach((z, i) => keys.push({ t: z.t, lat: z.center.lat, lng: z.center.lng, range: fitRange(z.ext, z.kind === 'calle' ? 0.9 : 1.05), pitch: -58, heading: heading0 + headingStep * (i + 1) }));
  if (keys[keys.length - 1].t < 1) { const k = keys[keys.length - 1]; keys.push({ ...k, t: 1, range: k.range * 0.92, heading: k.heading + headingStep * 0.6 }); }
  const job = { mode: 'zonas', lat: c.lat, lng: c.lng, seconds: 7, accent: '#C9A45C', title: '', subtitle, pinLabel: null, zones: zonas.map(({ center, ext, ...z }) => z), keys };
  fs.writeFileSync(path.join(__dirname, '..', 'test', `z2-${slug}.json`), JSON.stringify(job));
  console.log(slug, zonas.map(z => `${z.label}@${z.t} ext ${Math.round(z.ext)} m`).join(' | '), '| arranque', Math.round(keys[0].range), 'm');
}

(async () => {
  fs.mkdirSync(path.join(__dirname, '..', 'test'), { recursive: true });
  const B = {};
  for (const n of ['Recoleta', 'Palermo', 'Belgrano', 'Retiro']) B[n] = await barrio(n);
  B['Barrio Norte'] = await barrioNorte();
  const ciudad = await caba();
  const florida = await calle('Florida', 'florida'), cabildo = await calle('Avenida Cabildo', 'cabildo');
  const sub = 'Ciudad de Buenos Aires';
  fs.writeFileSync(path.join(__dirname, '..', 'test', 'formas.json'), JSON.stringify({ suave: { ...B, CABA: ciudad }, crudo: CRUDO, calles: { Florida: florida, Cabildo: cabildo } }));

  // Hook 1: «Recoleta, Belgrano o Palermo» — paneo de sureste a noroeste (Recoleta → Palermo → Belgrano)
  armar('hook1-recoleta-palermo-belgrano', sub, [zonaDe('barrio', 'Recoleta', B.Recoleta, 0.3), zonaDe('barrio', 'Palermo', B.Palermo, 0.6), zonaDe('barrio', 'Belgrano', B.Belgrano, 0.88)]);
  // Hook 2: «tu próxima sucursal en CABA» — se dibuja el contorno de la Ciudad
  armar('hook2-caba', 'Argentina', [zonaDe('barrio', 'CABA', ciudad, 0.75)], { headingStep: 6, overviewRange: 65000 });
  // Hook 4: «Recoleta, Barrio Norte o Retiro»
  armar('hook4-recoleta-barrionorte-retiro', sub, [zonaDe('barrio', 'Recoleta', B.Recoleta, 0.3), zonaDe('barrio', 'Barrio Norte', B['Barrio Norte'], 0.6), zonaDe('barrio', 'Retiro', B.Retiro, 0.88)]);
  // Hook 5: «Palermo y Recoleta»
  armar('hook5-palermo-recoleta', sub, [zonaDe('barrio', 'Palermo', B.Palermo, 0.4), zonaDe('barrio', 'Recoleta', B.Recoleta, 0.85)]);
  // Cuerpo: «de Florida a Cabildo, pasando por Recoleta, Palermo y Belgrano»
  armar('cuerpo-florida-a-cabildo', sub, [zonaDe('calle', 'Florida', florida, 0.16), zonaDe('barrio', 'Recoleta', B.Recoleta, 0.38), zonaDe('barrio', 'Palermo', B.Palermo, 0.58), zonaDe('barrio', 'Belgrano', B.Belgrano, 0.78), zonaDe('calle', 'Av. Cabildo', cabildo, 0.95)], { headingStep: 5 });
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
