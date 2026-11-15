/* ═══════════════════════════════════════════════════════════════════════════
   VERBA — la interfaz
   Transcribe audios en local con Whisper. La cola, el motor y los archivos
   viven en el proceso principal (src/motor.cjs); acá se dibuja lo que cuentan
   y se piden las cosas por window.opal.verba.

     Cola          lo que espera y lo que se está transcribiendo
     Biblioteca    las clases listas, por materia
     Clase         el texto con sus tiempos, el reproductor y las correcciones
     Vocabularios  términos y correcciones por materia
     Ajustes       el motor y los datos
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { Tooltip, Toast, Menu, FieldMenu, Modal } from './overlays.js';
import Router from './router.js';
import { initClickFlash, initScrollFades, raf2, bindSwitcher, bindToggle, reconcile, contador, swap, swapText } from './motion.js';
import { viewEl, esc, paint, head, empty, mark, attempt, copy, colorToken, setStateLabels } from './ui.js';
import { plural, fmtDate } from './format.js';
import { designHTML, wireDesign } from './design-view.js';
import { Shell } from './shell.js';

const api = window.opal;
const V = api.verba;

Icons.add({
  onda: '<path d="M2.5 6.8v2.4M5.2 4.6v6.8M8 3v10M10.8 5.2v5.6M13.5 6.8v2.4"/>',
});
setStateLabels({ queued: 'En cola', running: 'Transcribiendo', done: 'Lista', failed: 'Falló' });
const ESTADO = { cola: 'queued', corriendo: 'running', lista: 'done', error: 'failed' };

/* ══ Datos ═══════════════════════════════════════════════════════════════════
   Un espejo en memoria de lo que sabe el proceso principal. Las vistas leen de
   acá; lo que cambia llega solo, por V.onEvento. */

const S = {
  info: null,
  settings: {},
  clases: new Map(),     // id → resumen (sin los segmentos)
  vocab: { materias: {} },
  motor: { fase: 'apagado', corriendo: null, p: 0 },
  formatos: [],
  abierta: null,         // la clase que se está leyendo: { clase, parrafos, usos, picos, url }
  avance: null,          // { id, t0, p0 }: para estimar cuánto falta
  tab: 'corr',           // la solapa del panel
};

const lista = () => [...S.clases.values()];
const pendientes = () => lista().filter((c) => c.estado !== 'lista')
  .sort((a, b) => (a.estado === 'corriendo' ? -1 : b.estado === 'corriendo' ? 1 : 0) || a.creado - b.creado);
const listas = (materia = null) => lista().filter((c) => c.estado === 'lista' && (!materia || c.materia === materia))
  .sort((a, b) => (b.terminado || 0) - (a.terminado || 0));
const materias = () => {
  const m = new Set(Object.keys(S.vocab.materias));
  for (const c of S.clases.values()) if (c.materia) m.add(c.materia);
  return [...m];
};
const terminosDe = (materia) => S.vocab.materias[materia]?.terminos || '';
const contarTerminos = (t) => String(t || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).length;

/* ── Tiempos ─────────────────────────────────────────────────────────────── */

