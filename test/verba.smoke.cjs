'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Verba — humo
   Monta la app de verdad (el mismo ipc, el mismo motor, el mismo renderer)
   sobre una carpeta de datos propia que se borra al terminar, la recorre y
   mide. No toca tu data/.

     npm run smoke
     npm run smoke -- --capturas <carpeta>     deja un PNG de cada vista
     VERBA_HUMO_AUDIO=<audio> npm run smoke    además transcribe ese audio con
                                               Whisper de verdad (tarda)

   La ventana va offscreen: no aparece en pantalla.
   ═══════════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'verba-humo-'));
process.env.VERBA_DATA = path.join(DIR, 'data');
const RAIZ = path.join(__dirname, '..');
const REAL = process.env.VERBA_HUMO_AUDIO || '';
const iCap = process.argv.indexOf('--capturas');
const CAPTURAS = iCap > 0 ? process.argv[iCap + 1] : null;

const { app, BrowserWindow } = require('electron');

/* ── Los datos de la prueba ──────────────────────────────────────────────── */
const AUDIO = path.join(DIR, 'clase de prueba.wav');
function wavMudo(seg) {
  const n = 8000 * seg, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * 6000 * Math.abs(Math.sin(i / 2600))), 44 + i * 2);
  return b;
}
const seg = (s, e, t, lp = -0.12, cr = 1.5) => ({ s, e, t, lp, ns: 0.02, cr });
const SEGS = [
  seg(0, 28, 'Bueno, arrancamos con sistema adrenérgico. Hoy vamos con los fármacos que actúan sobre esa vía.'),
  seg(28, 58, 'La reserfina bloquea el transportador vesicular de monoaminas, el VMAT.'),
  seg(58, 90, 'Por eso la reserfina baja la presión.'),
  seg(90, 120, 'Del otro lado tienen a los inhibidores de la MAO.'),
  seg(120, 122, 'Gracias.', -1.1),
  seg(122, 180, '¿Y el propranolol dónde entra, profe?', -0.92),
];
function sembrar() {
  fs.mkdirSync(path.join(process.env.VERBA_DATA, 'clases'), { recursive: true });
  fs.writeFileSync(AUDIO, wavMudo(180));
  const w = (f, o) => fs.writeFileSync(path.join(process.env.VERBA_DATA, f), JSON.stringify(o, null, 2));
  // un `vidrio` guardado de cuando existía el acrílico: tiene que ignorarse
  w('settings.json', { schema: 1, vidrio: 'acrilico' });
  w('vocabularios.json', { materias: { Medicinal: { terminos: 'reserpina, VMAT, MAO', correcciones: [{ de: 'reserfina', a: 'reserpina' }] }, Farmaco: { terminos: '', correcciones: [] }, Nosia: { terminos: '', correcciones: [] } } });
  w('clases/c-0001.json', {
    id: 'c-0001', nombre: 'Sistema adrenérgico', archivo: 'clase de prueba.wav', audio: AUDIO, materia: 'Medicinal',
    terminos: 'reserpina, VMAT', estado: 'lista', creado: 1, terminado: Date.now() - 86400000, dur: 180, tardo: 9.5, modelo: 'large-v3-turbo',
    calidad: { alta: 67, bucles: 0, inventos: 1 }, segs: SEGS, picos: Array.from({ length: 600 }, (_, i) => Math.round(40 + 200 * Math.abs(Math.sin(i / 7) * Math.sin(i / 53)))),
  });
  // una que va a fallar sola: su audio no existe
  w('clases/c-0002.json', { id: 'c-0002', nombre: 'Audio perdido', archivo: 'no-esta.mp3', audio: path.join(DIR, 'no-esta.mp3'), materia: 'Farmaco', terminos: '', estado: 'cola', creado: 2, dur: 60 });
}

