'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Verba — la cola y el motor
   Cada transcripción (un audio y su texto) vive en la colección `clases`, un
   JSON por audio: «clase» es su nombre interno, de cuando la app era para
   apuntes. Puede llevar un grupo, que le da su vocabulario. La cola corre acá, en el proceso principal, para que siga
   aunque la interfaz cambie de vista o se recargue: de a un audio, en el orden
   en que se agregaron.

   El motor es un proceso de Python aparte (motor/verba_motor.py) que carga
   Whisper una vez y habla JSON por líneas. Se levanta con el primer audio y se
   apaga solo cuando la cola lleva un rato vacía: con el modelo cargado ocupa
   varios GB de VRAM que son de todos.
   ═══════════════════════════════════════════════════════════════════════════ */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const store = require('./store.cjs');
const texto = require('./texto.cjs');

const AUDIO = ['.mp3', '.m4a', '.ogg', '.opus', '.oga', '.wav', '.flac', '.aac', '.wma', '.mp4', '.mkv', '.webm', '.mov'];
const OCIO_MS = 90000;
const FFMPEG = 'C:\\tools\\ffmpeg\\bin';

const col = store.collection('clases');
const vocabDoc = store.doc('vocabularios', null);

/** id → clase completa. El disco es la verdad; esto evita releerlo en cada vista. */
const clases = new Map();
let vocab = { grupos: {} };
let emitir = () => {};

/* ── El proceso ──────────────────────────────────────────────────────────── */

let proc = null;
let matando = false;
let cola = '';        // lo que llegó por stdout sin terminar en salto de línea
let quejas = '';      // la cola de stderr, para decir por qué se cayó
let ocio = null;
const M = { fase: 'apagado', corriendo: null, p: 0, dispositivo: null, gpu: null, modelo: null };

const estado = () => ({ ...M });
const avisarMotor = () => emitir({ tipo: 'motor', estado: estado() });

function guion() {
  let empaquetada = false;
  try { empaquetada = require('electron').app.isPackaged; } catch { /* node pelado */ }
  return empaquetada
    ? path.join(process.resourcesPath, 'motor', 'verba_motor.py')
    : path.join(__dirname, '..', 'motor', 'verba_motor.py');
}

function entorno() {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const clave = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  if (fs.existsSync(FFMPEG) && !String(env[clave] || '').toLowerCase().includes(FFMPEG.toLowerCase())) {
    env[clave] = `${FFMPEG};${env[clave] || ''}`;
  }
  return env;
}

async function levantar() {
  const st = await store.loadSettings();
  const python = st.python || 'python';
  matando = false; cola = ''; quejas = '';
  M.fase = 'arrancando';
  const p = spawn(python, ['-u', guion()], { env: entorno(), windowsHide: true });
  proc = p;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    cola += d;
    const lineas = cola.split('\n');
    cola = lineas.pop();
    for (const l of lineas) {
      let ev = null;
      try { ev = JSON.parse(l); } catch { continue; }   // un print suelto de una librería
      if (ev && ev.ev) alEvento(ev).catch((err) => console.error('[motor]', err));
    }
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => { quejas = (quejas + d).slice(-4000); });
  p.on('error', (err) => {
    if (proc === p) proc = null;
    caida(`No se pudo iniciar Python («${python}»): ${err.message}. Revisá la ruta en Ajustes.`);
  });
  p.on('exit', (code) => {
    if (proc === p) proc = null;
    if (matando) { matando = false; return; }
    const ultima = quejas.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    caida(`El motor se cerró (código ${code}).${ultima ? ` ${ultima}` : ''}`);
  });
}

function apagar() {
  clearTimeout(ocio); ocio = null;
  if (proc) { matando = true; try { proc.kill(); } catch { /* ya se fue */ } proc = null; }
  M.fase = 'apagado'; M.p = 0;
}