const dos = (n) => String(n).padStart(2, '0');
function reloj(seg) {
  const s = Math.max(0, Math.floor(seg || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${dos(m)}:${dos(s % 60)}` : `${m}:${dos(s % 60)}`;
}
function lapso(seg) {
  const s = Math.round(seg || 0);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** 14/11/2026: entra en una columna angosta. */
const fechaCorta = (ts) => new Date(ts).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });

async function loadAll() {
  const [info, settings, clases, vocab, motor, formatos] = await Promise.all([
    api.info(), api.settings.get(), V.lista(), V.vocab(), V.motor(), V.formatos(),
  ]);
  S.info = info;
  S.settings = settings;
  S.clases = new Map(clases.map((c) => [c.id, c]));
  S.vocab = vocab;
  S.motor = motor;
  S.formatos = formatos;
}

/* ══ Lo que cuenta la cola ═══════════════════════════════════════════════════ */

function alEvento(ev) {
  if (ev.tipo === 'progreso') {
    S.motor.p = ev.p;
    if (!S.avance || S.avance.id !== ev.id) S.avance = { id: ev.id, t0: performance.now(), p0: ev.p };
    pintarAvance();
    return;
  }
  if (ev.tipo === 'motor') {
    S.motor = ev.estado;
    if (!S.motor.corriendo) S.avance = null;
    pintarAvance();
    updateChrome();
    return;
  }
  if (ev.tipo === 'quitada') {
    S.clases.delete(ev.id);
    updateChrome();
    if (Router.name === 'clase' && Router.param === ev.id) Router.go('biblioteca');
    else ponerAlDia();
    return;
  }
  if (ev.tipo === 'clase') {
    const antes = S.clases.get(ev.clase.id);
    S.clases.set(ev.clase.id, ev.clase);
    if (antes?.estado === 'corriendo' && ev.clase.estado === 'lista') {
      Toast.show({ title: 'Transcripción lista', text: `${ev.clase.nombre} · ${ev.clase.calidad?.alta ?? 0} % de confianza alta`, icon: 'check' });
    }
    if (ev.clase.estado === 'error' && antes?.estado !== 'error') Toast.error(`Falló ${ev.clase.nombre}`, ev.clase.error || '');
    updateChrome();
    if (Router.name === 'clase' && Router.param === ev.clase.id) {
      // solo si cambió algo que se ve: el aviso del audio leído no repinta la lectura
      if (antes?.estado !== ev.clase.estado || antes?.nombre !== ev.clase.nombre || antes?.materia !== ev.clase.materia) recargarClase();
    } else ponerAlDia();
  }
}

/** Las listas a la vista, puestas al día fila por fila. */
function ponerAlDia() {
  if (Router.name === 'cola') ponerCola();
  if (Router.name === 'biblioteca') ponerBiblioteca();
}

/* ══ Agregar audios ══════════════════════════════════════════════════════════ */

/** Un `.op-select` de materias. `alElegir(materia)`; devuelve cómo leer la elegida. */
function selectorMateria(btn, inicial, alElegir) {
  let elegida = inicial || '';
  const val = btn.querySelector('.op-select__value');
  val.textContent = elegida || 'Sin materia';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    Menu.show(btn, [
      ...materias().map((m) => ({ label: m, selected: elegida === m, onSelect: () => poner(m) })),
      { sep: true },
      { label: 'Sin materia', selected: !elegida, onSelect: () => poner('') },
    ]);
  });
  function poner(m) {
    if (m === elegida) return;
    const anterior = elegida;
    elegida = m;
    swapText(val, m || 'Sin materia', { relevo: true });
    alElegir?.(m, anterior);
  }
  return () => elegida;
}

async function agregar(archivos = null) {
  const elegidos = archivos || await attempt(() => V.elegir(), { errorTitle: 'No se pudo abrir el diálogo' });
  if (!elegidos || !elegidos.length) return;

  const inicial = (Router.name === 'biblioteca' && Router.param) || S.settings.ultimaMateria || '';
  const body = document.createElement('div');
  body.className = 'op-col';
  body.style.gap = '16px';
  body.innerHTML = `
    <div class="op-field">
      <label class="op-field__label">${plural(elegidos.length, 'audio', 'audios')}</label>
      <div class="vb-archivos op-scroll">${elegidos.map((a) => `
        <div class="vb-archivo">${Icons.svg('onda')}<span class="op-truncate">${esc(a.archivo)}</span></div>`).join('')}</div>
    </div>
    <div class="op-field">
      <label class="op-field__label">Materia</label>
      <button class="op-select" id="ag-materia" style="max-width:240px"><span class="op-select__value"></span>${Icons.svg('chevronDown')}</button>
    </div>
    <div class="op-field">
      <label class="op-field__label">Términos de la clase</label>
      <textarea class="op-textarea" id="ag-terminos" rows="3" spellcheck="false" placeholder="reserpina, VMAT, iproniazida, isoprenalina"></textarea>
      <span class="op-field__hint">Nombres propios y palabras técnicas, separados por coma. Whisper los usa para escribirlos bien.</span>
    </div>`;
  const campo = body.querySelector('#ag-terminos');
  campo.value = terminosDe(inicial);
  const materia = selectorMateria(body.querySelector('#ag-materia'), materias().includes(inicial) ? inicial : '', (m, anterior) => {
    // si no se tocaron los términos, se cambian por los de la materia nueva
    if (campo.value.trim() === terminosDe(anterior).trim()) campo.value = terminosDe(m);
  });

  const ok = await Modal.show({
    title: 'Agregar audios',
    sub: 'Se transcriben de a uno, en este orden. Los archivos no se mueven ni se copian.',
    body,
    width: 500,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Poner en cola', value: true, variant: 'primary', autofocus: true }],
  });
  if (!ok) return;

  await attempt(async () => {
    const m = materia();
    const nuevos = await V.agregar(elegidos.map((a) => a.ruta), { materia: m, terminos: campo.value });
    if (m !== S.settings.ultimaMateria) persist({ ultimaMateria: m });
    Toast.show({ title: `${plural(nuevos.length, 'audio', 'audios')} en la cola`, text: nuevos.map((c) => c.nombre).slice(0, 3).join(', '), icon: 'onda' });
    Router.go('cola');
  }, { errorTitle: 'No se pudieron agregar' });
}

/** Lo que se soltó sobre la ventana: archivos sueltos o una carpeta. */
async function alSoltar(files) {
  const rutas = [...files].map((f) => V.rutaDe(f)).filter(Boolean);
  if (!rutas.length) return;
  const audios = await attempt(() => V.expandir(rutas), { errorTitle: 'No se pudo leer lo que soltaste' });
  if (!audios) return;
  if (!audios.length) { Toast.show({ title: 'Ahí no había audios', text: 'Verba lee mp3, m4a, ogg, opus, wav, flac y mp4.', icon: 'info' }); return; }
  agregar(audios);
}

/* ══ Vista: Cola ═════════════════════════════════════════════════════════════ */

function subCola() {
  const p = pendientes().filter((c) => c.estado !== 'error');
  if (!p.length) return 'No hay nada esperando';
  const dur = p.reduce((n, c) => n + (c.dur || 0), 0);
  return `${plural(p.length, 'audio', 'audios')}${dur ? ` · ${lapso(dur)} de grabación` : ''}`;
}

function filaCola(c) {
  const sub = [c.materia, c.archivo, c.terminos ? plural(contarTerminos(c.terminos), 'término', 'términos') : ''].filter(Boolean).join(' · ');
  const estado = c.estado === 'corriendo'
    ? `<div class="vb-fila__renglon"><b data-pct></b><span class="op-truncate" data-fase></span></div><div class="op-meter"><div class="op-meter__fill"></div></div>`
    : c.estado === 'error'
      ? `<div class="vb-fila__renglon vb-fila__error"><span class="op-truncate" data-tip="${esc(c.error || '')}">${esc(c.error || 'Falló')}</span></div>`
      : '<div class="vb-fila__renglon"><span>En cola</span></div>';
  return `<div class="vb-fila vb-fila--cola">
    <span>${mark(ESTADO[c.estado] || 'queued')}</span>
    <div style="min-width:0"><div class="vb-fila__nombre op-truncate">${esc(c.nombre)}</div><div class="vb-fila__sub op-truncate">${esc(sub)}</div></div>
    <span class="vb-fila__dato">${c.dur ? reloj(c.dur) : ''}</span>
    <div class="vb-fila__estado">${estado}</div>
    <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-menu="clase" data-menu-arg="${esc(c.id)}" data-tip="Más">${Icons.svg('more')}</button></div>
  </div>`;
}

function ponerCola(entrar = true) {
  const box = document.querySelector('#view #cola-filas');
  if (!box) return;
  const p = pendientes();
  reconcile(box, p.map((c) => ({ key: c.id, html: filaCola(c) })), { enter: entrar });
  swap(document.querySelector('#view #cola-vacia'), p.length ? '' : `<div class="op-empty" style="margin:40px auto">${Icons.svg('onda')}
    <div class="op-empty__title">La cola está vacía</div>
    <div class="op-empty__text">Los audios que agregues se transcriben de a uno. Cuando terminan, pasan a la Biblioteca.</div></div>`);
  const sub = document.querySelector('#view .op-viewhead__sub');
  if (sub) swapText(sub, subCola());
  pintarAvance();
}

/** El avance del audio que está corriendo: se escribe en su fila, sin repintarla. */
function pintarAvance() {
  const id = S.motor.corriendo;
  const fila = id && document.querySelector(`#view #cola-filas [data-key="${CSS.escape(id)}"]`);
  if (!fila) return;
  const pct = fila.querySelector('[data-pct]'), fase = fila.querySelector('[data-fase]'), barra = fila.querySelector('.op-meter');
  if (!pct || !fase || !barra) return;
  const p = S.motor.p || 0;
  let texto = 'Iniciando el motor';
  if (S.motor.fase === 'cargando') texto = `Cargando ${S.motor.modelo || 'el modelo'}`;
  if (S.motor.fase === 'transcribiendo') {
    texto = 'Transcribiendo';
    const a = S.avance, c = S.clases.get(id);
    const pasaron = a ? (performance.now() - a.t0) / 1000 : 0;
    if (a && pasaron > 2 && p - a.p0 > 0.02) {
      const falta = ((1 - p) * pasaron) / (p - a.p0);
      const vel = c?.dur ? ((p - a.p0) * c.dur) / pasaron : 0;
      texto = `faltan ${lapso(falta)}${vel >= 1.5 ? ` · ${Math.round(vel)}× tiempo real` : ''}`;
    }
  }
  pct.textContent = S.motor.fase === 'transcribiendo' ? `${Math.floor(p * 100)} %` : '';
  fase.textContent = texto;
  barra.style.setProperty('--op-pct', `${(p * 100).toFixed(1)}%`);
}

function viewCola() {
  paint(head({
    title: 'Cola',
    sub: subCola(),
    actions: '<button class="op-btn op-btn--primary op-flashable" data-action="agregar"><i data-icon="plus"></i> Agregar audios</button>',
  }) + `
    <div class="vb-zona"><button class="vb-drop" id="drop" data-action="agregar"><i data-icon="onda"></i> Soltá audios o una carpeta acá. mp3, m4a, ogg, opus, wav, mp4.</button></div>
    <div class="op-scroll op-grow">
      <div class="vb-filas" id="cola-filas"></div>
      <div id="cola-vacia"></div>
      <div style="height:32px"></div>
    </div>`);
  ponerCola(false);
}

/* ══ Vista: Biblioteca ═══════════════════════════════════════════════════════ */

function filaBib(c) {
  const q = c.calidad || { alta: 0, bucles: 0 };
  return `<div class="vb-fila vb-fila--bib" role="button" tabindex="0" data-abrir="${esc(c.id)}">
    <div style="min-width:0"><div class="vb-fila__nombre op-truncate">${esc(c.nombre)}</div><div class="vb-fila__sub op-truncate">${esc([c.materia, c.archivo].filter(Boolean).join(' · '))}</div></div>
    <span class="vb-fila__dato" data-tip="${esc(c.terminado ? fmtDate(c.terminado, { withTime: true }) : '')}">${esc(c.terminado ? fechaCorta(c.terminado) : '')}</span>
    <span class="vb-fila__dato">${reloj(c.dur)}</span>
    <div class="vb-calmini"><b>${q.alta} %</b><div class="op-meter" style="--op-pct:${q.alta}%"><div class="op-meter__fill"></div></div></div>
    <span class="vb-fila__dato">${q.bucles}</span>
    <div class="op-rowactions"><button class="op-iconbtn op-iconbtn--sm" data-menu="clase" data-menu-arg="${esc(c.id)}" data-tip="Más">${Icons.svg('more')}</button></div>
  </div>`;
}

const subBiblioteca = (materia) => {
  const n = listas(materia).length;
  return `${materia ? `${materia} · ` : ''}${plural(n, 'clase', 'clases')}`;
};

function ponerBiblioteca(entrar = true) {
  const box = document.querySelector('#view #bib-filas');
  if (!box) return;
  const materia = Router.param;
  const l = listas(materia);
  reconcile(box, l.map((c) => ({ key: c.id, html: filaBib(c) })), { enter: entrar });
  document.querySelector('#view #bib-cols').hidden = !l.length;
  swap(document.querySelector('#view #bib-vacia'), l.length ? '' : `<div class="op-empty" style="margin:40px auto">${Icons.svg('inbox')}
    <div class="op-empty__title">${materia ? `No hay clases de ${esc(materia)}` : 'Todavía no hay transcripciones'}</div>
    <div class="op-empty__text">${materia ? 'Las que agregues con esta materia aparecen acá cuando terminan.' : 'Agregá un audio: cuando termina de transcribirse, queda acá con su texto, sus tiempos y su calidad.'}</div>
    ${materia ? '' : '<div class="op-row" style="margin-top:6px"><button class="op-btn op-btn--secondary op-flashable" data-action="agregar"><i data-icon="plus"></i> Agregar audios</button></div>'}</div>`);
  Icons.mount(document.querySelector('#view #bib-vacia'));
  const sub = document.querySelector('#view .op-viewhead__sub');
  if (sub) swapText(sub, subBiblioteca(materia));
}

function viewBiblioteca(materia) {
  paint(head({ title: 'Biblioteca', sub: subBiblioteca(materia) }) + `
    <div style="flex:0 0 auto;padding-top:8px"><div class="vb-cols vb-fila--bib" id="bib-cols">
      <span>Clase</span><span>Lista el</span><span>Dura</span><span data-tip="Parte del tiempo en que Whisper estuvo seguro de lo que escribía">Confianza alta</span><span data-tip="Tramos donde se quedó repitiendo">Bucles</span><span></span>
    </div></div>
    <div class="op-scroll op-grow">
      <div class="vb-filas" id="bib-filas"></div>
      <div id="bib-vacia"></div>
      <div style="height:32px"></div>
    </div>`);
  ponerBiblioteca(false);
}

/* ══ Vista: una clase ════════════════════════════════════════════════════════ */

async function abrirClase(id) {
  await attempt(async () => {
    S.abierta = await V.abrir(id);
    if (!S.abierta) throw new Error('Esa clase ya no está.');
    Router.go('clase', id);
  }, { errorTitle: 'No se pudo abrir' });
}

/** Vuelve a pedir la clase abierta y repinta la lectura sin perder el lugar. */
async function recargarClase() {
  const id = Router.param;
  const v = await attempt(() => V.abrir(id), { errorTitle: 'No se pudo releer la clase' });
  if (!v || Router.name !== 'clase' || Router.param !== id) return;
  S.abierta = v;
  Router.refresh();
  pintarPanel();
}

const parteHTML = (x) => (x.inv
  ? `<span class="vb-inv" data-tip="Whisper lo escribió en un silencio. No sale al exportar.">${esc(x.t)}</span>`
  : x.fx != null
    ? `<span class="vb-fx" data-fx="${x.fx}" data-tip="Whisper escribió «${esc(x.de)}»">${esc(x.t)}</span>`
    : esc(x.t));

function viewClase(id) {
  const v = S.abierta && S.abierta.clase.id === id ? S.abierta : null;
  if (!v) {
    paint(head({ title: 'Clase', crumbs: [{ label: 'Biblioteca', view: 'biblioteca' }] })
      + empty({ icon: 'alert', title: 'Esa clase ya no está', text: 'Puede que la hayas quitado de la biblioteca.' }));
    return;
  }
  const c = v.clase;
  const crumbs = [{ label: 'Biblioteca', view: 'biblioteca' }];
  if (c.materia) crumbs.push({ label: c.materia, view: 'biblioteca', param: c.materia });

  if (c.estado !== 'lista') {
    const texto = {
      cola: ['clock', 'Está en la cola', 'Cuando le toque, se transcribe sola.'],
      corriendo: ['onda', 'Se está transcribiendo', 'El avance está en la Cola. Cuando termine, el texto aparece acá.'],
      error: ['alert', 'No se pudo transcribir', c.error || ''],
    }[c.estado] || ['alert', 'Sin transcripción', ''];
    paint(head({ title: c.nombre, sub: c.archivo, crumbs }) + empty({
      icon: texto[0], title: texto[1], text: texto[2],
      actions: c.estado === 'error'
        ? `<button class="op-btn op-btn--secondary op-flashable" data-action="reintentar" data-arg="${esc(c.id)}"><i data-icon="retry"></i> Volver a intentar</button>`
        : '<button class="op-btn op-btn--secondary op-flashable" data-goto="cola">Ver la cola</button>',
    }));
    Shell.set({ panel: false, composer: false });
    Player.soltar();
    return;
  }

  const q = c.calidad || { alta: 0, bucles: 0, inventos: 0 };
  paint(head({
    title: c.nombre,
    sub: c.archivo,
    crumbs,
    actions: `
      <button class="op-btn op-btn--secondary op-flashable" id="btn-exportar"><i data-icon="download"></i> Exportar</button>
      <button class="op-iconbtn" data-menu="clase" data-menu-arg="${esc(c.id)}" data-tip="Más"><i data-icon="more"></i></button>`,
  }) + `
    <dl class="vb-cal">
      <div><dt>Confianza alta</dt><dd>${q.alta} %<div class="op-meter" style="--op-pct:${q.alta}%"><div class="op-meter__fill"></div></div></dd></div>
      <div><dt>Bucles</dt><dd>${q.bucles}</dd></div>
      <div data-tip="Segmentos que Whisper escribió en un silencio. En el texto van tachados y no salen al exportar."><dt>Inventos</dt><dd>${q.inventos}</dd></div>
      <div><dt>Transcripta en</dt><dd>${c.tardo ? esc(lapso(c.tardo)) : ''}${c.tardo && c.dur ? ` · ${Math.max(1, Math.round(c.dur / c.tardo))}×` : ''}</dd></div>
    </dl>
    <div class="op-scroll op-grow vb-texto" id="texto">
      ${v.parrafos.map((p, i) => `
      <div class="vb-par${p.baja ? ' es-baja' : ''}" data-t="${p.t}" data-i="${i}">
        <span class="vb-par__hora">${reloj(p.t)}</span>
        <div><p>${p.partes.map(parteHTML).join('')}</p>${p.baja ? `<span class="vb-nota">${Icons.svg('alert')}Confianza baja: conviene escuchar este tramo</span>` : ''}</div>
      </div>`).join('')}
      ${v.parrafos.length ? '' : '<div class="vb-fin">Whisper no encontró voz en este audio.</div>'}
      <div style="height:24px"></div>
    </div>`);

  Shell.set({ panel: true, composer: true });
  Player.cargar(v);
  Player.marcar(false);
  pintarPanel();

  /* Lo que se selecciona en el texto queda propuesto como «lo que escribió
     Whisper» en el panel: corregir una palabra es seleccionarla y escribir
     cómo va. El nodo muere con el pintado, así que el listener no se acumula. */
  document.querySelector('#view #texto').addEventListener('mouseup', () => {
    const sel = String(getSelection()).trim();
    const de = document.querySelector('#panel #pn-de');
    if (de && sel && sel.length <= 60 && !sel.includes('\n')) de.value = sel;
  });
}

/* ══ El panel: correcciones y términos de la clase abierta ═══════════════════ */

function panelCuerpo() {
  const v = S.abierta;
  if (!v) return '';
  const c = v.clase;
  if (S.tab === 'term') {
    return `<div class="vb-panelbloque">
      <p class="vb-ayuda">Lo que se le dijo a Whisper antes de empezar, para que escriba bien los nombres.</p>
      <textarea class="op-textarea" id="pn-terminos" rows="6" spellcheck="false" placeholder="reserpina, VMAT, iproniazida">${esc(c.terminos || '')}</textarea>
      <button class="op-btn op-btn--secondary op-flashable" data-action="rehacer"><i data-icon="retry"></i> Volver a transcribir</button>
      ${c.materia ? `<button class="op-btn op-btn--ghost op-flashable" data-action="terminos-a-materia">Guardar como términos de ${esc(c.materia)}</button>` : ''}
    </div>`;
  }
  const usos = v.usos.length
    ? v.usos.map((u) => `<div class="vb-corr" data-fx="${u.i}">
        <div class="op-row" style="gap:6px;align-items:flex-start">
          <div class="op-grow" style="min-width:0"><div class="vb-corr__de">${esc(u.de)}</div><div class="vb-corr__a">${Icons.svg('arrowRight')}${esc(u.a)}</div></div>
          <button class="op-iconbtn op-iconbtn--sm" data-action="quitar-corr" data-arg="${u.i}" data-tip="Sacar del vocabulario">${Icons.svg('close')}</button>
        </div>
        <div class="vb-corr__donde">${u.en.map((t) => `<button class="vb-min" data-seg="${t}">${reloj(t)}</button>`).join('')}</div>
      </div>`).join('')
    : '<p class="vb-vacio">Ninguna corrección del vocabulario aparece en esta clase.</p>';
  return `<div class="vb-panelbloque">
    <p class="vb-ayuda">${c.materia
    ? `Del vocabulario de ${esc(c.materia)}. Se aplican al mostrar y al exportar: el texto de Whisper queda guardado como salió.`
    : 'Esta clase no tiene materia. Las correcciones se guardan por materia: asignale una desde el menú de la clase.'}</p>
    <div>${usos}</div>
    ${c.materia ? `<div>
      <div class="vb-voc__rotulo" style="margin-bottom:6px">Corrección nueva</div>
      <div class="vb-nueva">
        <input class="op-input" id="pn-de" spellcheck="false" placeholder="reserfina" aria-label="Lo que escribió Whisper">
        <input class="op-input" id="pn-a" spellcheck="false" placeholder="reserpina" aria-label="Cómo va">
        <button class="op-iconbtn" data-action="agregar-corr" data-tip="Agregar al vocabulario">${Icons.svg('plus')}</button>
      </div>
      <span class="op-field__hint">Seleccioná una palabra en el texto y queda puesta en el primer campo.</span>
    </div>` : ''}
  </div>`;
}

function pintarPanel() {
  const p = document.getElementById('panel');
  if (!p) return;
  if (Router.name !== 'clase' || !S.abierta || S.abierta.clase.estado !== 'lista') { p.replaceChildren(); return; }
  let cuerpo = p.querySelector('#pn-cuerpo');
  if (!cuerpo) {
    p.innerHTML = `<div class="op-panel__swap">
      <div class="vb-tabs"><div class="op-segmented" id="pn-tabs">
        <button class="op-segmented__opt${S.tab === 'corr' ? ' is-active' : ''}" data-value="corr">Correcciones</button>
        <button class="op-segmented__opt${S.tab === 'term' ? ' is-active' : ''}" data-value="term">Términos</button>
      </div></div>
      <div class="op-panel__body op-scroll" id="pn-cuerpo" style="padding-top:12px"></div>
    </div>`;
    bindSwitcher(p.querySelector('#pn-tabs'), (value) => { S.tab = value; pintarPanel(); });
    cuerpo = p.querySelector('#pn-cuerpo');
    initScrollFades(p);
  }
  swap(cuerpo, panelCuerpo(), { relevo: true });
}

async function guardarCorrecciones(correcciones) {
  const m = S.abierta?.clase.materia;
  if (!m) return;
  await attempt(async () => {
    S.vocab = await V.guardarMateria(m, { correcciones });
    await recargarClase();
  }, { errorTitle: 'No se pudo guardar el vocabulario' });
}

function agregarCorreccion() {
  const de = document.querySelector('#panel #pn-de'), a = document.querySelector('#panel #pn-a');
  const m = S.abierta?.clase.materia;
  if (!de || !a || !m) return;
  const d = de.value.trim(), h = a.value.trim();
  if (!d || !h) { (d ? a : de).focus(); return; }
  if (d.toLowerCase() === h.toLowerCase()) { Toast.show({ title: 'Son iguales', text: 'La corrección tiene que cambiar algo.', icon: 'info' }); return; }
  const actuales = S.vocab.materias[m]?.correcciones || [];
  guardarCorrecciones([...actuales.filter((c) => c.de.toLowerCase() !== d.toLowerCase()), { de: d, a: h }]);
}

async function rehacer() {
  const c = S.abierta?.clase;
  const campo = document.querySelector('#panel #pn-terminos');
  if (!c || !campo) return;
  const ok = await Modal.confirm({
    title: `¿Volver a transcribir «${c.nombre}»?`,
    sub: 'Va a la cola con estos términos. Cuando termine, el texto nuevo reemplaza al de ahora.',
    confirmLabel: 'Volver a transcribir',
  });
  if (!ok) return;
  await attempt(async () => {
    await V.reintentar(c.id, campo.value);
    Router.go('cola');
  }, { errorTitle: 'No se pudo mandar a la cola' });
}

/* ══ El reproductor ══════════════════════════════════════════════════════════
   Un <audio> de verdad sobre el archivo original, y la onda dibujada con los
   picos que midió el motor. Vive en el shell, fuera de la vista: repintar la
   lectura no lo corta. */

const Player = (() => {
  const VELOCIDADES = [1, 1.25, 1.5, 2];
  let audio, lienzo, pista, btn, ahora, total, vel;
  let id = null, picos = [], dur = 0, bajos = [], cuadro = 0, seguir = true, suena = -1;

  const duracion = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : dur);

  function dibujar() {
    const w = pista.clientWidth, h = pista.clientHeight;
    if (!w || !h) return;
    const d = devicePixelRatio || 1;
    if (lienzo.width !== Math.round(w * d) || lienzo.height !== Math.round(h * d)) { lienzo.width = Math.round(w * d); lienzo.height = Math.round(h * d); }
    const g = lienzo.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--op-accent-rgb').trim().split(/\s+/).join(',');
    const n = Math.max(1, Math.floor(w / 3)), D = duracion() || 1, px = (audio.currentTime / D) * w;
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i / n) * picos.length), b = Math.max(a + 1, Math.floor(((i + 1) / n) * picos.length));
      let m = 0;
      for (let k = a; k < b && k < picos.length; k++) if (picos[k] > m) m = picos[k];
      const x = (i / n) * w, t = (i / n) * D, alto = Math.max(2, (m / 255) * (h - 4));
      const baja = bajos.some(([s, e]) => t >= s && t < e);
      g.fillStyle = x < px ? `rgba(${rgb},.92)` : baja ? 'rgba(255,255,255,.11)' : 'rgba(255,255,255,.26)';
      g.fillRect(x, (h - alto) / 2, 1.6, alto);
    }
    g.fillStyle = `rgb(${rgb})`;
    g.fillRect(Math.min(w - 2, Math.max(0, px)), 0, 2, h);
  }

  /** Prende el párrafo que está sonando; si se sigue el audio, lo lleva a la vista. */
  function marcar(llevar = true) {
    const pars = document.querySelectorAll('#view #texto .vb-par');
    let k = -1;
    pars.forEach((el, i) => { if (Number(el.dataset.t) <= audio.currentTime + 0.05) k = i; });
    if (!pars.length) { suena = -1; return; }
    if (k < 0) k = 0;
    const cambio = k !== suena || !pars[k].classList.contains('is-suena');
    if (!cambio) return;
    suena = k;
    pars.forEach((el, i) => el.classList.toggle('is-suena', i === k));
    if (llevar && seguir) {
      const sc = document.querySelector('#view #texto');
      sc.scrollTo({ top: Math.max(0, pars[k].offsetTop - sc.clientHeight * 0.3), behavior: 'smooth' });
    }
  }

  function tic() {
    ahora.textContent = reloj(audio.currentTime);
    dibujar();
    marcar();
  }
  function bucle() {
    cancelAnimationFrame(cuadro);
    const paso = () => { tic(); if (!audio.paused) cuadro = requestAnimationFrame(paso); };
    cuadro = requestAnimationFrame(paso);
  }

  function ir(seg, sonar = false) {
    audio.currentTime = Math.max(0, Math.min(duracion() - 0.05, seg));
    suena = -1;
    tic();
    if (sonar && audio.paused) audio.play().catch(() => {});
  }

  function alternar() {
    if (btn.disabled) return;
    if (audio.paused) audio.play().catch((err) => Toast.error('No se pudo reproducir', err.message)); else audio.pause();
  }

  function ponerVelocidad(v) {
    audio.playbackRate = v;
    vel.textContent = `${String(v).replace('.', ',')}×`;
  }

  function init() {
    audio = document.getElementById('pl-audio'); lienzo = document.getElementById('pl-onda');
    pista = document.getElementById('pl-pista'); btn = document.getElementById('pl-play');
    ahora = document.getElementById('pl-ahora'); total = document.getElementById('pl-total');
    vel = document.getElementById('pl-vel');
    btn.addEventListener('click', alternar);
    const estado = () => {
      const on = !audio.paused;
      btn.classList.toggle('is-b', on);
      btn.setAttribute('aria-label', on ? 'Pausar' : 'Reproducir');
      if (on) bucle();
    };
    audio.addEventListener('play', estado);
    audio.addEventListener('pause', estado);
    audio.addEventListener('ended', estado);
    audio.addEventListener('loadedmetadata', () => { total.textContent = ` / ${reloj(duracion())}`; dibujar(); });
    audio.addEventListener('seeked', tic);
    audio.addEventListener('error', () => { if (id) { btn.disabled = true; Toast.error('No se puede reproducir el audio', 'El archivo ya no está, o Chromium no lee ese formato. El texto se puede leer igual.'); } });
    // arrastrar sobre la onda: va a ese punto
    const aPunto = (e) => { const r = pista.getBoundingClientRect(); ir(((e.clientX - r.left) / r.width) * duracion()); };
    pista.addEventListener('pointerdown', (e) => {
      if (btn.disabled) return;
      pista.setPointerCapture(e.pointerId);
      aPunto(e);
      const mover = (ev) => aPunto(ev);
      const soltarlo = () => { pista.removeEventListener('pointermove', mover); pista.removeEventListener('pointerup', soltarlo); pista.removeEventListener('pointercancel', soltarlo); };
      pista.addEventListener('pointermove', mover);
      pista.addEventListener('pointerup', soltarlo);
      pista.addEventListener('pointercancel', soltarlo);
    });
    vel.addEventListener('click', () => {
      const v = VELOCIDADES[(VELOCIDADES.indexOf(audio.playbackRate) + 1) % VELOCIDADES.length];
      ponerVelocidad(v);
      persist({ velocidad: v });
    });
    seguir = S.settings.seguirAudio !== false;
    const sw = document.getElementById('pl-seguir');
    sw.classList.toggle('is-on', seguir);
    bindToggle(sw, (on) => { seguir = on; persist({ seguirAudio: on }); if (on) { suena = -1; marcar(); } });
    new ResizeObserver(dibujar).observe(pista);
  }

  function cargar(v) {
    picos = v.picos || [];
    bajos = v.parrafos.filter((p) => p.baja).map((p) => [p.t, p.e]);
    dur = v.clase.dur || 0;
    if (id === v.clase.id) { dibujar(); return; }
    id = v.clase.id;
    suena = -1;
    btn.disabled = !v.hayAudio;
    total.textContent = ` / ${reloj(dur)}`;
    ahora.textContent = '0:00';
    if (v.hayAudio) { audio.src = v.url; audio.load(); } else { audio.removeAttribute('src'); audio.load(); }
    ponerVelocidad(VELOCIDADES.includes(S.settings.velocidad) ? S.settings.velocidad : 1);
    dibujar();
  }

  function soltar() {
    if (!id) return;
    id = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  return { init, cargar, soltar, ir, alternar, marcar, dibujar, get id() { return id; } };
})();

