'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Verba — el texto
   Todo lo que se hace con los segmentos de Whisper, sin tocar el disco ni
   Electron: medir la calidad, armar párrafos, aplicar las correcciones del
   vocabulario y escribir cada formato de salida. Es puro a propósito: lo usan
   el proceso principal y los tests con node pelado.

   Un segmento es { s, e, t, lp, ns, cr }: principio y fin en segundos, el
   texto, y avg_logprob, no_speech_prob y compression_ratio.
   ═══════════════════════════════════════════════════════════════════════════ */

const LP_ALTA = -0.3;     // por encima, Whisper estaba seguro
const LP_BAJA = -0.5;     // el promedio de un párrafo por debajo: confianza baja
const CR_BUCLE = 2.4;     // compresión por encima: se quedó repitiendo
const VENTANA = 55;       // segundos por párrafo
const TOPE = 85;          // y no más que esto aunque no haya un punto

/* Lo que Whisper escribe cuando no hay voz: un segmento entero que es solo
   esto. Dentro de una oración no cuenta. */
const INVENTO = /^(¡?(muchas )?gracias\.?!?|¡?gracias por (ver|mirar|escuchar).*|subt[ií]tulos? (por|realizados|creados).*|.*amara\.org.*|¡?suscr[ií]b(ete|anse).*)$/i;

const esInvento = (seg) => INVENTO.test(String(seg.t || '').trim());

function calidad(segs = []) {
  let total = 0, alta = 0, bucles = 0, inventos = 0;
  for (const g of segs) {
    if (esInvento(g)) { inventos++; continue; }
    const d = Math.max(0, g.e - g.s);
    total += d;
    if (g.lp > LP_ALTA) alta += d;
    if (g.cr > CR_BUCLE) bucles++;
  }
  return { alta: total ? Math.round((alta / total) * 100) : 0, bucles, inventos };
}

/* ── Tiempos ─────────────────────────────────────────────────────────────── */

const dos = (n) => String(n).padStart(2, '0');