/** El motor murió sin que se lo pidan: el audio que estaba corriendo falla. */
function caida(msg) {
  M.fase = 'apagado'; M.p = 0;
  const id = M.corriendo;
  M.corriendo = null;
  if (id && clases.has(id)) {
    fallar(id, msg).then(bombear).catch((err) => console.error('[motor]', err));
  } else {
    avisarMotor();
  }
}

async function fallar(id, msg) {
  const c = clases.get(id);
  if (!c) return;
  c.estado = 'error'; c.error = msg;
  await guardar(c);
}

async function alEvento(ev) {
  const c = ev.id ? clases.get(ev.id) : null;
  switch (ev.ev) {
    case 'listo':
      M.dispositivo = ev.dispositivo; M.gpu = ev.gpu;
      avisarMotor();
      break;
    case 'cargando':
      M.fase = 'cargando'; M.modelo = ev.modelo;
      avisarMotor();
      break;
    case 'audio':
      if (!c) break;
      c.dur = ev.dur; c.picos = ev.picos;
      await guardar(c);
      break;
    case 'progreso':
      if (ev.id !== M.corriendo) break;
      if (M.fase !== 'transcribiendo') { M.fase = 'transcribiendo'; avisarMotor(); }
      M.p = ev.p;
      emitir({ tipo: 'progreso', id: ev.id, p: ev.p });
      break;
    case 'hecho':
      if (!c) break;
      Object.assign(c, {
        estado: 'lista', error: null, segs: ev.segs, dur: ev.dur, tardo: ev.tardo,
        modelo: ev.modelo, dispositivo: ev.dispositivo, terminado: Date.now(),
        calidad: texto.calidad(ev.segs),
      });
      M.corriendo = null; M.p = 0; M.modelo = ev.modelo;
      await guardar(c);
      bombear();
      break;
    case 'error':
      M.corriendo = null; M.p = 0;
      if (c) await fallar(c.id, ev.msg);
      bombear();
      break;
    default:
  }
}

/** Si no hay nada corriendo, arranca el próximo de la cola. */
async function bombear() {
  if (M.corriendo) return;
  const sig = [...clases.values()].filter((c) => c.estado === 'cola').sort((a, b) => a.creado - b.creado)[0];
  if (!sig) {
    if (proc) { M.fase = 'ocioso'; clearTimeout(ocio); ocio = setTimeout(() => { apagar(); avisarMotor(); }, OCIO_MS); }
    avisarMotor();
    return;
  }
  clearTimeout(ocio); ocio = null;
  M.corriendo = sig.id; M.p = 0;
  if (!fs.existsSync(sig.audio)) {
    M.corriendo = null;
    await fallar(sig.id, 'El audio ya no está en esa ruta.');
    return bombear();
  }
  sig.estado = 'corriendo'; sig.error = null;
  await guardar(sig);
  try {
    if (!proc) await levantar(); else M.fase = 'transcribiendo';
    const st = await store.loadSettings();
    proc.stdin.write(`${JSON.stringify({
      op: 'transcribir', id: sig.id, audio: sig.audio, prompt: sig.terminos || '',
      modelo: st.modelo || 'large-v3-turbo', idioma: st.idioma === 'auto' ? null : (st.idioma || 'es'),
    })}\n`);
  } catch (err) {
    M.corriendo = null;
    await fallar(sig.id, err.message);
  }
  avisarMotor();
}

/* ── Las clases ──────────────────────────────────────────────────────────── */

function resumen(c) {
  const { segs, picos, ...resto } = c;
  return resto;
}

async function guardar(c) {
  clases.set(c.id, c);
  await col.save(c);
  emitir({ tipo: 'clase', clase: resumen(c) });
  return c;
}

function proximoId() {
  let max = 0;
  for (const id of clases.keys()) max = Math.max(max, Number(String(id).replace(/^c-/, '')) || 0);
  return `c-${String(max + 1).padStart(4, '0')}`;
}

/** La duración sin cargar el audio, para que la cola la muestre antes de transcribir. */
function duracion(ruta) {
  return new Promise((ok) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', ruta],
      { env: entorno(), windowsHide: true, timeout: 8000 }, (err, out) => {
        const n = err ? NaN : parseFloat(out);
        ok(Number.isFinite(n) ? n : null);
      });
  });
}