/* ══ Exportar ════════════════════════════════════════════════════════════════ */

async function exportar(id, formato) {
  await attempt(async () => {
    let r = await V.exportar(id, formato, false);
    if (r.existe) {
      const nombre = r.ruta.split(/[\\/]/).pop();
      const ok = await Modal.confirm({
        title: `Ya existe «${nombre}»`,
        sub: 'Está al lado del audio. Si seguís, se reemplaza por esta versión.',
        confirmLabel: 'Reemplazar',
      });
      if (!ok) return;
      r = await V.exportar(id, formato, true);
    }
    Toast.show({ title: 'Guardado al lado del audio', text: r.ruta, icon: 'download' });
  }, { errorTitle: 'No se pudo exportar' });
}

function menuExportar(btn, id) {
  Menu.show(btn, [
    ...S.formatos.map((f) => ({ label: f.nombre, key: f.ext, icon: 'file', onSelect: () => exportar(id, f.id) })),
    { sep: true },
    { label: 'Copiar el texto', icon: 'copy', onSelect: () => attempt(async () => copy(await V.texto(id), { label: 'Texto copiado' })) },
    { label: 'Mostrar el audio en la carpeta', icon: 'folder', onSelect: () => attempt(() => V.mostrar(S.clases.get(id)?.audio), { errorTitle: 'No se pudo mostrar' }) },
  ], { align: 'end' });
}

