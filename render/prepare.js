// Del link de Google Maps a los dos trabajos de render (macro 50 km y entorno).
'use strict';
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const CONTACT = 'location-video-3d/0.1 (+https://github.com/gaelmusa/location-video-3d)';
const R = 6371008.8;
const rad = d => d * Math.PI / 180;

function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const okCoord = (lat, lng) => isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// ---------- Link → coordenadas ----------

function parseMapsUrl(u) {
  let s = u;
  try { s = decodeURIComponent(u); } catch (e) {}
  let m;
  // 1) pin real del lugar: !3d<lat>!4d<lng> (el último par es el del lugar)
  const pins = [...s.matchAll(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/g)];
  if (pins.length) { const p = pins[pins.length - 1]; return { lat: +p[1], lng: +p[2], how: 'pin' }; }
  // 2) parámetros explícitos
  for (const k of ['q', 'query', 'll', 'destination', 'center', 'daddr', 'sll']) {
    m = s.match(new RegExp('[?&]' + k + '=(?:loc:)?\\s*(-?\\d+\\.\\d+)\\s*,\\s*(-?\\d+\\.\\d+)'));
    if (m) return { lat: +m[1], lng: +m[2], how: k };
  }
  // 3) /place/<lat>,<lng> o /search/<lat>,<lng>
  m = s.match(/\/(?:place|search|dir)\/[^/]*?(-?\d{1,2}\.\d+)\s*,\s*\+?(-?\d{1,3}\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], how: 'path' };
  // 4) centro de la cámara @lat,lng (menos preciso)
  m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], how: 'camera' };
  return null;
}

function placeName(u) {
  let s = u;
  try { s = decodeURIComponent(u.replace(/\+/g, ' ')); } catch (e) {}
  const m = s.match(/\/place\/([^/@?]+)/) || s.match(/[?&]q=([^&]+)/) || s.match(/[?&]query=([^&]+)/);
  if (!m) return '';
  const n = m[1].trim();
  return /^-?\d+\.\d+\s*,/.test(n) ? '' : n;
}

// Los links cortos redirigen (302) si el pedido NO parece un navegador; con agente de navegador Google
// a veces devuelve una página intermedia (200). Se prueba primero sin agente y después con agente.
async function expand(url) {
  let primera = null;
  for (const ua of ['curl/8.7.1', UA]) {
    const out = await expandWith(url, ua).catch(() => null);
    if (out && parseMapsUrl(out)) return out;
    if (out && out !== url && !primera) primera = out; // ej. «maps.google.com?q=dirección&ftid=…», sin coordenadas
  }
  return primera || url;
}
async function expandWith(url, ua) {
  let cur = url;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(cur, { redirect: 'manual', headers: { 'User-Agent': ua, 'Accept-Language': 'es-AR,es;q=0.9' } });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      cur = new URL(loc, cur).toString();
      const c = new URL(cur);
      if (/consent\.google/.test(c.hostname) && c.searchParams.get('continue')) cur = c.searchParams.get('continue');
      if (parseMapsUrl(cur)) return cur;
      continue;
    }
    // Sin redirección: a veces la página trae la URL final adentro
    const html = r.status === 200 ? await r.text() : '';
    const m = html.match(/https:\/\/www\.google\.[a-z.]+\/maps\/[^"'\\\s<>]+/);
    if (m && parseMapsUrl(m[0].replace(/\\u0026/g, '&'))) return m[0].replace(/\\u0026/g, '&');
    return cur;
  }
  return cur;
}

async function nominatim(pathq) {
  const r = await fetch('https://nominatim.openstreetmap.org/' + pathq, { headers: { 'User-Agent': CONTACT, 'Accept-Language': 'es' } });
  if (!r.ok) throw new Error('Nominatim ' + r.status);
  return r.json();
}

