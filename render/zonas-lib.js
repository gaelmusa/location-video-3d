// Videos de zona: de un pedido (spec) a los trabajos de render.
//
// spec = {
//   contexto: 'Ciudad Autónoma de Buenos Aires',        // ciudad donde se buscan las zonas
//   subtitulo: 'Ciudad de Buenos Aires',                // línea chica arriba del video (opcional)
//   videos: [
//     { nombre: 'Gancho 1', zonas: ['Recoleta', 'Palermo', 'Belgrano'] },
//     { nombre: 'Gancho 2', zonas: ['CABA'] },
//     { nombre: 'Gancho 4', zonas: ['Recoleta', { nombre: 'Barrio Norte', limites: ['Av. Córdoba', 'Av. 9 de Julio', 'Av. del Libertador', 'Av. Coronel Díaz'] }, 'Retiro'] },
//     { nombre: 'Cuerpo', zonas: ['Calle Florida', 'Recoleta', 'Palermo', 'Belgrano', 'Av. Cabildo'] },
//   ]
// }
// Cada zona: texto, o { nombre, etiqueta?, tipo?: 'barrio'|'calle'|'ciudad', limites?: [4+ calles en orden] }.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const turf = require('@turf/turf');

const UA = { 'User-Agent': 'location-video-3d/0.1 (+https://github.com/gaelmusa/location-video-3d)', 'Accept-Language': 'es' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- caché y servicios de OpenStreetMap ----------
const CACHE = path.join(os.tmpdir(), 'video-ubicacion-cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) {}
const saveCache = () => { try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch (e) {} };

let lastNominatim = 0;
async function nominatim(q, extra = '') {
  const key = 'n:' + q + extra;
  if (cache[key]) return cache[key];
  const wait = 1100 - (Date.now() - lastNominatim); // política de uso: 1 pedido por segundo
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1' + (extra.includes('limit=') ? '' : '&limit=8') + extra + '&q=' + encodeURIComponent(q), { headers: UA });
  if (!r.ok) throw new Error('Nominatim respondió ' + r.status);
  const j = await r.json();
  cache[key] = j; saveCache();
  return j;
}
let overpassCaido = false; // si falla una vez, el resto del pedido usa Nominatim directo
async function overpass(q) {
  const key = 'o:' + q;
  if (cache[key]) return cache[key];
  if (overpassCaido) return null;
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(urls[i % 3], { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: UA, signal: AbortSignal.timeout(25000) });
      if (r.ok) { const els = (await r.json()).elements; cache[key] = els; saveCache(); return els; }
    } catch (e) {}
  }
  overpassCaido = true;
  return null; // Overpass se cae seguido: el que llama usa Nominatim
}

// ---------- formas "lindas y aproximadas" ----------
function mayor(f) {
  if (f.geometry.type !== 'MultiPolygon') return turf.polygon([f.geometry.coordinates[0]]);
  return f.geometry.coordinates.map(c => turf.polygon([c[0]])).reduce((a, p) => turf.area(p) > turf.area(a) ? p : a);
}
// Sobre el contorno oficial: cierre (rellena muescas) y apertura (borra franjas angostas de vías,
// puerto o costanera) con radio R; queda todo redondeado a esa escala. Se achica un poco para
// que los vecinos no se pisen, se simplifica y se suavizan las esquinas (Chaikin).
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
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- contexto (la ciudad) ----------
const ALIAS = { caba: 'Ciudad Autónoma de Buenos Aires', 'capital federal': 'Ciudad Autónoma de Buenos Aires', 'ciudad de buenos aires': 'Ciudad Autónoma de Buenos Aires' };
async function contexto(nombre) {
  const q = ALIAS[norm(nombre)] || nombre;
  const r = (await nominatim(q)).find(x => /Polygon/.test(x.geojson.type));
  if (!r) throw new Error(`No encontré el contorno de «${nombre}».`);
  const b = r.boundingbox.map(Number); // [s, n, w, e]
  return { nombre: q, feature: turf.feature(r.geojson), bbox: { s: b[0], n: b[1], w: b[2], e: b[3] } };
}
const viewbox = (b, pad = 0) => `&bounded=1&viewbox=${b.w - pad},${b.n + pad},${b.e + pad},${b.s - pad}`;