/* ══ Menú de una clase ═══════════════════════════════════════════════════════ */

async function editarClase(id) {
  const c = S.clases.get(id);
  if (!c) return;
  const body = document.createElement('div');
  body.className = 'op-col';
  body.style.gap = '16px';
  body.innerHTML = `
    <div class="op-field"><label class="op-field__label">Nombre</label><input class="op-input" id="ed-nombre" spellcheck="false"></div>
    <div class="op-field"><label class="op-field__label">Materia</label>
      <button class="op-select" id="ed-materia" style="max-width:240px"><span class="op-select__value"></span>${Icons.svg('chevronDown')}</button>
      <span class="op-field__hint">La materia decide qué vocabulario de correcciones se le aplica.</span></div>`;
  const nombre = body.querySelector('#ed-nombre');
  nombre.value = c.nombre;
  const materia = selectorMateria(body.querySelector('#ed-materia'), c.materia);
  const ok = await Modal.show({
    title: 'Editar la clase', body, width: 440,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Guardar', value: true, variant: 'primary' }],
  });
  if (!ok) return;
  await attempt(() => V.editar(id, { nombre: nombre.value, materia: materia() }), { errorTitle: 'No se pudo guardar' });
}

async function quitarClase(id) {
  const c = S.clases.get(id);
  if (!c) return;
  const lista_ = c.estado === 'lista';
  const ok = await Modal.confirm({
    title: lista_ ? `¿Quitar «${c.nombre}» de la biblioteca?` : `¿Quitar «${c.nombre}» de la cola?`,
    sub: lista_
      ? 'Se borra la transcripción guardada en Verba. El audio y lo que hayas exportado quedan donde están.'
      : c.estado === 'corriendo' ? 'Se corta la transcripción que está en curso. El audio queda donde está.' : 'El audio queda donde está.',
    confirmLabel: 'Quitar',
    danger: true,
  });
  if (!ok) return;
  await attempt(() => V.quitar(id), { errorTitle: 'No se pudo quitar' });
}

