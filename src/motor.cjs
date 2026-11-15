'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Verba — la cola y el motor
   Las clases (un audio y su transcripción) viven en la colección `clases`, un
   JSON por audio. La cola corre acá, en el proceso principal, para que siga
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
const MATERIAS = ['Medicinal', 'Biológica', 'Farmaco', 'Tecnia', 'Micro', 'Nosia', 'Biotecno'];
const OCIO_MS = 90000;
const FFMPEG = 'C:\\tools\\ffmpeg\\bin';

const col = store.collection('clases');
const vocabDoc = store.doc('vocabularios', null);

/** id → clase completa. El disco es la verdad; esto evita releerlo en cada vista. */
const clases = new Map();
let vocab = { materias: {} };
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

async function agregar(rutas = [], { materia = '', terminos = '' } = {}) {
  const nuevos = [];
  for (const { ruta, archivo } of await expandir(rutas)) {
    const c = {
      id: proximoId(), nombre: path.basename(archivo, path.extname(archivo)), archivo, audio: ruta,
      materia: String(materia || ''), terminos: String(terminos || '').trim(),
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

async function editar(id, { nombre, materia } = {}) {
  const c = clases.get(id);
  if (!c) return null;
  if (typeof nombre === 'string' && nombre.trim()) c.nombre = nombre.trim();
  if (typeof materia === 'string') c.materia = materia;
  await guardar(c);
  return resumen(c);
}

const correccionesDe = (materia) => vocab.materias[materia]?.correcciones || [];

function abrir(id) {
  const c = clases.get(id);
  if (!c) return null;
  return {
    clase: resumen(c),
    picos: c.picos || [],
    url: pathToFileURL(c.audio).href,
    hayAudio: fs.existsSync(c.audio),
    ...texto.parrafos(c.segs || [], correccionesDe(c.materia)),
  };
}

async function exportar(id, formato, pisar = false) {
  const c = clases.get(id);
  const f = texto.FORMATOS[formato];
  if (!c || !f) throw new Error('No hay nada que exportar.');
  if (c.estado !== 'lista') throw new Error('La transcripción todavía no está lista.');
  const ruta = path.join(path.dirname(c.audio), path.basename(c.audio, path.extname(c.audio)) + f.ext);
  if (!pisar && fs.existsSync(ruta)) return { existe: true, ruta };
  await fs.promises.writeFile(ruta, f.escribir(c, correccionesDe(c.materia)), 'utf8');
  return { ruta };
}

function textoPlano(id) {
  const c = clases.get(id);
  return c ? texto.aTexto(c, correccionesDe(c.materia)) : '';
}

/* ── Vocabularios ────────────────────────────────────────────────────────── */

function limpiarVocab(v) {
  const out = { materias: {} };
  for (const [m, d] of Object.entries(v?.materias || {})) {
    out.materias[m] = {
      terminos: String(d?.terminos || ''),
      correcciones: (Array.isArray(d?.correcciones) ? d.correcciones : [])
        .map((c) => ({ de: String(c?.de || '').trim(), a: String(c?.a || '').trim() }))
        .filter((c) => c.de && c.a),
    };
  }
  return out;
}

async function guardarMateria(nombre, datos) {
  const m = String(nombre || '').trim();
  if (!m) throw new Error('La materia necesita un nombre.');
  vocab.materias[m] = { ...(vocab.materias[m] || { terminos: '', correcciones: [] }), ...datos };
  vocab = limpiarVocab(vocab);
  await vocabDoc.write(vocab);
  return vocab;
}

async function quitarMateria(nombre) {
  delete vocab.materias[nombre];
  await vocabDoc.write(vocab);
  return vocab;
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
    // lo que estaba corriendo cuando se cerró la app vuelve a la cola
    if (c.estado === 'corriendo') { c.estado = 'cola'; await col.save(c); }
    clases.set(c.id, c);
  }
  const guardado = await vocabDoc.read();
  vocab = limpiarVocab(guardado || { materias: Object.fromEntries(MATERIAS.map((m) => [m, {}])) });
  if (!guardado) await vocabDoc.write(vocab);
}

module.exports = {
  AUDIO, init, listo, apagar, estado,
  lista: () => [...clases.values()].map(resumen),
  expandir, agregar, quitar, reintentar, editar, abrir, exportar, textoPlano,
  vocabularios: () => vocab, guardarMateria, quitarMateria,
};
