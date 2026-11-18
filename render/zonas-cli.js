// Videos de zona.
//   Local (esta Mac):   node render/zonas-cli.js pedido.json carpeta-salida
//   GitHub, paso 1:     node render/zonas-cli.js preparar   (lee SPEC, escribe salida/zonas.json y la lista de índices)
//   GitHub, paso 2:     node render/zonas-cli.js render 3   (renderiza el video 3 de salida/zonas.json)
'use strict';
require('./env');
const fs = require('fs');
const path = require('path');
const { preparar } = require('./zonas-lib');
const { render } = require('./render');

const token = () => {
  if (!process.env.CESIUM_ION_TOKEN) throw new Error('Falta CESIUM_ION_TOKEN (archivo .env o secreto de GitHub).');
  return process.env.CESIUM_ION_TOKEN;
};

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const salida = path.resolve('salida');

  if (cmd === 'preparar') {
    fs.mkdirSync(salida, { recursive: true });
    const info = { ok: false };
    try {
      const p = await preparar(JSON.parse(process.env.SPEC || '{}'));
      fs.writeFileSync(path.join(salida, 'zonas.json'), JSON.stringify(p));
      Object.assign(info, { ok: true, avisos: p.avisos, videos: p.videos.map(v => v.archivo) });
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `indices=${JSON.stringify(p.videos.map((_, i) => i))}\n`);
      console.log('Videos:', info.videos.join(' | '), info.avisos.length ? '\nAvisos: ' + info.avisos.join(' ') : '');
    } catch (e) {
      info.error = String(e.message || e);
      console.error('ERROR: ' + info.error);
      process.exitCode = 1;
    }
    fs.writeFileSync(path.join(salida, 'info.json'), JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === 'render') {
    const p = JSON.parse(fs.readFileSync(path.join(salida, 'zonas.json'), 'utf8'));
    const v = p.videos[+arg];
    if (!v) throw new Error('No existe el video ' + arg);
    const dir = path.join(salida, 'video');
    fs.mkdirSync(dir, { recursive: true });
    await render({ ...v.job, ionToken: token() }, path.join(dir, v.archivo), m => console.log(`[${+arg + 1}] ${m}`));
    return;
  }

  // Local: pedido.json → todos los videos en la carpeta indicada
  if (!cmd) throw new Error('Uso: node render/zonas-cli.js pedido.json carpeta-salida');
  const spec = JSON.parse(fs.readFileSync(cmd, 'utf8'));
  const dir = path.resolve(arg || 'videos-zonas');
  fs.mkdirSync(dir, { recursive: true });
  const p = await preparar(spec);
  for (const a of p.avisos) console.log('AVISO: ' + a);
  for (const v of p.videos) {
    const t0 = Date.now();
    await render({ ...v.job, ionToken: token() }, path.join(dir, v.archivo), () => {});
    console.log(`LISTO: ${path.join(dir, v.archivo)} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}

main().catch(e => { console.error('ERROR: ' + (e.message || e)); process.exit(1); });