const MENUS = {
  clase: (id) => {
    const c = S.clases.get(id);
    if (!c) return [];
    const mostrar = { label: 'Mostrar el audio en la carpeta', icon: 'folder', onSelect: () => attempt(() => V.mostrar(c.audio), { errorTitle: 'No se pudo mostrar' }) };
    if (c.estado !== 'lista') {
      return [
        ...(c.estado === 'error' ? [{ label: 'Volver a intentar', icon: 'retry', onSelect: () => attempt(() => V.reintentar(id)) }] : []),
        { label: 'Editar…', icon: 'edit', onSelect: () => editarClase(id) },
        mostrar,
        { sep: true },
        { label: c.estado === 'corriendo' ? 'Cortar y quitar' : 'Quitar de la cola', icon: 'trash', danger: true, onSelect: () => quitarClase(id) },
      ];
    }
    return [
      ...(Router.name === 'clase' ? [] : [{ label: 'Abrir', icon: 'external', onSelect: () => abrirClase(id) }]),
      { label: 'Editar…', icon: 'edit', onSelect: () => editarClase(id) },
      mostrar,
      { sep: true },
      { label: 'Quitar de la biblioteca', icon: 'trash', danger: true, onSelect: () => quitarClase(id) },
    ];
  },
};

/* ══ Vista: Vocabularios ═════════════════════════════════════════════════════ */