// Algunos links (sobre todo los que se comparten desde el celular) llevan a una dirección de texto
// sin coordenadas. Google Maps calcula el punto recién al abrirse: se abre en Chrome sin pantalla
// y se leen las coordenadas de la dirección final (!3d…!4d… es el pin del lugar).
async function coordsConChrome(url) {
  if (process.env.SIN_CHROME) return null; // para probar el último recurso
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (e) { return null; }
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--lang=es-AR', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])] });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let cur = page.url();
    for (let i = 0; i < 50 && !/!3d-?\d+\.\d+!4d-?\d+\.\d+/.test(cur); i++) { await new Promise(r => setTimeout(r, 500)); cur = page.url(); }
    const p = parseMapsUrl(cur);
    return p && okCoord(p.lat, p.lng) ? { ...p, url: cur } : null;
  } catch (e) {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function textoDeBusqueda(u) {
  try {
    const x = new URL(u);
    return (x.searchParams.get('q') || x.searchParams.get('query') || '').trim();
  } catch (e) { return ''; }
}

async function resolveLink(input) {
  const text = String(input || '').trim();
  let m = text.match(/^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/);
  if (m && okCoord(+m[1], +m[2])) return { lat: +m[1], lng: +m[2], name: '', how: 'coords', url: text };
  const urlM = text.match(/https?:\/\/\S+/);
  if (!urlM) throw new Error('No encontré un link de Google Maps ni coordenadas en el texto.');
  let url = urlM[0];
  const host = new URL(url).hostname;
  if (!/(^|\.)(google\.[a-z.]+|goo\.gl|g\.co|app\.goo\.gl)$/.test(host)) throw new Error('El link no es de Google Maps: ' + host);
  // 1) coordenadas en el link (o en el link largo al que redirige)
  let p = parseMapsUrl(url);
  let largo = url;
  if (!p || p.how === 'camera') {
    largo = await expand(url);
    const q = parseMapsUrl(largo);
    if (q && (!p || q.how !== 'camera')) { p = q; url = largo; }
  }
  // 2) sin coordenadas: abrir el link en Chrome y leer el pin que pone Google Maps
  if (!p || !okCoord(p.lat, p.lng)) {
    const c = await coordsConChrome(largo);
    if (c) { p = c; url = c.url; }
  }
  // Nombre del lugar: /place/Nombre o el primer tramo de la dirección de texto (?q=Nombre, calle, ciudad)
  const busqueda = textoDeBusqueda(largo);
  const name = placeName(url) || busqueda.split(',')[0].trim();
  // 3) último recurso: buscar la dirección de texto en OpenStreetMap, de lo más completo a lo más corto
  if (!p || !okCoord(p.lat, p.lng)) {
    const partes = busqueda.split(',').map(x => x.trim()).filter(Boolean);
    const intentos = [busqueda, partes.slice(1).join(', '), name].filter((x, i, a) => x && a.indexOf(x) === i);
    for (const q of intentos) {
      const r = await nominatim('search?format=jsonv2&limit=1&q=' + encodeURIComponent(q)).catch(() => []);
      if (r[0]) { p = { lat: +r[0].lat, lng: +r[0].lon, how: 'direccion' }; break; }
    }
  }
  if (!p || !okCoord(p.lat, p.lng)) throw new Error('No pude ubicar ese link de Google Maps. Abrilo en Google Maps, tocá «Compartir» y copiá el link de nuevo; si sigue fallando, pegá las coordenadas (ej. -34.60, -58.38).');
  return { lat: p.lat, lng: p.lng, name, how: p.how, url };
}

// ---------- Referencias ----------

let CITIES;
function cities() { return CITIES || (CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'ciudades.json'), 'utf8'))); }