/* ── El arnés ────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const ok = (nombre, cond, detalle = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? 'ok  ' : 'FALLA'} ${nombre}${cond || !detalle ? '' : ` → ${detalle}`}`); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  sembrar();
  const ipc = require(path.join(RAIZ, 'src', 'ipc.cjs'));
  const motor = require(path.join(RAIZ, 'src', 'motor.cjs'));
  ipc.register();
  const win = new BrowserWindow({
    width: 1280, height: 820, show: false, frame: false, backgroundColor: '#0a0a0a',
    webPreferences: { preload: path.join(RAIZ, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  const errores = [];
  win.webContents.on('console-message', (e) => { if (e.level >= 2 || e.level === 'error' || e.level === 'warning') errores.push(e.message); });
  await win.loadFile(path.join(RAIZ, 'renderer', 'index.html'));
  const js = (codigo) => win.webContents.executeJavaScript(`(async () => { ${codigo} })()`);
  const hasta = async (cond, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(`return !!(${cond})`)) return true; await espera(60); } return false; };
  const foto = async (nombre) => { if (!CAPTURAS) return; fs.mkdirSync(CAPTURAS, { recursive: true }); await espera(700); fs.writeFileSync(path.join(CAPTURAS, `${nombre}.png`), (await win.webContents.capturePage()).toPNG()); };
  const tocar = (sel) => js(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
    for (const t of ['pointerdown', 'pointerup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); return true;`);

  await motor.init((ev) => { if (!win.isDestroyed()) win.webContents.send('verba:ev', ev); });
  // Si un paso revienta, el humo igual termina y dice dónde: nunca queda colgado.
  const fin = setTimeout(() => { console.log('\nFALLA el humo no terminó en 6 minutos'); app.exit(1); }, 360000);
  try {

  console.log('\n1. Arranque');
  ok('el splash se va', await hasta(`!document.getElementById('boot-splash')`));
  ok('la marca de la titlebar es el ícono', await js(`return document.querySelector('.op-titlebar .vb-marca path')?.getAttribute('d')?.startsWith('M16 27')`));
  ok('y va sin baldosa: solo las barras', await js(`const m = document.querySelector('.op-titlebar .vb-marca'); return !m.querySelector('rect, circle') && m.getAttribute('viewBox') === '11 11 42 42'`));
  ok('abre en la Cola: hay algo esperando', await hasta(`document.querySelector('#view #cola-filas')`));

  console.log('\n2. La cola');
  ok('el audio que no existe falla solo y lo dice', await hasta(`document.querySelector('#view .vb-fila__error')?.textContent.includes('ya no está')`, 8000),
    await js(`return document.querySelector('#view #cola-filas')?.textContent.trim().slice(0, 160)`));
  ok('Piezas no aparece fuera de --dev', await js(`return getComputedStyle(document.getElementById('nav-piezas')).display === 'none'`));
  // Un <button> sin `border: 0` hereda el biselado de Chromium: se ve como un marco blanco.
  ok('ningún botón propio lleva el borde de fábrica', await js(`return [...document.querySelectorAll('button')].filter((b) => getComputedStyle(b).borderTopWidth !== '0px').map((b) => b.className || b.id).join(', ')`)
    .then((t) => (t ? (console.log('     ' + t), false) : true)));
  ok('el contador del rail no cuenta lo que falló', await js(`return document.getElementById('n-cola').textContent.trim() === ''`));
  await foto('1-cola');

  console.log('\n3. La biblioteca');
  await tocar('#nav-biblioteca');
  ok('lista la transcripción guardada', await hasta(`document.querySelectorAll('#view #bib-filas .vb-fila').length === 1`));
  ok('con su confianza', await js(`return document.querySelector('#view .vb-calmini b').textContent.trim() === '67 %'`));
  const railGrupos = await js(`return [...document.querySelectorAll('#rail-grupos .op-navitem')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).join('|')`);
  ok('los grupos del rail llevan su cuenta', railGrupos.replace(/ /g, '') === 'Medicinal1|Farmaco', railGrupos);
  await foto('2-biblioteca');
  await tocar('#rail-grupos [data-grupo="Farmaco"]');
  ok('filtrar por un grupo sin transcripciones lo dice', await hasta(`document.querySelector('#view #bib-vacia')?.textContent.includes('No hay transcripciones en Farmaco')`));
  await tocar('#nav-biblioteca');
  await hasta(`document.querySelectorAll('#view #bib-filas .vb-fila').length === 1`);

  console.log('\n4. Leer una transcripción');
  await tocar('#view #bib-filas .vb-fila');
  ok('abre la lectura', await hasta(`document.querySelectorAll('#view #texto .vb-par').length > 0`));
  const horas = await js(`return [...document.querySelectorAll('#view .vb-par__hora')].map((h) => h.textContent).join(',')`);
  ok('párrafos con su minuto', horas === '0:00,0:58,2:00', horas);
  ok('los botones de la lectura tampoco llevan el borde de fábrica', await js(`return [...document.querySelectorAll('button')].filter((b) => getComputedStyle(b).borderTopWidth !== '0px').map((b) => b.className || b.id).join(', ')`)
    .then((t) => (t ? (console.log('     ' + t), false) : true)));
  ok('las dos correcciones del vocabulario, marcadas', await js(`return [...document.querySelectorAll('#view .vb-fx')].map((x) => x.textContent).join(',') === 'reserpina,reserpina'`));
  ok('el invento, tachado', await js(`return document.querySelector('#view .vb-inv')?.textContent === 'Gracias.'`));
  ok('el tramo de confianza baja, avisado', await js(`return document.querySelectorAll('#view .vb-par.es-baja .vb-nota').length === 1`));
  ok('el panel y el reproductor se prenden', await js(`const a = document.querySelector('.op-app').classList; return a.contains('con-panel') && a.contains('con-composer')`));
  ok('el panel lista la corrección con sus minutos', await hasta(`[...document.querySelectorAll('#panel .vb-min')].map((b) => b.textContent).join(',') === '0:28,0:58'`),
    await js(`return document.querySelector('#panel')?.textContent.replace(/\\s+/g, ' ').slice(0, 200)`));
  ok('el audio carga desde el disco', await hasta(`document.getElementById('pl-audio').readyState >= 1`, 8000), await js(`const a = document.getElementById('pl-audio'); return a.src + ' ' + a.error?.message`));
  ok('la onda está dibujada', await js(`const c = document.getElementById('pl-onda'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 500`));
  await foto('3-clase');

  console.log('\n5. Moverse por el audio');
  await tocar('#panel .vb-min:last-child');
  ok('un minuto del panel lleva el audio ahí', await hasta(`Math.abs(document.getElementById('pl-audio').currentTime - 58) < 1`), await js(`return document.getElementById('pl-audio').currentTime`));
  ok('y prende ese párrafo', await hasta(`document.querySelector('#view .vb-par.is-suena .vb-par__hora')?.textContent === '0:58'`));
  await js(`document.getElementById('pl-audio').pause()`);

  console.log('\n6. Una corrección nueva');
  await js(`document.querySelector('#panel #pn-de').value = 'profe'; document.querySelector('#panel #pn-a').value = 'profesor';`);
  await tocar('#panel [data-action="agregar-corr"]');
  ok('aparece aplicada en el texto', await hasta(`[...document.querySelectorAll('#view .vb-fx')].some((x) => x.textContent === 'profesor')`));
  ok('y queda en el vocabulario del grupo', JSON.parse(fs.readFileSync(path.join(process.env.VERBA_DATA, 'vocabularios.json'), 'utf8')).grupos.Medicinal.correcciones.some((c) => c.de === 'profe' && c.a === 'profesor'));

  console.log('\n7. Exportar');
  const r = await js(`return await window.opal.verba.exportar('c-0001', 'md', false)`);
  const md = fs.existsSync(r.ruta) ? fs.readFileSync(r.ruta, 'utf8') : '';
  ok('el .md queda al lado del audio', path.dirname(r.ruta) === DIR && md.startsWith('# Sistema adrenérgico'), r.ruta);
  ok('con las correcciones y sin el invento en el texto', md.includes('| reserfina | reserpina | 0:28, 0:58 |') && !md.split('## Correcciones')[0].includes('Gracias'));
  ok('la segunda vez avisa que ya existe', (await js(`return await window.opal.verba.exportar('c-0001', 'md', false)`)).existe === true);

  console.log('\n8. Vocabularios y ajustes');
  await tocar('.op-navitem[data-view="vocabularios"]');
  ok('una tarjeta por grupo', await hasta(`document.querySelectorAll('#view .vb-voc').length === 2`));
  /* Los datos sembrados son de la 0.1: «materias» en el vocabulario y «materia»
     en cada audio. Tienen que haber pasado a grupos, sin las de fábrica vacías. */
  const vocabDisco = JSON.parse(fs.readFileSync(path.join(process.env.VERBA_DATA, 'vocabularios.json'), 'utf8'));
  ok('las materias de la 0.1 pasaron a grupos', !!vocabDisco.grupos && !('materias' in vocabDisco) && Object.keys(vocabDisco.grupos).join(',') === 'Medicinal,Farmaco', JSON.stringify(Object.keys(vocabDisco.grupos || {})));
  const claseDisco = JSON.parse(fs.readFileSync(path.join(process.env.VERBA_DATA, 'clases', 'c-0001.json'), 'utf8'));
  ok('y cada audio lleva su grupo', claseDisco.grupo === 'Medicinal' && !('materia' in claseDisco));
  await js(`await window.opal.verba.renombrarGrupo('Farmaco', 'Clientes')`);
  ok('cambiarle el nombre a un grupo se lleva sus audios', JSON.parse(fs.readFileSync(path.join(process.env.VERBA_DATA, 'clases', 'c-0002.json'), 'utf8')).grupo === 'Clientes');
  ok('y el rail lo muestra', await hasta(`[...document.querySelectorAll('#rail-grupos .op-navitem')].some((b) => b.dataset.grupo === 'Clientes')`));
  ok('el rail ofrece crear un grupo', await js(`return !!document.querySelector('.op-rail [data-action="nuevo-grupo"]')`));
  await js(`await window.opal.settings.save({ parrafo: 30 })`);
  ok('párrafos cortos: el mismo audio da más párrafos', (await js(`return (await window.opal.verba.abrir('c-0001')).parrafos.length`)) === 4);
  await js(`await window.opal.settings.save({ parrafo: 55 })`);
  ok('al salir de la lectura, el panel y el reproductor se guardan', await js(`const a = document.querySelector('.op-app').classList; return !a.contains('con-panel') && !a.contains('con-composer')`));
  await foto('4-vocabularios');
  await tocar('.op-navitem[data-view="ajustes"]');
  ok('no hay opción de acrílico y la ventana es la oscura', await js(`return !document.querySelector('#view #set-vidrio') && !document.documentElement.classList.contains('vidrio-acrilico')`));
  ok('ajustes dice cómo están las actualizaciones', await hasta(`document.querySelector('#view #upd-boton')?.textContent === 'Buscar actualizaciones' && document.querySelector('#view #upd-texto')?.textContent.length > 10`));
  ok('sin versión nueva, la statusbar no muestra nada', await js(`return getComputedStyle(document.getElementById('stat-update')).display === 'none'`));
  ok('ajustes muestra el modelo', await hasta(`document.querySelector('#view #set-modelo')?.textContent.trim() === 'large-v3-turbo'`));
  await foto('5-ajustes');

  if (REAL) {
    console.log('\n9. Whisper de verdad');
    await tocar('.op-navitem[data-view="cola"]');
    await js(`await window.opal.verba.agregar([${JSON.stringify(REAL)}], { grupo: 'Medicinal', terminos: 'reserpina, isoprenalina, salbutamol' })`);
    ok('la fila muestra el avance', await hasta(`document.querySelector('#view [data-fase]')?.textContent.length > 0`, 20000));
    await foto('6-transcribiendo');
    ok('termina y pasa a la biblioteca', await hasta(`document.getElementById('n-biblioteca').textContent.trim() === '2'`, 240000));
    const c = (await js(`return await window.opal.verba.lista()`)).find((x) => x.audio === REAL);
    ok('con texto y calidad', c?.estado === 'lista' && c.calidad?.alta > 0, JSON.stringify(c));
    const v = await js(`return await window.opal.verba.abrir(${JSON.stringify(c?.id)})`);
    console.log(`     ${v.parrafos.length} párrafos, ${v.picos.length} picos, ${Math.round(c.tardo)} s. «${v.parrafos[0]?.partes.map((x) => x.t).join('').slice(0, 110)}…»`);
  }

  } catch (err) {
    fail++;
    console.log(`  FALLA el humo se cortó: ${err.message}`);
  }
  clearTimeout(fin);

  console.log('\nConsola del renderer');
  ok('sin errores ni avisos', errores.length === 0, errores.slice(0, 5).join(' | '));

  motor.apagar();
  win.destroy();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* algo quedó tomado: es una carpeta temporal */ }
  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  app.exit(fail ? 1 : 0);
});