function viewVocabularios() {
  const ms = Object.keys(S.vocab.materias);
  paint(head({
    title: 'Vocabularios',
    sub: 'Términos y correcciones por materia. Cada clase nueva los hereda.',
    actions: '<button class="op-btn op-btn--primary op-flashable" data-action="nueva-materia"><i data-icon="plus"></i> Nueva materia</button>',
  }) + (ms.length ? `
    <div class="op-scroll op-grow"><div class="vb-vocs">${ms.map((m) => {
    const d = S.vocab.materias[m];
    const n = lista().filter((c) => c.materia === m).length;
    return `<section class="vb-voc" data-materia="${esc(m)}">
        <div class="vb-voc__head">
          <div class="op-grow" style="min-width:0"><div class="vb-voc__nombre op-truncate">${esc(m)}</div><div class="op-meta">${n ? plural(n, 'clase', 'clases') : 'Sin clases todavía'}</div></div>
          <button class="op-iconbtn op-iconbtn--sm" data-action="quitar-materia" data-arg="${esc(m)}" data-tip="Quitar la materia">${Icons.svg('trash')}</button>
        </div>
        <div class="op-field">
          <label class="vb-voc__rotulo">Términos</label>
          <textarea class="op-textarea" rows="3" spellcheck="false" data-terminos="${esc(m)}" placeholder="Nombres y palabras técnicas, separados por coma">${esc(d.terminos || '')}</textarea>
        </div>
        <div>
          <div class="vb-voc__rotulo" style="margin-bottom:6px">Correcciones</div>
          ${d.correcciones.length ? d.correcciones.map((c, i) => `<div class="vb-pareja">
            <span class="vb-pareja__de">${esc(c.de)}</span>${Icons.svg('arrowRight')}<span>${esc(c.a)}</span>
            <button class="op-iconbtn op-iconbtn--sm" data-action="voc-quitar" data-arg="${i}" data-tip="Sacar">${Icons.svg('close')}</button></div>`).join('')
        : '<p class="vb-vacio">Ninguna todavía. Se agregan acá o desde una clase abierta.</p>'}
          <div class="vb-nueva" style="margin-top:8px">
            <input class="op-input" spellcheck="false" placeholder="Lo que escribe Whisper" data-de aria-label="Lo que escribe Whisper">
            <input class="op-input" spellcheck="false" placeholder="Cómo va" data-a aria-label="Cómo va">
            <button class="op-iconbtn" data-action="voc-agregar" data-tip="Agregar">${Icons.svg('plus')}</button>
          </div>
        </div>
      </section>`;
  }).join('')}</div><div style="height:32px"></div></div>`
    : empty({ icon: 'book', title: 'No hay materias', text: 'Creá una para guardarle los términos y las correcciones que comparten sus clases.' })));

  // Los términos se guardan al salir del campo. El nodo muere con el pintado.
  viewEl().querySelectorAll('[data-terminos]').forEach((t) => t.addEventListener('blur', () => {
    const m = t.dataset.terminos;
    if (t.value === (S.vocab.materias[m]?.terminos || '')) return;
    attempt(async () => { S.vocab = await V.guardarMateria(m, { terminos: t.value }); }, { errorTitle: 'No se pudieron guardar los términos' });
  }));
}

async function vocCambiar(materia, correcciones) {
  await attempt(async () => {
    S.vocab = await V.guardarMateria(materia, { correcciones });
    Router.refresh();
  }, { errorTitle: 'No se pudo guardar el vocabulario' });
}

async function nuevaMateria() {
  const body = document.createElement('div');
  body.className = 'op-field';
  body.innerHTML = '<label class="op-field__label">Nombre</label><input class="op-input" spellcheck="false" placeholder="Farmacognosia">';
  const input = body.querySelector('input');
  const ok = await Modal.show({
    title: 'Nueva materia', body, width: 400,
    actions: [{ label: 'Cancelar', value: null }, { label: 'Crear', value: true, variant: 'primary' }],
  });
  const nombre = input.value.trim();
  if (!ok || !nombre) return;
  if (S.vocab.materias[nombre]) { Toast.show({ title: 'Esa materia ya existe', text: nombre, icon: 'info' }); return; }
  await attempt(async () => {
    S.vocab = await V.guardarMateria(nombre, {});
    updateChrome();
    if (Router.name === 'vocabularios') Router.refresh();
  }, { errorTitle: 'No se pudo crear la materia' });
}

async function quitarMateria(m) {
  const n = lista().filter((c) => c.materia === m).length;
  const ok = await Modal.confirm({
    title: `¿Quitar ${m}?`,
    sub: `Se borran sus términos y sus correcciones.${n ? ` ${n === 1 ? 'Su clase queda' : `Sus ${n} clases quedan`} en la biblioteca, sin vocabulario.` : ''}`,
    confirmLabel: 'Quitar',
    danger: true,
  });
  if (!ok) return;
  await attempt(async () => {
    S.vocab = await V.quitarMateria(m);
    updateChrome();
    Router.refresh();
  }, { errorTitle: 'No se pudo quitar' });
}

/* ══ Vista: Ajustes ══════════════════════════════════════════════════════════ */

const MODELOS = ['large-v3-turbo', 'large-v3', 'medium', 'small'];