// ---------- calles ----------
// Variantes del nombre como aparece en OpenStreetMap (Av. → Avenida, Bv. → Bulevar/Boulevard, etc.)
function variantesCalle(n) {
  const base = n.trim().replace(/^calle\s+/i, '');
  const m = base.match(/^(av(?:da)?\.?|avenida|bv\.?|blvd\.?|bulevar|boulevard|pje\.?|pasaje|diag\.?|diagonal)\s+(.+)$/i);
  if (!m) return [base];
  const resto = m[2], t = norm(m[1]).replace('.', '');
  const pref = /^av/.test(t) ? ['Avenida'] : /^(bv|blvd|bulevar|boulevard)/.test(t) ? ['Bulevar', 'Boulevard', 'Bv.'] : /^(pje|pasaje)/.test(t) ? ['Pasaje'] : ['Diagonal'];
  return [...pref.map(p => p + ' ' + resto), resto];
}
const nombreOsmCalle = n => variantesCalle(n)[0];
// Tramos con el mismo nombre en la ciudad: se queda el conjunto conectado más largo
// (descarta calles homónimas en otra punta de la ciudad).
function tramoPrincipal(lines) {
  const ends = lines.map(l => [l[0], l[l.length - 1]]);
  const parent = lines.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const near = (a, b) => turf.distance(a, b, { units: 'meters' }) < 120;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++)
    if (ends[i].some(a => ends[j].some(b => near(a, b)))) parent[find(i)] = find(j);
  const len = {};
  lines.forEach((l, i) => { const r = find(i); len[r] = (len[r] || 0) + turf.length(turf.lineString(l)); });
  const best = Object.keys(len).reduce((a, b) => len[a] > len[b] ? a : b);
  return lines.filter((_, i) => String(find(i)) === best);
}
async function calle(nombre, ctx) {
  const b = ctx.bbox;
  let lines = [];
  for (const osm of variantesCalle(nombre)) {
    const els = await overpass(`[out:json][timeout:40];way(${b.s},${b.w},${b.n},${b.e})[highway][name~"^${osm.replace(/[\\"^$.*+?()[\]{}|]/g, '.')}$",i];out geom;`);
    if (els && els.length) lines = els.filter(e => e.geometry).map(e => e.geometry.map(g => [g.lon, g.lat]));
    if (!lines.length) {
      const r = await nominatim(osm + ', ' + ctx.nombre, '&limit=50' + viewbox(b));
      for (const x of r) if (/LineString/.test(x.geojson.type) && norm(x.name) === norm(osm)) {
        for (const l of (x.geojson.type === 'LineString' ? [x.geojson.coordinates] : x.geojson.coordinates)) lines.push(l);
      }
    }
    if (lines.length) break;
  }
  if (!lines.length) {
    // Nombre incompleto (ej. «Bv. Oroño» → «Bulevar Nicasio Oroño»): la calle más repetida cuyo nombre lo contiene
    const restoTxt = variantesCalle(nombre).slice(-1)[0], resto = norm(restoTxt);
    const r = await nominatim(restoTxt + ', ' + ctx.nombre, '&limit=50' + viewbox(b));
    const cand = r.filter(x => x.category === 'highway' && /LineString/.test(x.geojson.type) && norm(x.name).includes(resto));
    const cuenta = {};
    cand.forEach(x => { cuenta[x.name] = (cuenta[x.name] || 0) + 1; });
    const elegido = Object.keys(cuenta).sort((a, b2) => cuenta[b2] - cuenta[a])[0];
    if (elegido) {
      const r2 = await nominatim(elegido + ', ' + ctx.nombre, '&limit=50' + viewbox(b));
      for (const x of r2.concat(cand)) if (/LineString/.test(x.geojson.type) && x.name === elegido)
        for (const l of (x.geojson.type === 'LineString' ? [x.geojson.coordinates] : x.geojson.coordinates)) lines.push(l);
    }
  }
  if (!lines.length) throw new Error(`No encontré la calle «${nombre}» en ${ctx.nombre}.`);
  lines = tramoPrincipal(lines).map(l => l.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]));
  return { kind: 'calle', lines };
}

