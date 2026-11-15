/* ═══════════════════════════════════════════════════════════════════════════
   OPAL — terminal
   Una terminal dibujada (.op-term en surfaces.css): un prompt, un cursor de
   bloque con resplandor, historial y comandos que pone la app. No corre nada
   de verdad: los comandos son funciones de JS que escriben líneas.

     const t = Terminal.mount(host, {
       id: 'demo',                        // la historia sobrevive a la vista
       banner: ['línea', …],              // lo que se ve la primera vez
       commands: {
         eco: (args, t) => t.write([t.esc(args.join(' ')), '']),
       },
     });

   Lo que recibe cada comando como `t`:
     write(lineas)     agrega líneas (HTML: lo que venga de afuera va con esc)
     clear()           limpia la pantalla
     esc(texto)        escapa para HTML
     dim(html) hi(html) err(html)   los tres tonos: apagado, acento, error
     sleep(ms)         para escribir de a poco; Ctrl+C lo corta (cortado())
     cortado()         true si la persona apretó Ctrl+C mientras corría
     cwd / setCwd(p)   la carpeta del prompt

   El campo de verdad es un textarea invisible: así andan pegar, el IME,
   Ctrl+Retroceso y elegir con Mayús+flechas sin escribir un editor de línea.
   El cursor se repinta en la posición del caret después de cada tecla.

   Teclas: Enter ejecuta · flechas arriba y abajo recorren el historial ·
   Tab completa el nombre del comando · Ctrl+L limpia · Ctrl+C sin selección
   corta la línea (o lo que esté corriendo); con selección, copia.
   ═══════════════════════════════════════════════════════════════════════════ */

const ESTADOS = new Map();   // id → { lines, hist, draft, cwd, busy }

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dim = (h) => `<span class="op-term__dim">${h}</span>`;
const hi = (h) => `<span class="op-term__hi">${h}</span>`;
const err = (h) => `<span class="op-term__err">${h}</span>`;

/* Una sola vez para toda la app: el caret que se mueve con el mouse o con
   Mayús+flechas no dispara keydown, pero sí selectionchange. */
let repintarActiva = null;
document.addEventListener('selectionchange', () => repintarActiva?.());