function viewAjustes() {
  const st = S.settings;
  paint(head({ title: 'Ajustes' }) + `
    <div class="op-scroll op-grow">
      <div style="max-width:620px">

        <div class="op-section">
          <div class="op-section__head"><span class="op-section__title">Motor</span></div>
          <div class="op-card"><div class="op-card__body op-col" style="gap:18px">
            <div class="op-field">
              <label class="op-field__label">Modelo</label>
              <button class="op-select" id="set-modelo" style="max-width:240px"><span class="op-select__value">${esc(st.modelo)}</span><i data-icon="chevronDown"></i></button>
              <span class="op-field__hint">Vale desde el próximo audio. Uno que no esté bajado, Whisper lo descarga la primera vez que se usa.</span>
            </div>
            <div class="op-field">
              <label class="op-field__label">Idioma</label>
              <div class="op-segmented" id="set-idioma" style="max-width:280px">
                <button class="op-segmented__opt${st.idioma !== 'auto' ? ' is-active' : ''}" data-value="es">Español</button>
                <button class="op-segmented__opt${st.idioma === 'auto' ? ' is-active' : ''}" data-value="auto">Que lo detecte</button>
              </div>
            </div>
            <div class="op-field">
              <label class="op-field__label">Python</label>
              <input class="op-input op-input--mono" id="set-python" spellcheck="false" value="${esc(st.python || 'python')}">
              <span class="op-field__hint">El Python que tiene instalado openai-whisper y torch. Vale desde la próxima vez que arranque el motor.</span>
            </div>
            <div class="op-kv">
              <span class="op-kv__k">Corre en</span><span class="op-kv__v">${esc(S.motor.gpu || (S.motor.dispositivo === 'cpu' ? 'CPU' : 'Se sabe cuando arranca el motor'))}</span>
            </div>
          </div></div>
        </div>

        <div class="op-section">
          <div class="op-section__head"><span class="op-section__title">Datos</span></div>
          <div class="op-card"><div class="op-card__body">
            <div class="op-kv">
              <span class="op-kv__k">Carpeta</span>
              <span class="op-kv__v op-mono op-copyable" data-copy="${esc(S.info?.dataDir || '')}">${esc(S.info?.dataDir || '')}</span>
              <span class="op-kv__k">Clases</span><span class="op-kv__v op-num">${S.clases.size}</span>
            </div>
            <p class="op-meta" style="margin-top:14px;line-height:1.65">
              Cada clase es un JSON con el texto de Whisper tal como salió. Los audios no se copian:
              Verba guarda la ruta y los lee de donde están.
            </p>
          </div></div>
        </div>

        <div class="op-section">
          <div class="op-section__head"><span class="op-section__title">Acerca de</span></div>
          <div class="op-card"><div class="op-card__body">
            <div class="op-kv">
              <span class="op-kv__k">App</span><span class="op-kv__v">${esc(S.info?.name || '')} ${esc(S.info?.version || '')}</span>
              <span class="op-kv__k">Electron</span><span class="op-kv__v op-mono">${esc(S.info?.electron || '')}</span>
            </div>
          </div></div>
        </div>

      </div>
      <div style="height:32px"></div>
    </div>`);

  const modelo = document.getElementById('set-modelo');
  modelo.addEventListener('click', (e) => {
    e.stopPropagation();
    Menu.show(modelo, MODELOS.map((m) => ({
      label: m, selected: S.settings.modelo === m,
      onSelect: () => { swapText(modelo.querySelector('.op-select__value'), m, { relevo: true }); persist({ modelo: m }); },
    })));
  });
  bindSwitcher(document.getElementById('set-idioma'), (value) => persist({ idioma: value }));
  const py = document.getElementById('set-python');
  py.addEventListener('blur', () => { const v = py.value.trim() || 'python'; if (v !== S.settings.python) persist({ python: v }); });
}

function viewPiezas() {
  paint(head({ title: 'Piezas', sub: 'Todos los primitivos de Opal, vivos' }) + designHTML());
  wireDesign(viewEl());
}

/* ══ La ventana ══════════════════════════════════════════════════════════════ */

/* Verba es solo la variante oscura de Opal: ventana opaca, vidrio en las hojas.
   Un `vidrio` guardado de cuando existía la opción se ignora. */
function aplicarVentana() {
  api?.win?.setAcrilico?.(false);
  Shell.set({ vidrio: 'tarjeta' });
}

async function persist(patch) {
  S.settings = { ...S.settings, ...patch };
  const saved = await attempt(() => api.settings.save(patch), { errorTitle: 'No se pudieron guardar los ajustes' });
  if (saved) S.settings = saved;
  updateChrome();
}

/* ══ Router ══════════════════════════════════════════════════════════════════ */

Router.define({
  cola: { view: viewCola },
  biblioteca: { view: viewBiblioteca },
  clase: { view: viewClase, nav: 'biblioteca' },
  vocabularios: { view: viewVocabularios },
  ajustes: { view: viewAjustes },
  piezas: { view: viewPiezas },
}, document.getElementById('view'));

/* ══ Shell ═══════════════════════════════════════════════════════════════════ */

