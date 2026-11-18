// Trabajo completo: link → 2 videos en ./salida (lo corre GitHub Actions).
// Variables: LINK (obligatoria), TITULO, CESIUM_ION_TOKEN
'use strict';
require('./env');
const fs = require('fs');
const path = require('path');
const { prepare } = require('./prepare');
const { render } = require('./render');

const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, ' ').slice(0, 60) || 'Propiedad';

(async () => {
  const outDir = path.resolve('salida');
  fs.mkdirSync(outDir, { recursive: true });
  const info = { ok: false, link: process.env.LINK };
  try {
    const p = await prepare(process.env.LINK, { title: process.env.TITULO || '', points: process.env.PUNTOS || '' });
    Object.assign(info, { location: p.location, address: p.address, macroRefs: p.macro.refs, microRefs: p.micro.refs, microError: p.microError, custom: p.custom, city: p.macro.city && p.macro.city.name, barrio: p.macro.barrio && p.macro.barrio.name, streets: p.micro.streets.map(s => s.name) });
    const name = slug(p.macro.title);
    const token = process.env.CESIUM_ION_TOKEN;
    let files = [[p.macro, `${name} - Ubicacion 50 km.mp4`], [p.micro, `${name} - Entorno.mp4`]];
    // VIDEO=macro o VIDEO=micro: cada servidor de GitHub hace uno solo, en paralelo
    if (process.env.VIDEO) files = files.filter(([j]) => j.mode === process.env.VIDEO);
    info.files = [];
    for (const [job, file] of files) {
      const t0 = Date.now();
      await render({ ...job, ionToken: token }, path.join(outDir, file), m => console.log(`[${job.mode}] ${m}`));
      info.files.push({ file, seconds: Math.round((Date.now() - t0) / 1000) });
    }
    info.ok = true;
  } catch (e) {
    info.error = String(e && e.message || e);
    console.error('ERROR: ' + info.error);
    process.exitCode = 1;
  }
  fs.writeFileSync(path.join(outDir, 'info.json'), JSON.stringify(info, null, 2));
})();