function macroRefs(p, maxKm = 60) {
  const near = [];
  for (const [name, lat, lng, pop, cc] of cities()) {
    if (Math.abs(lat - p.lat) > 1 || Math.abs(lng - p.lng) > 1.3) continue;
    const d = dist(p, { lat, lng });
    if (d <= maxKm * 1000) near.push({ name, lat, lng, pop, d, b: bearing(p, { lat, lng }) });
  }
  near.sort((a, b) => b.pop - a.pop);
  // Ciudad donde está el inmueble (la más grande a menos de 8 km, o la más cercana)
  const home = near.filter(c => c.d < 8000)[0] || [...near].sort((a, b) => a.d - b.d)[0] || null;
  // Importancia: población grande y cercanía (Rosario a 21 km gana a un pueblo a 50 km)
  const score = c => Math.log(c.pop) - 1.4 * Math.log(Math.max(c.d, 8000) / 1000);
  const ranked = near.filter(c => !(home && c.name === home.name) && c.d >= 6000 && c.pop >= 30000).sort((a, b) => score(b) - score(a));
  const out = [];
  for (const c of ranked) {
    if (out.length && score(c) < score(out[0]) - 2.2) break; // mucho menos relevante que la primera: no se muestra
    if (out.some(o => angDiff(o.b, c.b) < 30 && Math.abs(o.d - c.d) < 25000)) continue;
    out.push(c);
    if (out.length >= 2) break;
  }
  const homePop = home && home.d < 8000 ? home.pop : 0;
  return { home, refs: out.map(c => ({ name: c.name, lat: c.lat, lng: c.lng, dist: Math.round(c.d), major: c.pop >= 300000 && c.pop >= 3 * homePop })) };
}

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Overpass se cae seguido: cada servidor se prueba una vez con 25 s de límite, y si fallan todos,
// el resto del pedido no vuelve a esperarlo (las calles salen de Nominatim).
let overpassCaido = false;
async function overpass(q) {
  if (overpassCaido) throw new Error('Overpass no responde');
  let last;
  for (const u of OVERPASS) {
    try {
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'User-Agent': CONTACT, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(25000) });
      if (r.ok) return (await r.json()).elements || [];
      last = new Error('Overpass ' + r.status);
    } catch (e) { last = e; }
  }
  overpassCaido = true;
  throw last;
}

// Solo lugares que a un comprador o inversor le importan; capillas, kioscos, gimnasios, etc. quedan afuera
const known = t => !!(t.wikipedia || t['wikipedia:es']);
const KINDS = [
  [t => (t.tourism === 'attraction' || t.historic === 'monument' || t.tourism === 'museum') && (known(t) || t.wikidata), 'atraccion', 4],
  [t => t.amenity === 'university' || t.amenity === 'college', 'universidad', 3.5],
  [t => t.amenity === 'hospital', 'hospital', 3.5],
  [t => t.leisure === 'stadium', 'estadio', 3.5],
  [t => t.shop === 'mall', 'shopping', 3.5],
  [t => t.railway === 'station' || t.amenity === 'bus_station', 'estacion', 3],
  [t => t.amenity === 'clinic' && (t.operator || t.wikidata), 'clinica', 2.5],
  [t => t.leisure === 'golf_course', 'golf', 2.5],
  [t => t.amenity === 'school', 'escuela', 2],
  [t => (t.leisure === 'park' || t.place === 'square') && (known(t) || t.wikidata), 'parque', 2.5],
  [t => t.shop === 'supermarket' && t.brand, 'super', 2],
  [t => t.amenity === 'place_of_worship' && (t.building === 'cathedral' || /catedral|bas[ií]lica/i.test(t.name || '')), 'iglesia', 3],
];

function shortName(t) {
  let n = t.short_name || t['name:es'] || t.name;
  if (n.length > 30) n = n.replace(/\s+\(.*?\)/g, '');
  if (n.length > 34) n = n.replace(/\bHistórico\s+(Nacional\s+)?/g, '');
  return n;
}