function wireShell() {
  const w = api?.win;
  document.getElementById('win-min')?.addEventListener('click', () => w?.minimize());
  document.getElementById('win-close')?.addEventListener('click', () => w?.close());
  const maxBtn = document.getElementById('win-max');
  maxBtn?.addEventListener('click', () => w?.toggleMaximize());
  w?.onMaximized((isMax) => {
    maxBtn.classList.toggle('is-b', isMax);
    maxBtn.setAttribute('aria-label', isMax ? 'Restaurar' : 'Maximizar');
  });

  document.getElementById('btn-agregar')?.addEventListener('click', () => agregar());

  /* Delegación global: las vistas se repintan enteras y el panel se releva,
     así que el cableado se hace una sola vez acá y sobrevive a todo. */
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('.op-navitem');
    if (nav) { nav.dataset.materia ? Router.go('biblioteca', nav.dataset.materia) : Router.go(nav.dataset.view); return; }

    const goto = e.target.closest('[data-goto]');
    if (goto) { Router.go(goto.dataset.goto, goto.dataset.param || null); return; }

    const cp = e.target.closest('[data-copy]');
    if (cp) { copy(cp.dataset.copy); return; }

    const trigger = e.target.closest('[data-menu]');
    if (trigger) {
      e.stopPropagation();
      const items = MENUS[trigger.dataset.menu]?.(trigger.dataset.menuArg) || [];
      if (items.length) Menu.show(trigger, items, { align: 'end' });
      return;
    }

    const exp = e.target.closest('#btn-exportar');
    if (exp) { e.stopPropagation(); menuExportar(exp, Router.param); return; }

    const seg = e.target.closest('[data-seg]');
    if (seg) { Player.ir(Number(seg.dataset.seg), true); return; }

    const act = e.target.closest('[data-action]');
    if (act) {
      const a = act.dataset.action, arg = act.dataset.arg;
      if (a === 'agregar') agregar();
      if (a === 'reintentar') attempt(() => V.reintentar(arg), { errorTitle: 'No se pudo mandar a la cola' });
      if (a === 'rehacer') rehacer();
      if (a === 'agregar-corr') agregarCorreccion();
      if (a === 'quitar-corr') {
        const m = S.abierta?.clase.materia;
        guardarCorrecciones((S.vocab.materias[m]?.correcciones || []).filter((_, i) => i !== Number(arg)));
      }
      if (a === 'terminos-a-materia') {
        const m = S.abierta?.clase.materia, campo = document.querySelector('#panel #pn-terminos');
        if (m && campo) attempt(async () => {
          S.vocab = await V.guardarMateria(m, { terminos: campo.value });
          Toast.show({ title: `Términos de ${m} guardados`, text: plural(contarTerminos(campo.value), 'término', 'términos'), icon: 'check' });
        }, { errorTitle: 'No se pudieron guardar los términos' });
      }
      if (a === 'nueva-materia') nuevaMateria();
      if (a === 'quitar-materia') quitarMateria(arg);
      if (a === 'voc-quitar' || a === 'voc-agregar') {
        const caja = act.closest('[data-materia]'), m = caja?.dataset.materia;
        const actuales = S.vocab.materias[m]?.correcciones || [];
        if (a === 'voc-quitar') vocCambiar(m, actuales.filter((_, i) => i !== Number(arg)));
        else {
          const de = caja.querySelector('[data-de]'), ha = caja.querySelector('[data-a]');
          const d = de.value.trim(), h = ha.value.trim();
          if (!d || !h) { (d ? ha : de).focus(); return; }
          vocCambiar(m, [...actuales.filter((c) => c.de.toLowerCase() !== d.toLowerCase()), { de: d, a: h }]);
        }
      }
      return;
    }

    const fila = e.target.closest('[data-abrir]');
    if (fila) { abrirClase(fila.dataset.abrir); return; }

    // Un click en un párrafo lleva el audio ahí, salvo que se esté seleccionando texto.
    const par = e.target.closest('#view #texto .vb-par');
    if (par && !String(getSelection()).trim()) Player.ir(Number(par.dataset.t));
  });

  // Pasar por una corrección del panel señala dónde cae en el texto.
  const panel = document.getElementById('panel');
  const luz = (fx, on) => document.querySelectorAll(`#view .vb-fx[data-fx="${fx}"]`).forEach((el) => el.classList.toggle('is-luz', on));
  panel.addEventListener('mouseover', (e) => { const c = e.target.closest('.vb-corr'); if (c) luz(c.dataset.fx, true); });
  panel.addEventListener('mouseout', (e) => { const c = e.target.closest('.vb-corr'); if (c && !c.contains(e.relatedTarget)) luz(c.dataset.fx, false); });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#pn-de, #pn-a')) { e.preventDefault(); agregarCorreccion(); }
  });

  document.addEventListener('keydown', (e) => {
    const enCampo = e.target.closest?.('input, textarea, [contenteditable]');
    // Enter y Espacio sobre una fila: la lista tiene que ser usable sin mouse.
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-abrir]')) { e.preventDefault(); abrirClase(e.target.dataset.abrir); return; }
    if (e.key === 'Enter' && e.target.matches?.('.vb-voc [data-de], .vb-voc [data-a]')) {
      e.preventDefault();
      e.target.closest('.vb-voc').querySelector('[data-action="voc-agregar"]').click();
      return;
    }
    // Espacio reproduce o pausa mientras se lee una clase.
    if (e.key === ' ' && Router.name === 'clase' && !enCampo && !e.target.closest?.('button') && !document.querySelector('#op-layer .op-modal') && !Menu.isOpen) {
      e.preventDefault();
      Player.alternar();
    }
  });

  /* Soltar audios sobre la ventana, en cualquier vista. La zona de la Cola se
     enciende mientras hay algo arriba. */
  let encima = 0;
  const zona = () => document.querySelector('#view #drop');
  const conArchivos = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!conArchivos(e)) return; encima++; zona()?.classList.add('is-sobre'); });
  addEventListener('dragleave', (e) => { if (!conArchivos(e)) return; encima = Math.max(0, encima - 1); if (!encima) zona()?.classList.remove('is-sobre'); });
  addEventListener('dragover', (e) => { if (conArchivos(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  addEventListener('drop', (e) => {
    if (!conArchivos(e)) return;
    e.preventDefault();
    encima = 0;
    zona()?.classList.remove('is-sobre');
    alSoltar(e.dataTransfer.files);
  });
}

/** Todo lo que vive fuera de la vista: el rail, la statusbar, el contexto. */
let firmaMaterias = '';
function updateChrome() {
  contador(document.getElementById('n-cola'), pendientes().filter((c) => c.estado !== 'error').length);
  contador(document.getElementById('n-biblioteca'), listas().length);

  // las materias del rail: se rehacen solo si cambió la lista o un número
  const ms = materias().map((m) => [m, listas(m).length]);
  const firma = JSON.stringify(ms);
  const caja = document.getElementById('rail-materias');
  if (firma !== firmaMaterias) {
    firmaMaterias = firma;
    caja.innerHTML = ms.map(([m, n]) => `<button class="op-navitem" data-materia="${esc(m)}">
      <span class="vb-materia__punto"></span><span class="op-truncate">${esc(m)}</span><span class="op-navitem__count">${n || ''}</span></button>`).join('');
  }
  const filtro = Router.name === 'biblioteca' ? Router.param : null;
  caja.querySelectorAll('.op-navitem').forEach((b) => b.classList.toggle('is-active', b.dataset.materia === filtro));
  if (filtro) document.getElementById('nav-biblioteca').classList.remove('is-active');

  // la statusbar
  const m = S.motor, c = m.corriendo ? S.clases.get(m.corriendo) : null;
  const quedan = pendientes().filter((x) => x.estado === 'cola').length;
  const texto = {
    apagado: 'Motor apagado',
    ocioso: 'Motor en espera',
    arrancando: 'Iniciando el motor',
    cargando: `Cargando ${m.modelo || 'el modelo'}`,
    transcribiendo: `Transcribiendo ${c?.nombre || ''}${quedan ? ` · ${quedan === 1 ? 'queda 1' : `quedan ${quedan}`} en la cola` : ''}`,
  }[m.fase] || '';
  const vivo = m.fase === 'arrancando' || m.fase === 'cargando' || m.fase === 'transcribiendo';
  swap(document.getElementById('stat-motor'), `${mark(vivo ? 'running' : 'idle')}<span>${esc(texto)}</span>`, { relevo: true });
  swapText(document.getElementById('stat-equipo'), [m.modelo || S.settings.modelo, m.gpu || (m.dispositivo === 'cpu' ? 'CPU' : '')].filter(Boolean).join(' · '));

  const ctx = document.getElementById('titlebar-context');
  const abierta = Router.name === 'clase' ? S.clases.get(Router.param) : null;
  ctx.innerHTML = abierta ? `${Icons.svg('onda', 'op-icon--sm')}<span>${esc(abierta.nombre)}</span>` : '';
}

/** El panel y el reproductor acompañan a la vista: solo con una clase lista abierta. */
function alNavegar() {
  const leyendo = Router.name === 'clase' && S.abierta?.clase.estado === 'lista';
  if (!leyendo) { Shell.set({ panel: false, composer: false }); Player.soltar(); }
  pintarPanel();
  updateChrome();
}

function syncWindowColor() {
  const hex = colorToken('--op-bg');
  if (hex) api?.win?.setBackground(hex);
}

/* Un archivo de datos ilegible se aparta (store.cjs) y la app arranca sin él.
   Sin este aviso, para la persona sus datos simplemente desaparecieron. */
async function tellAsides() {
  const list = await api.asides().catch(() => []);
  if (!list.length) return;
  const files = [...new Set(list.map((a) => a.file))];
  Toast.show({
    tone: 'error',
    duration: 0,
    title: files.length === 1 ? `${files[0]} estaba dañado` : `${files.join(', ')} estaban dañados`,
    text: `${files.length === 1 ? 'Quedó' : 'Quedaron'} aparte en la carpeta de datos, con «.corrupto-» en el nombre, y la app arrancó sin ${files.length === 1 ? 'él' : 'ellos'}.`,
  });
}

/* ══ Arranque ════════════════════════════════════════════════════════════════ */

async function boot() {
  Icons.mount(document);
  Tooltip.init();
  FieldMenu.init();
  initClickFlash();
  initScrollFades();
  Shell.init();
  wireShell();
  syncWindowColor();

  try {
    await loadAll();
  } catch (err) {
    paint(empty({ icon: 'alert', title: 'No se pudo iniciar', text: err.message }));
    console.error(err);
    return;
  }

  if (S.info.dev) document.getElementById('nav-piezas').hidden = false;
  Player.init();
  aplicarVentana(S.settings);
  V.onEvento(alEvento);
  Router.onChange(alNavegar);
  // Con algo en la cola se abre ahí; si no, en la biblioteca.
  Router.go(pendientes().length || !listas().length ? 'cola' : 'biblioteca');
  tellAsides();

  // El splash se va recién cuando ya hay algo pintado debajo.
  raf2(() => {
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    splash.style.opacity = '0';
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
    setTimeout(() => splash.remove(), 600);
  });
}

boot();