/** Una lista de rutas (archivos o carpetas) → solo los audios, sin repetir. */
async function expandir(rutas = []) {
  const out = [];
  for (const r of rutas) {
    const st = await fs.promises.stat(r).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const dentro = (await fs.promises.readdir(r)).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
      for (const f of dentro) if (AUDIO.includes(path.extname(f).toLowerCase())) out.push(path.join(r, f));
    } else if (AUDIO.includes(path.extname(r).toLowerCase())) out.push(r);
  }
  return [...new Set(out)].map((ruta) => ({ ruta, archivo: path.basename(ruta) }));
}

async function agregar(rutas = [], { grupo = '', terminos = '' } = {}) {
  const nuevos = [];
  for (const { ruta, archivo } of await expandir(rutas)) {
    const c = {
      id: proximoId(), nombre: path.basename(archivo, path.extname(archivo)), archivo, audio: ruta,
      grupo: String(grupo || ''), terminos: String(terminos || '').trim(),
      estado: 'cola', creado: Date.now() + nuevos.length, dur: await duracion(ruta),
    };
    await guardar(c);
    nuevos.push(resumen(c));
  }
  bombear();
  return nuevos;
}

async function quitar(id) {
  const c = clases.get(id);
  if (!c) return false;
  if (M.corriendo === id) { M.corriendo = null; apagar(); }
  clases.delete(id);
  await col.remove(id);
  emitir({ tipo: 'quitada', id });
  bombear();
  return true;
}

async function reintentar(id, terminos) {
  const c = clases.get(id);
  if (!c || c.estado === 'corriendo') return null;
  if (typeof terminos === 'string') c.terminos = terminos.trim();
  Object.assign(c, { estado: 'cola', error: null, creado: Date.now() });
  await guardar(c);
  bombear();
  return resumen(c);
}

async function editar(id, { nombre, grupo } = {}) {
  const c = clases.get(id);
  if (!c) return null;
  if (typeof nombre === 'string' && nombre.trim()) c.nombre = nombre.trim();
  if (typeof grupo === 'string') c.grupo = grupo;
  await guardar(c);
  return resumen(c);
}

const correccionesDe = (grupo) => vocab.grupos[grupo]?.correcciones || [];

async function abrir(id) {
  const c = clases.get(id);
  if (!c) return null;
  const ventana = (await store.loadSettings()).parrafo;
  return {
    clase: resumen(c),
    picos: c.picos || [],
    url: pathToFileURL(c.audio).href,
    hayAudio: fs.existsSync(c.audio),
    ...texto.parrafos(c.segs || [], correccionesDe(c.grupo), { ventana }),
  };
}

async function exportar(id, formato, pisar = false) {
  const c = clases.get(id);
  const f = texto.FORMATOS[formato];
  if (!c || !f) throw new Error('No hay nada que exportar.');
  if (c.estado !== 'lista') throw new Error('La transcripción todavía no está lista.');
  const ruta = path.join(path.dirname(c.audio), path.basename(c.audio, path.extname(c.audio)) + f.ext);
  if (!pisar && fs.existsSync(ruta)) return { existe: true, ruta };
  await fs.promises.writeFile(ruta, f.escribir(c, correccionesDe(c.grupo), { ventana: (await store.loadSettings()).parrafo }), 'utf8');
  return { ruta };
}

async function textoPlano(id) {
  const c = clases.get(id);
  return c ? texto.aTexto(c, correccionesDe(c.grupo), { ventana: (await store.loadSettings()).parrafo }) : '';
}

/* ── Vocabularios ────────────────────────────────────────────────────────── */

function limpiarVocab(v) {
  const out = { grupos: {} };
  for (const [m, d] of Object.entries(v?.grupos || {})) {
    out.grupos[m] = {
      terminos: String(d?.terminos || ''),
      correcciones: (Array.isArray(d?.correcciones) ? d.correcciones : [])
        .map((c) => ({ de: String(c?.de || '').trim(), a: String(c?.a || '').trim() }))
        .filter((c) => c.de && c.a),
    };
  }
  return out;
}