// ---------- barrios ----------
const TIPOS_AREA = ['suburb', 'neighbourhood', 'quarter', 'city_district', 'borough', 'city', 'town', 'village', 'municipality', 'county', 'state_district'];
async function barrio(nombre, ctx) {
  const queries = [[nombre + ', ' + ctx.nombre, '&featureType=settlement'], [nombre + ', ' + ctx.nombre, ''], [nombre, viewbox(ctx.bbox, 0.05)]];
  let punto = null;
  for (const [q, extra] of queries) {
    const res = await nominatim(q, extra);
    const pol = res.find(x => TIPOS_AREA.includes(x.addresstype) && /Polygon/.test(x.geojson.type) && norm(x.name) === norm(nombre))
      || res.find(x => TIPOS_AREA.includes(x.addresstype) && /Polygon/.test(x.geojson.type));
    if (pol) {
      const area = turf.area(mayor(turf.feature(pol.geojson)));
      return { kind: 'barrio', rings: [prolijo(turf.feature(pol.geojson), { R: clamp(0.12 * Math.sqrt(area), 180, 360), shrinkM: 60 })] };
    }
    punto = punto || res.find(x => TIPOS_AREA.includes(x.addresstype) || ['quarter', 'neighbourhood'].includes(x.type));
  }
  if (punto) {
    // Sin límites en OpenStreetMap (barrio no oficial): círculo suave de ~800 m alrededor del punto.
    const c = turf.circle([+punto.lon, +punto.lat], 800, { units: 'meters', steps: 48 });
    return { kind: 'barrio', rings: [prolijo(c, { R: 100, tolM: 10 })], aproximado: `«${nombre}» no tiene límites en OpenStreetMap: se dibujó un círculo de 800 m. Para un contorno mejor, indicá sus calles límite.` };
  }
  throw new Error(`No encontré «${nombre}» en ${ctx.nombre}.`);
}

// Zona definida por sus calles límite, en orden (ej. Barrio Norte: Córdoba, 9 de Julio, Libertador, Coronel Díaz).
// Cada calle se ajusta a una recta cerca de la zona; las esquinas son los cruces de calles consecutivas.
async function porLimites(nombre, limites, ctx) {
  let centro = null;
  const r0 = await nominatim(nombre + ', ' + ctx.nombre);
  if (r0[0]) centro = { lat: +r0[0].lat, lng: +r0[0].lon };
  const b = centro ? { s: centro.lat - 0.03, n: centro.lat + 0.03, w: centro.lng - 0.035, e: centro.lng + 0.035 } : ctx.bbox;
  const rectas = [];
  for (const lim of limites) {
    let pts = [];
    for (const osm of variantesCalle(lim)) {
      const res = await nominatim(osm, '&limit=40' + viewbox(b));
      pts = res.filter(x => /LineString/.test(x.geojson.type) && norm(x.name) === norm(osm))
        .flatMap(x => (x.geojson.type === 'LineString' ? [x.geojson.coordinates] : x.geojson.coordinates).flat());
      if (pts.length >= 2) break;
    }
    if (pts.length < 2) throw new Error(`No encontré la calle límite «${lim}» cerca de ${nombre}.`);
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const cl = Math.cos(my * Math.PI / 180);
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) { const dx = (x - mx) * cl, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), k = 0.2;
    rectas.push(turf.lineString([[mx - Math.cos(ang) / cl * k, my - Math.sin(ang) * k], [mx + Math.cos(ang) / cl * k, my + Math.sin(ang) * k]]));
  }
  const ring = rectas.map((r, i) => {
    const x = turf.lineIntersect(r, rectas[(i + 1) % rectas.length]).features[0];
    if (!x) throw new Error(`«${limites[i]}» y «${limites[(i + 1) % limites.length]}» no se cruzan: revisá el orden de las calles límite.`);
    return x.geometry.coordinates;
  });
  ring.push(ring[0]);
  return { kind: 'barrio', rings: [prolijo(turf.polygon([ring]), { R: 250, shrinkM: 40, tolM: 10 })], aproximado: `«${nombre}» se dibujó aproximado entre ${limites.join(', ')}.` };
}

async function ciudad(ctx) {
  const area = turf.area(mayor(ctx.feature));
  return { kind: 'barrio', rings: [prolijo(ctx.feature, { R: clamp(0.04 * Math.sqrt(area), 300, 900), tolM: 120 })] };
}

