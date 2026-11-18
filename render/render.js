// Renderiza un video vertical 1080x1920 cuadro por cuadro con Chromium sin pantalla + ffmpeg.
// Uso: node render/render.js job.json salida.mp4
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const FPS = 30;
// ffmpeg viene con el motor (paquete ffmpeg-static); si no está, se usa el del sistema
let FFMPEG = 'ffmpeg';
try { FFMPEG = require('ffmpeg-static') || 'ffmpeg'; } catch (e) {}

// Avance opcional: si PROGRESS_URL está definida, cada parte informa cuántos cuadros lleva (GET ?fn=avance&args=[...])
const API_APP = process.env.PROGRESS_URL || '';
function informarAvance(pedido, clave, hechos, total) {
  if (!API_APP || !pedido || pedido === 'manual') return;
  const args = encodeURIComponent(JSON.stringify([pedido, clave, hechos, total]));
  fetch(`${API_APP}?fn=avance&args=${args}`, { redirect: 'follow', signal: AbortSignal.timeout(20000) }).catch(() => {});
}

function serve(dir) {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const f = path.join(dir, path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, ''));
      fs.readFile(f, (err, buf) => {
        if (err) { rsp.writeHead(404); return rsp.end(); }
        rsp.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        rsp.end(buf);
      });
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

function chromeArgs() {
  const a = ['--window-size=1080,1920', '--hide-scrollbars', '--ignore-gpu-blocklist', '--enable-webgl'];
  if (process.platform === 'linux' || process.env.RENDER_CPU) a.push('--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  return a;
}

// opts: { desde, hasta } para generar solo un tramo de cuadros (partes en paralelo);
//       { pedido, clave } para informar el avance a la app
async function render(job, out, log = console.log, opts = {}) {
  const srv = await serve(__dirname);
  const browser = await puppeteer.launch({ headless: true, args: chromeArgs(), protocolTimeout: 600000 });
  const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-maxrate', '24M', '-bufsize', '48M', '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p', '-color_range', 'tv', '-r', String(FPS), '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res, rej) => ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg salió con código ' + c))));
  try {
    const page = await browser.newPage();
    page.on('console', m => { if (!/favicon|404/.test(m.text())) log('[page] ' + m.text()); });
    page.on('pageerror', e => log('[page error] ' + e.message));
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${srv.address().port}/page.html`, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas').getContext('webgl2');
      const d = c && c.getExtension('WEBGL_debug_renderer_info');
      return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : (c ? 'webgl2' : 'sin webgl2');
    });
    log('GPU: ' + gl);
    const info = await page.evaluate(c => window.setup(c), { ...job, cpu: process.platform === 'linux' || !!process.env.RENDER_CPU });
    log('altura del suelo: ' + info.groundH.toFixed(1) + ' m');
    const n = Math.round((job.seconds || 7) * FPS);
    const desde = Math.max(0, opts.desde || 0), hasta = Math.min(n, opts.hasta ?? n);
    // Una parte que no empieza en el cuadro 0 recorre antes los cuadros previos sin dibujar el mapa,
    // solo para que los carteles lleguen con el mismo estado que en el video entero.
    if (desde > 0) await page.evaluate((d, n) => { for (let i = 0; i < d; i++) window.preframe(i / (n - 1)); }, desde, n);
    const t0 = Date.now();
    let slow = 0;
    for (let i = desde; i < hasta; i++) {
      const ok = await page.evaluate(t => window.frame(t), i / (n - 1));
      if (!ok) slow++;
      const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
      if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r));
      const hechos = i - desde + 1;
      if (hechos % 15 === 1 || i === hasta - 1) log(`cuadro ${i + 1}/${n} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      if (hechos % 5 === 0 || i === hasta - 1) informarAvance(opts.pedido, opts.clave, hechos, hasta - desde);
    }
    if (slow) log(`aviso: ${slow} cuadros no terminaron de cargar a tiempo`);
    ff.stdin.end();
    await ffDone;
  } finally {
    await browser.close();
    srv.close();
  }
}

module.exports = { render };

if (require.main === module) {
  require('./env');
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  job.ionToken = job.ionToken || process.env.CESIUM_ION_TOKEN;
  render(job, process.argv[3] || 'salida.mp4').catch(e => { console.error(e); process.exit(1); });
}