async function microRefs(p, radius = 900) {
  const q = `[out:json][timeout:30];(
    nwr(around:${radius},${p.lat},${p.lng})[name][~"^(amenity|leisure|shop|tourism|historic|railway)$"~"^(university|college|hospital|clinic|school|stadium|park|mall|supermarket|attraction|museum|monument|station|bus_station|place_of_worship|golf_course)$"];
    nwr(around:${radius},${p.lat},${p.lng})[place=square][name];
  );out center tags;
  way(around:60,${p.lat},${p.lng})[highway~"^(primary|secondary|tertiary|residential|unclassified|living_street|trunk)$"][name];
  out tags geom;`;
  const els = await overpass(q);
  const pois = [], roads = [];
  for (const e of els) {
    const t = e.tags || {};
    if (t.highway) { roads.push(e); continue; }
    const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
    if (!c) continue;
    const kind = KINDS.find(k => k[0](t));
    if (!kind) continue;
    const d = dist(p, { lat: c.lat, lng: c.lon });
    if (d < 40) continue;
    let score = kind[2] + (t.wikidata ? 1 : 0) + (known(t) ? 2 : 0) - d / 600;
    pois.push({ name: shortName(t), lat: c.lat, lng: c.lon, dist: Math.round(d), kind: kind[1], score, b: bearing(p, { lat: c.lat, lng: c.lon }) });
  }
  pois.sort((a, b) => b.score - a.score);
  const out = [];
  for (const x of pois) {
    if (out.some(o => o.name === x.name)) continue;
    if (out.filter(o => o.kind === x.kind).length >= 1 && x.kind !== 'atraccion') continue;
    if (out.some(o => angDiff(o.b, x.b) < 25 && Math.abs(o.dist - x.dist) < 250)) continue;
    out.push(x);
    if (out.length >= 5) break;
  }
  return { refs: out.map(({ name, lat, lng, dist }) => ({ name, lat, lng, dist })), frontRoads: roads };
}