/** 75 → «1:15», 3725 → «1:02:05». */
function reloj(seg) {
  const s = Math.max(0, Math.floor(seg));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${dos(m)}:${dos(s % 60)}` : `${m}:${dos(s % 60)}`;
}

/** 4 min 31 s, 1 h 26 min. */
function lapso(seg) {
  const s = Math.round(seg);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

function relojSrt(seg) {
  const ms = Math.max(0, Math.round(seg * 1000));
  return `${dos(Math.floor(ms / 3600000))}:${dos(Math.floor(ms / 60000) % 60)}:${dos(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
}

/* ── Correcciones ────────────────────────────────────────────────────────────
   [{ de, a }]: lo que Whisper escribe y lo que debería decir. Se aplican al
   mostrar y al exportar, nunca sobre lo guardado: sacar una corrección
   devuelve el texto original. Palabra entera, sin distinguir mayúsculas; si
   lo que estaba empezaba en mayúscula, lo corregido también. */

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function armarCorrector(correcciones = []) {
  const validas = correcciones
    .map((c, i) => ({ i, de: String(c?.de || '').trim(), a: String(c?.a || '').trim() }))
    .filter((c) => c.de && c.a && c.de.toLowerCase() !== c.a.toLowerCase());
  if (!validas.length) return null;
  const porTexto = new Map(validas.map((c) => [c.de.toLowerCase(), c]));
  const alternativas = [...porTexto.keys()].sort((x, y) => y.length - x.length).map(escRe).join('|');
  return { re: new RegExp(`(?<![\\p{L}\\p{N}])(${alternativas})(?![\\p{L}\\p{N}])`, 'giu'), porTexto };
}

/** El texto partido en partes: { t } o { t, fx: índice, de: lo que decía }. */
function corregir(texto, corrector) {
  if (!corrector) return [{ t: texto }];
  const partes = [];
  let desde = 0;
  corrector.re.lastIndex = 0;
  for (let m; (m = corrector.re.exec(texto));) {
    const c = corrector.porTexto.get(m[1].toLowerCase());
    if (!c) continue;
    if (m.index > desde) partes.push({ t: texto.slice(desde, m.index) });
    const mayus = m[1][0] !== m[1][0].toLowerCase() && c.a[0] === c.a[0].toLowerCase();
    partes.push({ t: mayus ? c.a[0].toUpperCase() + c.a.slice(1) : c.a, fx: c.i, de: m[1] });
    desde = m.index + m[1].length;
  }
  if (desde < texto.length) partes.push({ t: texto.slice(desde) });
  return partes;
}

const plano = (partes) => partes.map((p) => p.t).join('');

/* ── Párrafos ────────────────────────────────────────────────────────────────
   Tramos de unos 55 segundos que cortan en el fin de una oración. Cada uno
   lleva su minuto, si la confianza fue baja y el texto ya en partes. */

function parrafos(segs = [], correcciones = []) {
  const corrector = armarCorrector(correcciones);
  const usos = new Map();   // índice de corrección → [segundos]
  const out = [];
  let p = null;
  const cerrar = () => {
    if (!p) return;
    p.lp = p.peso ? p.suma / p.peso : 0;
    p.baja = p.peso > 0 && p.lp < LP_BAJA;
    delete p.suma; delete p.peso;
    out.push(p);
    p = null;
  };
  for (const g of segs) {
    const texto = String(g.t || '').trim();
    if (!texto) continue;
    if (!p) p = { t: g.s, e: g.e, partes: [], suma: 0, peso: 0 };
    if (p.partes.length) p.partes.push({ t: ' ' });
    if (esInvento(g)) {
      p.partes.push({ t: texto, inv: true });
    } else {
      for (const parte of corregir(texto, corrector)) {
        p.partes.push(parte);
        if (parte.fx != null) (usos.get(parte.fx) || usos.set(parte.fx, []).get(parte.fx)).push(g.s);
      }
      const d = Math.max(0.01, g.e - g.s);
      p.suma += g.lp * d; p.peso += d;
    }
    p.e = g.e;
    const largo = g.e - p.t;
    if ((largo >= VENTANA && /[.?!…]["»)]?$/.test(texto)) || largo >= TOPE) cerrar();
  }
  cerrar();
  return {
    parrafos: out,
    usos: [...usos.entries()].sort((a, b) => a[1][0] - b[1][0])
      .map(([i, en]) => ({ i, de: correcciones[i].de, a: correcciones[i].a, en })),
  };
}

/** El texto de un párrafo para exportar: corregido y sin los inventos. */
const textoDe = (p) => plano(p.partes.filter((x) => !x.inv)).replace(/\s+/g, ' ').trim();

/* ── Salidas ─────────────────────────────────────────────────────────────── */

function aMarkdown(clase, correcciones = []) {
  const { parrafos: ps, usos } = parrafos(clase.segs, correcciones);
  const q = calidad(clase.segs);
  const l = [`# ${clase.nombre}`, ''];
  l.push(`- **Audio:** ${clase.archivo}`);
  if (clase.materia) l.push(`- **Materia:** ${clase.materia}`);
  l.push(`- **Duración:** ${reloj(clase.dur || 0)}`);
  l.push(`- **Confianza alta:** ${q.alta} % del tiempo (logprob > −0,3)`);
  l.push(`- **Bucles:** ${q.bucles}`);
  l.push(`- **Posibles inventos en silencios:** ${q.inventos}`);
  if (clase.modelo) l.push(`- **Modelo:** ${clase.modelo}${clase.tardo ? `, transcripta en ${lapso(clase.tardo)}` : ''}`);
  l.push('', '## Transcripción', '');
  for (const p of ps) {
    const t = textoDe(p);
    if (t) l.push(`**[${reloj(p.t)}]** ${t}`, '');
  }
  if (usos.length) {
    l.push('## Correcciones aplicadas', '', '| Whisper escribió | Corregido a | Dónde |', '|---|---|---|');
    for (const u of usos) l.push(`| ${u.de} | ${u.a} | ${u.en.map(reloj).join(', ')} |`);
    l.push('');
  }
  const bajos = ps.filter((p) => p.baja && textoDe(p));
  const inv = (clase.segs || []).filter(esInvento);
  if (bajos.length || inv.length) {
    l.push('## Para chequear', '');
    for (const p of bajos) l.push(`- [${reloj(p.t)}] Confianza baja: «${textoDe(p).slice(0, 140)}${textoDe(p).length > 140 ? '…' : ''}»`);
    for (const g of inv) l.push(`- [${reloj(g.s)}] Posible invento en un silencio, sacado del texto: «${g.t}»`);
    l.push('');
  }
  return l.join('\n');
}

function aTexto(clase, correcciones = [], { tiempos = false } = {}) {
  const { parrafos: ps } = parrafos(clase.segs, correcciones);
  return ps.map((p) => ({ p, t: textoDe(p) })).filter((x) => x.t)
    .map(({ p, t }) => (tiempos ? `[${reloj(p.t)}] ${t}` : t)).join('\n\n') + '\n';
}

function aSrt(clase, correcciones = []) {
  const corrector = armarCorrector(correcciones);
  let n = 0;
  const l = [];
  for (const g of clase.segs || []) {
    if (esInvento(g) || !String(g.t || '').trim()) continue;
    l.push(String(++n), `${relojSrt(g.s)} --> ${relojSrt(g.e)}`, plano(corregir(g.t.trim(), corrector)), '');
  }
  return l.join('\n');
}

const FORMATOS = {
  md: { ext: '.md', nombre: 'Markdown con tiempos', escribir: aMarkdown },
  txt: { ext: '.txt', nombre: 'Texto corrido', escribir: (c, k) => aTexto(c, k) },
  tiempos: { ext: ' (con tiempos).txt', nombre: 'Texto con tiempos', escribir: (c, k) => aTexto(c, k, { tiempos: true }) },
  srt: { ext: '.srt', nombre: 'Subtítulos', escribir: aSrt },
};

module.exports = {
  LP_ALTA, LP_BAJA, CR_BUCLE, esInvento, calidad, reloj, lapso, relojSrt,
  armarCorrector, corregir, parrafos, textoDe, aMarkdown, aTexto, aSrt, FORMATOS,
};