async function guardarGrupo(nombre, datos) {
  const m = String(nombre || '').trim();
  if (!m) throw new Error('El grupo necesita un nombre.');
  vocab.grupos[m] = { ...(vocab.grupos[m] || { terminos: '', correcciones: [] }), ...datos };
  vocab = limpiarVocab(vocab);
  await vocabDoc.write(vocab);
  return vocab;
}

/** Quita el grupo. Sus audios quedan en la biblioteca, sin grupo. */
async function quitarGrupo(nombre) {
  delete vocab.grupos[nombre];
  await vocabDoc.write(vocab);
  for (const c of clases.values()) if (c.grupo === nombre) { c.grupo = ''; await guardar(c); }
  return vocab;
}

/** Cambia el nombre de un grupo: su vocabulario y sus audios lo siguen. */
async function renombrarGrupo(viejo, nuevo) {
  const n = String(nuevo || '').trim();
  if (!n) throw new Error('El grupo necesita un nombre.');
  if (n === viejo) return vocab;
  if (vocab.grupos[n]) throw new Error(`Ya hay un grupo que se llama «${n}».`);
  // se rearma el objeto para que el grupo conserve su lugar en la lista
  vocab = { grupos: Object.fromEntries(Object.entries(vocab.grupos).map(([k, d]) => [k === viejo ? n : k, d])) };
  if (!vocab.grupos[n]) vocab.grupos[n] = { terminos: '', correcciones: [] };
  await vocabDoc.write(vocab);
  for (const c of clases.values()) if (c.grupo === viejo) { c.grupo = n; await guardar(c); }
  return vocab;
}

/* Hasta la 0.1 los grupos eran «materias» y la app nacía con siete de fábrica.
   De ese archivo se quedan las que tienen algo adentro o algún audio: las de
   fábrica que nadie tocó no eran de nadie. */
function migrarVocab(v) {
  if (!v) return { grupos: {} };
  if (v.grupos) return v;
  const usados = new Set([...clases.values()].map((c) => c.grupo).filter(Boolean));
  const grupos = {};
  for (const [m, d] of Object.entries(v['materias'] || {})) {
    const lleno = String(d?.terminos || '').trim() || (Array.isArray(d?.correcciones) && d.correcciones.length);
    if (lleno || usados.has(m)) grupos[m] = d;
  }
  return { grupos };
}

/* ── Arranque ────────────────────────────────────────────────────────────── */

/* La interfaz puede preguntar antes de que termine de leerse el disco (la
   ventana carga en paralelo): quien pregunta espera a `listo`. Sin esto, la
   lista llegaba vacía y las clases guardadas no aparecían. */
let avisarListo;
const listo = new Promise((ok) => { avisarListo = ok; });

async function init(emisor) {
  emitir = emisor || emitir;
  try { await cargar(); } finally { avisarListo(); }
  bombear();
}

async function cargar() {
  for (const c of await col.list()) {
    let cambio = false;
    // lo que estaba corriendo cuando se cerró la app vuelve a la cola
    if (c.estado === 'corriendo') { c.estado = 'cola'; cambio = true; }
    // hasta la 0.1 el grupo se llamaba «materia»
    if ('materia' in c) { c.grupo = c.grupo || c['materia'] || ''; delete c['materia']; cambio = true; }
    if (cambio) await col.save(c);
    clases.set(c.id, c);
  }
  const guardado = await vocabDoc.read();
  vocab = limpiarVocab(migrarVocab(guardado));
  if (!guardado || !guardado.grupos) await vocabDoc.write(vocab);
}

module.exports = {
  AUDIO, init, listo, apagar, estado,
  lista: () => [...clases.values()].map(resumen),
  expandir, agregar, quitar, reintentar, editar, abrir, exportar, textoPlano,
  vocabularios: () => vocab, guardarGrupo, quitarGrupo, renombrarGrupo,
};
