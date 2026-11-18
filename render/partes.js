// Render en partes paralelas (GitHub Actions): cada video se divide en tramos de cuadros que generan
// servidores distintos al mismo tiempo, y al final se unen. Sin placa de video, un video entero tarda
// 20–30 min; partido en 6 tarda lo que tarda un tramo.
//
//   node render/partes.js preparar propiedad   (LINK, TITULO, PUNTOS)  → salida/trabajo.json, matrices
//   node render/partes.js preparar zonas       (SPEC)                  → salida/trabajo.json, matrices
//   node render/partes.js parte V P            → salida/partes/V-P.mp4  (video V, parte P)
//   node render/partes.js unir V               → salida/final/<archivo del video V>
'use strict';
require('./env');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SALIDA = path.resolve('salida');
const TRABAJO = path.join(SALIDA, 'trabajo.json');
const FPS = 30;
const MAX_TRABAJOS = 18; // servidores a la vez por pedido (GitHub permite 20 en paralelo)

const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Propiedad';
const salidaGH = (k, v) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${JSON.stringify(v)}\n`); };

async function preparar(tipo) {
  fs.mkdirSync(SALIDA, { recursive: true });
  const pedido = process.env.PEDIDO || 'manual';
  const info = { ok: false, tipo };
  let videos = [];
  try {
    if (tipo === 'propiedad') {
      const { prepare } = require('./prepare');
      const p = await prepare(process.env.LINK, { title: process.env.TITULO || '', points: process.env.PUNTOS || '' });
      Object.assign(info, { location: p.location, address: p.address, macroRefs: p.macro.refs, microRefs: p.micro.refs, custom: p.custom, streets: p.micro.streets.map(s => s.name) });
      const name = slug(p.macro.title);
      videos = [
        { archivo: `${name} - Ubicacion 50 km.mp4`, artifact: `macro-${pedido}`, job: p.macro },
        { archivo: `${name} - Entorno.mp4`, artifact: `micro-${pedido}`, job: p.micro },
      ];
    } else {
      const { preparar: prepZonas } = require('./zonas-lib');
      const p = await prepZonas(JSON.parse(process.env.SPEC || '{}'));
      info.avisos = p.avisos;
      videos = p.videos.map((v, i) => ({ archivo: v.archivo, artifact: `video-${pedido}-${i}`, job: v.job }));
    }
    const partes = Math.max(1, Math.min(6, Math.floor(MAX_TRABAJOS / videos.length)));
    const n = v => Math.round((v.job.seconds || 7) * FPS);
    const tramos = videos.map(v => Array.from({ length: partes }, (_, k) => [Math.round(k * n(v) / partes), Math.round((k + 1) * n(v) / partes)]));
    fs.writeFileSync(TRABAJO, JSON.stringify({ videos, tramos }));
    Object.assign(info, { ok: true, videos: videos.map(v => v.archivo), partes, cuadros: videos.reduce((a, v) => a + n(v), 0) });
    salidaGH('partes', videos.flatMap((_, v) => tramos[v].map((_, p) => ({ v, p }))));
    salidaGH('videos', videos.map((x, v) => ({ v, artifact: x.artifact })));
    console.log(`${videos.length} video(s) × ${partes} parte(s): ${videos.map(v => v.archivo).join(' | ')}`);
  } catch (e) {
    info.error = String(e.message || e);
    console.error('ERROR: ' + info.error);
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(SALIDA, 'info.json'), JSON.stringify(info, null, 2));
}

async function parte(v, p) {
  const { render } = require('./render');
  const { videos, tramos } = JSON.parse(fs.readFileSync(TRABAJO, 'utf8'));
  const [desde, hasta] = tramos[v][p];
  const dir = path.join(SALIDA, 'partes');
  fs.mkdirSync(dir, { recursive: true });
  if (!process.env.CESIUM_ION_TOKEN) throw new Error('Falta CESIUM_ION_TOKEN');
  await render({ ...videos[v].job, ionToken: process.env.CESIUM_ION_TOKEN }, path.join(dir, `${v}-${p}.mp4`),
    m => console.log(`[${v}-${p}] ${m}`), { desde, hasta, pedido: process.env.PEDIDO, clave: `${v}-${p}` });
}

function unir(v) {
  let FFMPEG = 'ffmpeg';
  try { FFMPEG = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}
  const { videos, tramos } = JSON.parse(fs.readFileSync(TRABAJO, 'utf8'));
  const dir = path.join(SALIDA, 'partes');
  const lista = tramos[v].map((_, p) => path.join(dir, `${v}-${p}.mp4`));
  const falta = lista.filter(f => !fs.existsSync(f));
  if (falta.length) throw new Error('Faltan partes: ' + falta.map(f => path.basename(f)).join(', '));
  const txt = path.join(dir, `lista-${v}.txt`);
  fs.writeFileSync(txt, lista.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const final = path.join(SALIDA, 'final');
  fs.mkdirSync(final, { recursive: true });
  const out = path.join(final, videos[v].archivo);
  // Las partes tienen la misma codificación: se pegan sin volver a comprimir
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('No se pudieron unir las partes del video ' + v);
  console.log('LISTO: ' + out);
}

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'preparar') await preparar(a);
  else if (cmd === 'parte') await parte(+a, +b);
  else if (cmd === 'unir') unir(+a);
  else throw new Error('Uso: partes.js preparar propiedad|zonas | parte V P | unir V');
})().catch(e => { console.error('ERROR: ' + (e.message || e)); process.exit(1); });