function mount(host, { id = 'terminal', banner = [], commands = {}, cwd = 'C:\\' } = {}) {
  let st = ESTADOS.get(id);
  if (!st) {
    st = { lines: [...banner], hist: [], hi: -1, draft: '', cwd, busy: false };
    ESTADOS.set(id, st);
  }

  host.innerHTML = `<div class="op-term">
    <div class="op-term__out"></div><div class="op-term__line op-term__now"></div>
    <textarea class="op-term__input" rows="1" spellcheck="false" autocomplete="off" aria-label="Terminal"></textarea>
  </div>`;
  const term = host.firstElementChild;
  const out = term.querySelector('.op-term__out');
  const now = term.querySelector('.op-term__now');
  const inp = term.querySelector('.op-term__input');

  const prompt = () => `<span class="op-term__ps">PS </span><span class="op-term__cwd">${esc(st.cwd)}</span><span class="op-term__ps">&gt; </span>`;
  const linea = (html, nueva) => {
    const d = document.createElement('div');
    d.className = nueva ? 'op-term__line is-in' : 'op-term__line';
    d.innerHTML = html;
    return d;
  };

  function pintar() {
    if (!term.isConnected) return;
    const v = inp.value;
    const i = inp.selectionStart ?? v.length;
    st.draft = v;
    const cur = (ch) => `<span class="op-term__cur"><span>${ch ? esc(ch) : ' '}</span></span>`;
    now.innerHTML = st.busy ? cur('')
      : `${prompt()}<span class="op-term__cmd">${esc(v.slice(0, i))}${cur(v[i])}${esc(v.slice(i + 1))}</span>`;
    term.classList.toggle('is-busy', !!st.busy);
    term.scrollTop = term.scrollHeight;
  }

  /* Escribe en la terminal que se VE: un comando que sigue corriendo después
     de irse a otra vista y volver escribe en la montada de nuevo (st.ui). */
  function write(lines, nuevas = true) {
    for (const l of lines) {
      st.lines.push(l);
      if (st.ui.out.isConnected) st.ui.out.appendChild(linea(l, nuevas));
    }
    // Un tope: una salida larga no puede crecer para siempre en memoria.
    if (st.lines.length > 400) st.lines.splice(0, st.lines.length - 400);
    st.ui.pintar();
  }
  function clear() { st.lines = []; st.ui.out.replaceChildren(); st.ui.pintar(); }

  const api = {
    write, clear, esc, dim, hi, err,
    get cwd() { return st.cwd; },
    setCwd(p) { st.cwd = p; },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cortado: () => st.busy === 'cortar',
  };

  async function ejecutar(raw) {
    const cmd = raw.trim();
    write([`${prompt()}<span class="op-term__cmd">${esc(raw)}</span>`], false);
    inp.value = '';
    st.hi = -1;
    if (!cmd) return pintar();
    if (st.hist[st.hist.length - 1] !== cmd) st.hist.push(cmd);
    const [nombre, ...args] = cmd.split(/\s+/);
    const fn = commands[nombre.toLowerCase()];
    if (!fn) return write([err(`${esc(nombre)}: no se reconoce como un comando. Probá help.`), '']);
    st.busy = true;
    pintar();
    try {
      await fn(args, api);
    } catch (e) {
      write([err(esc(e?.message || String(e))), '']);
    } finally {
      const corto = st.busy === 'cortar';
      st.busy = false;
      if (corto) write([dim('^C'), '']); else st.ui.pintar();
    }
  }

  st.ui = { out, pintar };
  out.append(...st.lines.map((l) => linea(l, false)));
  inp.value = st.draft;

  let quieto = 0;
  const tecleo = () => {
    term.classList.add('is-typing');
    clearTimeout(quieto);
    quieto = setTimeout(() => term.classList.remove('is-typing'), 520);
  };
  const repintar = () => requestAnimationFrame(pintar);

  inp.addEventListener('focus', () => { term.classList.add('is-focus'); repintarActiva = repintar; });
  inp.addEventListener('blur', () => { term.classList.remove('is-focus'); if (repintarActiva === repintar) repintarActiva = null; });
  inp.addEventListener('input', () => { inp.value = inp.value.replace(/\r?\n/g, ''); tecleo(); repintar(); });
  inp.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const k = e.key.toLowerCase();
    if (st.busy) {
      // Corriendo, el teclado solo sirve para cortar.
      if (ctrl && k === 'c') st.busy = 'cortar';
      e.preventDefault();
      return;
    }
    tecleo();
    if (e.key === 'Enter') { e.preventDefault(); ejecutar(inp.value); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!st.hist.length) return;
      if (e.key === 'ArrowUp') st.hi = Math.max(0, (st.hi < 0 ? st.hist.length : st.hi) - 1);
      else if (st.hi >= 0) st.hi = st.hi + 1 >= st.hist.length ? -1 : st.hi + 1;
      inp.value = st.hi < 0 ? '' : st.hist[st.hi];
      inp.setSelectionRange(inp.value.length, inp.value.length);
      return repintar();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const v = inp.value;
      const hits = v ? Object.keys(commands).filter((c) => c.startsWith(v.toLowerCase())) : [];
      if (hits.length === 1) {
        inp.value = `${hits[0]} `;
        inp.setSelectionRange(inp.value.length, inp.value.length);
      } else if (hits.length > 1) {
        write([`${prompt()}<span class="op-term__cmd">${esc(v)}</span>`, hits.join('   ')], false);
      }
      return repintar();
    }
    if (ctrl && k === 'l') { e.preventDefault(); return clear(); }
    if (ctrl && k === 'c' && inp.selectionStart === inp.selectionEnd) {
      e.preventDefault();
      write([`${prompt()}<span class="op-term__cmd">${esc(inp.value)}</span>${dim('^C')}`], false);
      inp.value = '';
      return repintar();
    }
    repintar();
  });

  // Click en el pozo: el foco va al campo, salvo que se esté eligiendo texto.
  term.addEventListener('mouseup', () => { if (window.getSelection().isCollapsed) inp.focus({ preventScroll: true }); });

  pintar();
  return { ...api, focus: () => inp.focus({ preventScroll: true }), run: (cmd) => ejecutar(cmd) };
}

export const Terminal = { mount };
export default Terminal;