function tipoDe(z, ctx) {
  if (z.tipo) return z.tipo;
  if (z.limites && z.limites.length >= 3) return 'limites';
  if (/^(calle|av\.?|avda\.?|avenida|pasaje|pje\.?|bv\.?|boulevard|bulevar|diagonal|autopista|ruta)\s/i.test(z.nombre)) return 'calle';
  if (norm(ALIAS[norm(z.nombre)] || z.nombre) === norm(ctx.nombre)) return 'ciudad';
  return 'barrio';
}

async function resolver(zona, ctx) {
  const z = typeof zona === 'string' ? { nombre: zona } : { ...zona };
  z.nombre = String(z.nombre || '').trim();
  if (!z.nombre) throw new Error('Hay una zona sin nombre.');
  const tipo = tipoDe(z, ctx);
  let geo;
  if (tipo === 'calle') geo = await calle(z.nombre, ctx);
  else if (tipo === 'ciudad') geo = await ciudad(ctx);
  else if (tipo === 'limites') geo = await porLimites(z.nombre, z.limites, ctx);
  else geo = await barrio(z.nombre, ctx);
  const etiqueta = z.etiqueta || (tipo === 'calle' ? z.nombre.replace(/^calle\s+/i, '').replace(/^avenida\s+/i, 'Av. ') : z.nombre);
  return { ...geo, label: etiqueta };
}

// ---------- cámara ----------
const centroid = rings => { const c = turf.centroid(turf.multiPoint(rings.flat())).geometry.coordinates; return { lng: c[0], lat: c[1] }; };
const extentM = rings => { const b = turf.bbox(turf.multiPoint(rings.flat())); return Math.max(turf.distance([b[0], b[1]], [b[2], b[1]], { units: 'meters' }), turf.distance([b[0], b[1]], [b[0], b[3]], { units: 'meters' })) / 2; };
// distancia de cámara para que la zona entre de ancho en el cuadro vertical (medio ancho ≈ 0,33 × distancia)
const fitRange = (ext, k = 1) => Math.max(2600, ext / 0.33 * 0.8 * k);

// Inclinación según el tamaño: zonas chicas en vista de pájaro (-60°), zonas grandes (una ciudad)
// casi cenitales (-76°), para que se vean enteras.
const pitchPara = ext => -60 - 16 * clamp((ext - 1500) / (6000 - 1500), 0, 1);
const distM = (a, b) => turf.distance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' });