// Calles sobre las que está el inmueble (1 o 2 si es esquina) con su trazado a 450 m alrededor
async function streetsFor(p, frontRoads) {
  const names = [];
  const near = frontRoads.map(r => ({ r, d: Math.min(...(r.geometry || []).map(g => dist(p, { lat: g.lat, lng: g.lon }))) })).sort((a, b) => a.d - b.d);
  for (const { r, d } of near) {
    const n = r.tags.name;
    if (names.includes(n)) continue;
    if (names.length && d > 45) break; // la segunda solo si también toca el inmueble (esquina)
    names.push(n);
    if (names.length >= 2) break;
  }
  if (!names.length) return [];
  const re = names.map(n => n.replace(/[\\"^$.*+?()[\]{}|]/g, '\\$&')).join('|');
  const els = await overpass(`[out:json][timeout:30];way(around:450,${p.lat},${p.lng})[highway][name~"^(${re})$"];out tags geom;`);
  return names.map(name => {
    const lines = els.filter(e => e.tags.name === name && e.geometry).map(e => e.geometry.map(g => [g.lon, g.lat]));
    const pts = lines.flat().map(([lng, lat]) => ({ lat, lng, d: dist(p, { lat, lng }) }));
    const label = pts.filter(q => q.d > 70 && q.d < 220).sort((x, y) => Math.abs(x.d - 130) - Math.abs(y.d - 130))[0] || pts.sort((x, y) => x.d - y.d)[0];
    return { name, lines, label: label ? { lat: label.lat, lng: label.lng } : null };
  }).filter(s => s.lines.length);
}

// Si Overpass falla: Nominatim devuelve el tramo de la calle más cercana como línea
async function streetFallback(p) {
  try {
    const r = await nominatim(`reverse?format=jsonv2&zoom=17&polygon_geojson=1&lat=${p.lat}&lon=${p.lng}`);
    const g = r && r.geojson;
    if (!g || !/LineString/.test(g.type) || r.category !== 'highway') return [];
    const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    const pts = lines.flat().map(([lng, lat]) => ({ lat, lng, d: dist(p, { lat, lng }) })).sort((a, b) => Math.abs(a.d - 110) - Math.abs(b.d - 110));
    return [{ name: r.name, lines, label: pts[0] ? { lat: pts[0].lat, lng: pts[0].lng } : null }];
  } catch (e) { return []; }
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function offset(p, meters, brg) {
  const d = meters / R, b = rad(brg), la = rad(p.lat), lo = rad(p.lng);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lng: lo2 * 180 / Math.PI };
}
// Nombre de la ciudad: un punto dentro de la ciudad, separado del inmueble, para que el cartel quede
// fijo en el mapa y salga de cuadro solo a medida que la cámara baja
function cityLabelPoint(p, rs) {
  const big = rs.reduce((a, r) => r.length > a.length ? r : a);
  const lats = big.map(c => c[1]), lngs = big.map(c => c[0]);
  const size = Math.min(dist({ lat: Math.min(...lats), lng: lngs[0] }, { lat: Math.max(...lats), lng: lngs[0] }), dist({ lat: lats[0], lng: Math.min(...lngs) }, { lat: lats[0], lng: Math.max(...lngs) }));
  const [sx, sy] = big.reduce(([x, y], [a, b]) => [x + a, y + b], [0, 0]);
  const c = { lng: sx / big.length, lat: sy / big.length };
  const want = Math.max(2500, size * 0.3);
  if (dist(p, c) >= want && inRing(c, big)) return c;
  const b0 = dist(p, c) > 300 ? bearing(p, c) : 180;
  for (const k of [1, 0.75, 0.5]) for (const db of [0, 40, -40, 80, -80, 130, -130, 180]) {
    const q = offset(p, want * k, b0 + db);
    if (rs.some(r => inRing(q, r))) return q;
  }
  return c;
}

// Contornos: ciudad (zoom 10) y barrio (zoom 14, si no 12) desde OpenStreetMap
function rings(g) {
  if (!g) return [];
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map(pl => pl[0]).filter(r => r && r.length >= 4).map(r => r.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]));
}
async function boundaries(p) {
  const get = z => nominatim(`reverse?format=jsonv2&zoom=${z}&polygon_geojson=1&polygon_threshold=0.0004&lat=${p.lat}&lon=${p.lng}`).catch(() => null);
  const out = {};
  const c = await get(10);
  if (c && rings(c.geojson).length) out.city = { name: c.name, rings: rings(c.geojson) };
  for (const z of [14, 12]) {
    const b = await get(z);
    const r = b && rings(b.geojson);
    if (r && r.length && (!out.city || b.name !== out.city.name) && ['suburb', 'neighbourhood', 'quarter', 'city_district', 'borough', 'residential'].includes(b.addresstype)) {
      out.barrio = { name: b.name, rings: r };
      break;
    }
  }
  if (out.city) out.city.label = cityLabelPoint(p, out.city.rings);
  for (const k of ['barrio']) {
    if (!out[k]) continue;
    const big = out[k].rings.reduce((a, r) => r.length > a.length ? r : a);
    const [sx, sy] = big.reduce(([x, y], [a, b]) => [x + a, y + b], [0, 0]);
    out[k].label = { lng: sx / big.length, lat: sy / big.length };
  }
  return out;
}

// Puntos que indica el usuario: uno por línea, "Nombre: link", solo link o solo nombre ("Aeropuerto de Rosario")
async function customPoints(text, p) {
  const out = [];
  for (const raw of String(text || '').split(/\n|;/).map(l => l.trim()).filter(Boolean).slice(0, 8)) {
    let name = raw, link = '';
    const m = raw.match(/^(.*?)[:\-–|]?\s*(https?:\/\/\S+|-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+)\s*$/);
    if (m) { name = m[1].replace(/[:\-–|]\s*$/, '').trim(); link = m[2]; }
    try {
      let q;
      if (link) {
        const r = await resolveLink(link);
        q = { lat: r.lat, lng: r.lng };
        if (!name) name = r.name;
      } else {
        const vb = [p.lng - 0.7, p.lat + 0.6, p.lng + 0.7, p.lat - 0.6].join(',');
        const r = await nominatim(`search?format=jsonv2&limit=5&viewbox=${vb}&q=${encodeURIComponent(raw)}`);
        const best = r.map(x => ({ x, d: dist(p, { lat: +x.lat, lng: +x.lon }) })).sort((a, b) => a.d - b.d)[0];
        if (!best || best.d > 120000) { out.push({ name: raw, error: 'no encontrado' }); continue; }
        q = { lat: +best.x.lat, lng: +best.x.lon };
      }
      out.push({ name: name || 'Punto', lat: q.lat, lng: q.lng, dist: Math.round(dist(p, q)), custom: true });
    } catch (e) { out.push({ name: raw, error: String(e.message || e) }); }
    await new Promise(r => setTimeout(r, 1100)); // política de uso de Nominatim: 1 pedido por segundo
  }
  return out;
}

async function reverse(p) {
  try {
    const r = await nominatim(`reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${p.lat}&lon=${p.lng}`);
    const a = r.address || {};
    return { road: a.road || '', number: a.house_number || '', city: a.city || a.town || a.village || a.municipality || '', state: a.state || '' };
  } catch (e) { return {}; }
}

// Distancia de cámara para que entren todas las ciudades en el cuadro vertical (FOV vertical 60°)
function startRangeFor(p, refs) {
  const tanH = Math.tan(rad(30)) * 1080 / 1920, tanV = Math.tan(rad(30));
  let r = 30000;
  for (const c of refs) {
    const d = c.dist, b = rad(bearing(p, c));
    const dx = Math.abs(d * Math.sin(b)), dy = Math.abs(d * Math.cos(b));
    r = Math.max(r, dx / (tanH * 0.78), dy / (tanV * 0.55));
  }
  return Math.min(Math.round(r), 260000);
}

// Punto al que mira la cámara en la parte amplia: entre el inmueble y la ciudad grande / puntos indicados
function focusOf(p, list) {
  const lat = list.reduce((a, c) => a + c.lat, 0) / list.length, lng = list.reduce((a, c) => a + c.lng, 0) / list.length;
  return { lat: (p.lat + lat) / 2, lng: (p.lng + lng) / 2 };
}

async function prepare(input, opts = {}) {
  const loc = await resolveLink(input);
  const addr = await reverse(loc);
  const macro = macroRefs(loc);
  const bounds = await boundaries(loc);
  const custom = await customPoints(opts.points, loc);
  const okCustom = custom.filter(c => !c.error);
  let micro = { refs: [], frontRoads: [] }, streets = [];
  try { micro = await microRefs(loc); } catch (e) { micro.error = String(e.message || e); }
  try { streets = await streetsFor(loc, micro.frontRoads); } catch (e) { micro.error = (micro.error ? micro.error + ' · ' : '') + String(e.message || e); }
  if (!streets.length) streets = await streetFallback(loc);
  const title = opts.title || loc.name || [addr.road, addr.number].filter(Boolean).join(' ') || 'La propiedad';
  const city = addr.city || (bounds.city && bounds.city.name) || (macro.home && macro.home.name) || '';
  const subtitle = opts.subtitle || [city, addr.state].filter(Boolean).join(', ');
  const base = { lat: loc.lat, lng: loc.lng, title, subtitle, pinLabel: opts.pinLabel || title, accent: opts.accent || '#E4002B', seconds: opts.seconds || 7 };
  // Video 1: ciudades vecinas (máx. 3) + puntos indicados; Video 2: puntos indicados cercanos + lugares de la zona
  const macroList = [...okCustom.filter(c => c.dist > 1500 && c.dist < 90000), ...macro.refs];
  const holdFor = [...okCustom.filter(c => c.dist > 1500 && c.dist < 90000), ...macro.refs.filter(c => c.major)];
  const microCustom = okCustom.filter(c => c.dist <= 1500);
  const microList = [...microCustom, ...micro.refs.filter(r => !microCustom.some(c => dist(c, r) < 80))].slice(0, 6);
  return {
    location: loc, address: addr, custom, microError: micro.error || null,
    macro: { ...base, mode: 'macro', refs: macroList, customRange: holdFor.length ? startRangeFor(focusOf(loc, holdFor), [loc, ...holdFor].map(c => ({ ...c, dist: dist(focusOf(loc, holdFor), c) }))) * 1.15 : null,
      focus: holdFor.length ? focusOf(loc, holdFor) : null, city: bounds.city || null, barrio: bounds.barrio || null, startRange: startRangeFor(loc, macroList), endRange: 2200 },
    // +30 % de distancia respecto de la primera versión (950→1235 m, 700→910 m)
    micro: { ...base, mode: 'micro', refs: microList, streets, range0: 1235, range1: 910, orbitDeg: 60, heading0: 20 },
  };
}

module.exports = { prepare, resolveLink, parseMapsUrl, macroRefs, microRefs, boundaries, customPoints };

if (require.main === module) {
  prepare(process.argv[2], { points: process.argv[3] || '' }).then(j => console.log(JSON.stringify(j, null, 2))).catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
}