function armarVideo(zonas, { subtitulo = '', segundos = 7, acento = '#C9A45C' } = {}) {
  const n = zonas.length;
  const ts = n === 1 ? [0.75] : n === 2 ? [0.4, 0.86] : zonas.map((_, i) => +(0.28 + 0.62 * i / (n - 1)).toFixed(3));
  const zs = zonas.map((z, i) => {
    const geo = z.rings || z.lines;
    const c = centroid(geo);
    let labelPt = c;
    if (z.rings) { const p = turf.centerOfMass(turf.polygon([z.rings[0]])).geometry.coordinates; labelPt = { lng: p[0], lat: p[1] }; }
    return { kind: z.kind, label: z.label, rings: z.rings || null, lines: z.lines || null, labelPt, t: ts[i], center: c, ext: extentM(geo) };
  });
  const all = zs.flatMap(z => z.rings || z.lines);
  const c = centroid(all);
  const step = n === 1 ? 5 : n >= 5 ? 4 : 7, h0 = -12;
  // Arranque: desde bien alto y cenital. Una sola zona grande (ciudad): el arranque muestra la región entera.
  const r0 = n === 1 ? fitRange(zs[0].ext) * (zs[0].ext > 4000 ? 4.2 : 2.8) : fitRange(extentM(all), 1.45);
  const keys = [{ t: 0, lat: c.lat, lng: c.lng, range: r0, pitch: -89, heading: h0 }];
  // 1) un punto de paso por zona, a la altura justa para verla entera
  const zk = zs.map((z, i) => ({ t: z.t, lat: z.center.lat, lng: z.center.lng, range: fitRange(z.ext, z.kind === 'calle' ? 0.95 : z.ext > 4000 ? 1.3 : 1.1), pitch: pitchPara(z.ext), heading: h0 + step * (i + 1), z }));
  // 2) nunca más bajo que lo que hay que recorrer para llegar o para irse: si hay que trasladarse
  //    muchos kilómetros, se muestra desde más arriba en vez de moverse rápido cerca del suelo
  zk.forEach((k, i) => {
    const desde = i === 0 ? keys[0] : zk[i - 1], hasta = zk[i + 1];
    const viaje = Math.max(distM(desde, k), hasta ? distM(k, hasta) : 0);
    const minimo = Math.min(viaje * 0.9, k.range * 3);
    if (minimo > k.range) { k.range = minimo; k.pitch = Math.min(k.pitch, -66); }
  });
  // 3) entre dos zonas que igual quedan lejos, la cámara sube hasta ver las dos y después baja
  zk.forEach((k, i) => {
    if (i > 0) {
      const prev = keys[keys.length - 1], a = zk[i - 1].z, d = distM(a.center, k.z.center);
      const ambas = fitRange(d / 2 + Math.max(a.ext, k.z.ext) * 0.7, 1.1);
      if (ambas > 1.5 * Math.max(prev.range, k.range)) {
        keys.push({ t: +((prev.t + k.t) / 2).toFixed(3), lat: (a.center.lat + k.z.center.lat) / 2, lng: (a.center.lng + k.z.center.lng) / 2, range: ambas, pitch: -80, heading: (prev.heading + k.heading) / 2 });
      }
    }
    const { z, ...key } = k;
    keys.push(key);
  });
  const k = keys[keys.length - 1];
  if (k.t < 1) keys.push({ ...k, t: 1, range: k.range * (n === 1 ? 0.96 : 0.92), heading: k.heading + step * 0.6 });
  return { mode: 'zonas', lat: c.lat, lng: c.lng, seconds: segundos, accent: acento, title: '', subtitle: subtitulo, pinLabel: null, zones: zs.map(({ center, ext, ...z }) => z), keys };
}

const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'video';

// spec → [{ archivo, job }], más avisos (zonas aproximadas)
async function preparar(spec) {
  if (!spec || !Array.isArray(spec.videos) || !spec.videos.length) throw new Error('El pedido no tiene videos.');
  if (spec.videos.length > 12) throw new Error('Máximo 12 videos por pedido.');
  const ctx = await contexto(spec.contexto || 'Ciudad Autónoma de Buenos Aires');
  const memo = {}, avisos = [];
  const out = [];
  for (const [i, v] of spec.videos.entries()) {
    if (!Array.isArray(v.zonas) || !v.zonas.length) throw new Error(`El video «${v.nombre || i + 1}» no tiene zonas.`);
    if (v.zonas.length > 6) throw new Error(`El video «${v.nombre || i + 1}» tiene más de 6 zonas.`);
    const zonas = [];
    for (const z of v.zonas) {
      const key = JSON.stringify(z);
      if (!memo[key]) { memo[key] = await resolver(z, ctx); if (memo[key].aproximado) avisos.push(memo[key].aproximado); }
      zonas.push(memo[key]);
    }
    const nombre = v.nombre || zonas.map(z => z.label).join(' - ');
    const sub = v.subtitulo ?? (zonas.length === 1 && tipoDe(typeof v.zonas[0] === 'string' ? { nombre: v.zonas[0] } : v.zonas[0], ctx) === 'ciudad' ? '' : (spec.subtitulo ?? ''));
    // Con nombre propio (ej. «Hook 4 - Recoleta…») el archivo lleva ese nombre tal cual; sin nombre, se numera
    let base = (v.nombre ? nombre : `${String(i + 1).padStart(2, '0')} ${nombre}`).replace(/[\\/:*?"<>|]/g, '-').slice(0, 86);
    while (out.some(o => o.archivo === base + '.mp4')) base += ' (2)';
    out.push({ archivo: base + '.mp4', slug: slug(nombre), job: armarVideo(zonas, { subtitulo: sub, segundos: v.segundos || spec.segundos || 7 }) });
  }
  return { videos: out, avisos: [...new Set(avisos)] };
}

module.exports = { preparar, resolver, contexto, armarVideo };
