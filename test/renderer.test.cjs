/* ═══════════════════════════════════════════════════════════════════════════
   Humo del renderer: monta la app de verdad y la recorre.

   Se corre con `npm run smoke` (necesita Electron, por eso no está en el
   `npm test`, que es node pelado).

   Lo que busca es lo que un test de unidad NO ve: overlays que aterrizan fuera
   de pantalla, vistas que no montan, animaciones que se quedan quietas donde no
   se las ve, glifos unicode que se colaron. La regla que lo guía: **medí dónde
   CAE una cosa, no solo si existe**. El bug más caro de este sistema fue un
   modal que renderizaba en top:-281px — presente en el DOM, correcto en el
   HTML, e inalcanzable con el mouse.
   ═══════════════════════════════════════════════════════════════════════════ */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
/* Los datos del humo van a una carpeta propia que se borra al final: crear,
   guardar ajustes y apartar archivos no puede tocar los tuyos de data/. */
const OWN_DATA = !process.env.OPAL_DATA;
if (OWN_DATA) process.env.OPAL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'opal-humo-'));
const W = 1440; const H = 900;

/* El backgroundColor que main.cjs le pone a la ventana. El renderer se lo
   vuelve a mandar ya resuelto desde los tokens, y los dos tienen que coincidir:
   si no, el que se ve mientras el contenido no cubre la ventana es el otro. */
const BG_MAIN = (fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  .match(/const BG = '(#[0-9a-f]{6})'/i)?.[1] || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera hasta que fn() dé algo verdadero (o se acabe el tiempo) y lo devuelve. */
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    // Con tope por intento: con el renderer caído, executeJavaScript no vuelve nunca.
    try { const v = await Promise.race([fn(), sleep(1500).then(() => null)]); if (v) return v; } catch { /* todavía no */ }
    await sleep(120);
  }
  return null;
}

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };
const bail = (w, e) => { console.log(`ABORTADO ${w}`, e?.stack || e || ''); app.exit(3); };
process.on('unhandledRejection', (e) => bail('rechazo', e));
process.on('uncaughtException', (e) => bail('excepción', e));
setTimeout(() => bail('timeout de 180s'), 180000);

app.whenReady().then(async () => {
  require(path.join(ROOT, 'src', 'ipc.cjs')).register();
  /* El portapapeles de verdad es de la persona que corre el humo: el "Pegar"
     del menú de los campos lee uno de mentira. */
  const PEGADO = 'pegado de prueba';
  ipcMain.removeHandler('clip:read');
  ipcMain.handle('clip:read', () => ({ ok: true, data: PEGADO }));

  const win = new BrowserWindow({
    x: -20000, y: -20000, width: W, height: H,
    frame: false, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(ROOT, 'preload.cjs'), contextIsolation: true },
  });
  const errores = [];
  /* El nivel llega como texto ('warning', 'error') desde Electron 35: la
     comparación con números de antes no juntaba nada, y «CONSOLA: limpia»
     salía siempre, hubiera errores o no. */
  win.webContents.on('console-message', (e) => { if (e.level === 'warning' || e.level === 'error') errores.push(`${e.level}: ${e.message}`); });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.show();
  await sleep(2200);

  const js = (c) => win.webContents.executeJavaScript(c);
  // Clickear sin explotar si el selector no existe: un elemento faltante tiene
  // que reportarse como falla del test, no como excepción que aborta todo.
  const click = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true; })()`);
  // Un click real es pointerdown → pointerup → click, y varios overlays se
  // cierran en pointerdown. Con `el.click()` solo, el orden nunca se prueba.
  const tap = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.click(); return true; })()`);
  // Una tecla de verdad, por el canal de entrada de la ventana. Misma razón por
  // la que `tap` existe al lado de `click`: un evento fabricado a mano prueba el
  // manejador, no el camino que recorre la tecla hasta llegar a él.
  const escape = () => win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });

  console.log('\n1. Arranque');
  ok('el splash se fue', !(await js(`!!document.getElementById('boot-splash')`)));
  ok('el shell está montado', await js(`!!document.querySelector('.op-titlebar') && !!document.querySelector('.op-rail')`));
  ok('los <i data-icon> se reemplazaron por SVG', !(await js(`!!document.querySelector('i[data-icon]')`)));
  ok('la vista inicial pintó algo', (await js(`document.getElementById('view').children.length`)) > 0);

  console.log('\n2. Crear por la UI real: modal → disco');
  await click('#btn-new');
  await sleep(600);
  ok('el modal de creación abre', await js(`!!document.querySelector('.op-modal')`));
  await js(`(() => { document.getElementById('f-name').value='Humo';
    document.getElementById('f-note').value='creado por el test'; return true; })()`);
  await click('.op-modal__foot .op-btn--primary');
  await sleep(1200);

  const creado = await js(`window.opal.col('items').list().then(l => l.find(i => i.name === 'Humo') || null)`);
  const id = creado?.id;
  ok('quedó en disco con id asignado', !!id, JSON.stringify(creado));
  ok('la nota viajó entera', creado?.note === 'creado por el test');
  ok('el router saltó a su detalle', await js(`!!document.querySelector('.op-inspector')`));
  ok('los ajustes persisten', (await js(`window.opal.settings.save({ densidad:'amplia' }).then(s => s.densidad)`)) === 'amplia');

  console.log('\n3. Todas las vistas montan');
  for (const v of ['items', 'piezas', 'ajustes', 'inicio']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    const hijos = await js(`document.getElementById('view').children.length`);
    const activo = await js(`!!document.querySelector('[data-view="${v}"].is-active')`);
    ok(`${v}: pinta y queda activa en el rail`, hijos > 0 && activo, `hijos=${hijos} activo=${activo}`);
  }

  console.log('\n4. Router con parámetro');
  await click('[data-view="items"]');
  await sleep(600);
  ok('el ítem aparece en la lista', await click(`[data-open="${id}"]`));
  await sleep(800);
  ok('abre el detalle', await js(`!!document.querySelector('.op-inspector')`));
  ok('el rail sigue marcando la sección padre', await js(`!!document.querySelector('[data-view="items"].is-active')`));
  ok('las migas llevan de vuelta', await js(`!!document.querySelector('[data-goto="items"]')`));
  ok('la titlebar muestra el contexto', (await js(`document.getElementById('titlebar-context').textContent.trim()`)) === 'Humo');

  console.log('\n5. Overlays: dónde caen, no solo si existen');
  await click('[data-menu="item"]');
  await sleep(400);
  const menu = await js(`(() => { const m=document.querySelector('.op-menu'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {t:Math.round(r.top),l:Math.round(r.left),b:Math.round(r.bottom),rt:Math.round(r.right)}; })()`);
  ok('el menú abre dentro de la ventana',
    menu && menu.t >= 0 && menu.l >= 0 && menu.b <= H && menu.rt <= W, JSON.stringify(menu));
  await js(`document.body.click(); true`); await sleep(300);

  await click('[data-view="piezas"]');
  await sleep(900);
  await click('#demo-modal');
  await sleep(600);
  const modal = await js(`(() => { const m=document.querySelector('.op-modal'); if(!m) return null;
    const r=m.getBoundingClientRect(); return {cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),t:Math.round(r.top)}; })()`);
  ok('el modal queda CENTRADO en la ventana',
    modal && Math.abs(modal.cx - W / 2) < 4 && Math.abs(modal.cy - H / 2) < 4 && modal.t > 0, JSON.stringify(modal));
  await click('[data-dismiss]'); await sleep(400);

  // El toggle del menú. Volver a tocar el botón que lo abrió TIENE que cerrarlo.
  // Si no, se ve como un rebote: el manejador de click-afuera deja pasar al
  // ancla, el handler del botón vuelve a llamar a show(), y cierra+reabre en el
  // mismo gesto. Por eso acá va `tap` y no `click`: reproduce el orden real.
  const abierto = () => js(`!!document.querySelector('.op-menu')`);
  await tap('#demo-select');
  await sleep(400);
  ok('el select abre su menú', await abierto());
  await tap('#demo-select');
  await sleep(500);
  ok('volver a tocarlo lo CIERRA (no rebota)', !(await abierto()));
  ok('y el ancla suelta el estado abierto', !(await js(`!!document.querySelector('#demo-select.is-open')`)));

  await tap('#demo-select');
  await sleep(400);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await sleep(500);
  ok('y un click afuera también lo cierra', !(await abierto()));

  /* ── 5-bis. Escape con un menú abierto encima de un modal ──────────────────
     Modal y Menu escuchan los dos el keydown en `document` y en CAPTURA. Para
     el mismo nodo y la misma fase gana el que se registró primero, y ese es
     siempre el modal, que abrió antes. Resultado: desplegar un select adentro
     de un diálogo y arrepentirse con Escape cerraba el DIÁLOGO ENTERO y se
     perdía todo lo tipeado, en vez de cerrar solo el menú.

     Es un bug de orden de registro: no se ve leyendo ninguno de los dos módulos
     por separado —cada manejador, solo, es correcto— y vuelve apenas alguien
     reordene los overlays. Por eso se prueba acá y no en unidad: hace falta que
     los dos estén vivos al mismo tiempo.

     El modal de la vitrina no trae un select adentro, así que el escenario se
     arma: se abre el modal y se dispara el menú del select que quedó atrás. Que
     ese botón esté tapado por el scrim da igual — lo que se prueba es el estado
     «menú abierto encima de un modal», no dónde se puede clickear. */
  console.log('\n5-bis. Escape se lleva el menú, no el diálogo de atrás');
  await click('#demo-modal');
  await sleep(600);
  await click('#demo-select');
  await sleep(400);
  const hayModal = () => js(`!!document.querySelector('.op-modal')`);
  ok('con el diálogo abierto, el menú abre encima', (await abierto()) && (await hayModal()));

  escape();
  await sleep(600);
  ok('el primer Escape cierra SOLO el menú', !(await abierto()));
  ok('y el diálogo sigue en pie', await hayModal());

  escape();
  await sleep(600);
  ok('el segundo Escape sí cierra el diálogo', !(await hayModal()));

  /* ── 6. El medidor indeterminado ───────────────────────────────────────────
     Una pista vacía se lee como un componente roto, no como «esperando». Se
     muestrea el recorrido entero en vez de mirar un instante.

     SE MIDE LA RACHA, NO LAS MUESTRAS SUELTAS, y la diferencia importa. La
     barra recorre de -100% a 294% de su propio ancho, así que en el empalme del
     bucle queda un frame exactamente al filo de la pista: medido con
     requestAnimationFrame sobre dos ciclos completos —226 frames— el solape
     mínimo es 0.43 px, aparece UNA vez y no se repite nunca dos frames
     seguidos. Es el diseño, y está escrito así arriba de la animación.

     La versión anterior exigía «más de 1 px SIEMPRE», lo que convertía ese
     frame invisible en una falla y dejaba el resultado librado a dónde cayera
     el muestreo. Lo que de verdad hay que prohibir es que la pista quede vacía
     un RATO —lo único que un ojo alcanza a ver— y eso es una racha. */
  console.log('\n6. El medidor indeterminado nunca deja la pista vacía');
  const pista = await js(`(async () => {
    const m = document.querySelector('.op-meter--indeterminate');
    const f = m && m.querySelector('.op-meter__fill');
    if (!f) return { error: 'no existe' };
    const muestras = [];
    for (let i = 0; i < 40; i++) {
      const p = m.getBoundingClientRect(); const r = f.getBoundingClientRect();
      muestras.push(Math.min(r.right, p.right) - Math.max(r.left, p.left));
      await new Promise(res => setTimeout(res, 50));
    }
    let racha = 0; let peor = 0;
    for (const v of muestras) { if (v < 1) { racha++; peor = Math.max(peor, racha); } else racha = 0; }
    return { peor, min: Math.round(Math.min(...muestras) * 100) / 100, n: muestras.length };
  })()`);
  ok('la barra nunca falta dos muestras seguidas',
    pista && !pista.error && pista.peor <= 1, JSON.stringify(pista));

  console.log('\n6-bis. El campo numérico y sus flechas');
  /* Lo que se mide no es que el botón exista: es que el VALOR cambie, que el
     evento salga (los listeners de las apps escuchan al input, no al botón), y
     que el spinner de Chromium no esté asomando por debajo. */
  const paso = await js(`(async () => {
    const root = document.getElementById('demo-stepper');
    if (!root) return { error: 'no existe el stepper' };
    const input = root.querySelector('input[type="number"]');
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');

    let cambios = 0;
    input.addEventListener('change', () => cambios++);

    const tocar = (b) => {
      const o = { bubbles: true, pointerId: 1, pointerType: 'mouse' };
      b.dispatchEvent(new PointerEvent('pointerdown', o));
      b.dispatchEvent(new PointerEvent('pointerup', o));
    };

    input.value = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    tocar(arriba);
    const trasSubir = input.value;
    tocar(abajo); tocar(abajo);
    const trasBajar = input.value;

    // Al mínimo (1) la flecha de abajo tiene que quedar apagada.
    const abajoApagado = abajo.disabled;

    // Y al máximo (12), la de arriba.
    for (let i = 0; i < 20; i++) tocar(arriba);
    const tope = input.value;
    const arribaApagado = arriba.disabled;

    const spinner = getComputedStyle(input, '::-webkit-inner-spin-button');
    return {
      trasSubir, trasBajar, tope, cambios, abajoApagado, arribaApagado,
      spinnerOculto: spinner.appearance === 'none' || spinner.display === 'none',
      apariencia: getComputedStyle(input).appearance,
    };
  })()`);
  ok('subir suma uno', paso.trasSubir === '2', JSON.stringify(paso));
  ok('bajar no pasa del mínimo', paso.trasBajar === '1', paso.trasBajar);
  ok('y ahí la flecha de abajo se apaga', paso.abajoApagado === true);
  ok('no pasa del máximo', paso.tope === '12', paso.tope);
  ok('y ahí se apaga la de arriba', paso.arribaApagado === true);
  /* 1→2, 2→1 (el segundo click no mueve nada), y 11 subidas hasta 12. */
  ok('cada paso real despacha change', paso.cambios === 13, `${paso.cambios}`);
  ok('el input no muestra el control nativo', paso.apariencia === 'textfield', paso.apariencia);

  console.log('\n7. La fuente empaquetada carga de verdad');
  /* Éste es el chequeo que evita el fracaso silencioso: con CSP estricta y
     protocolo file://, un @font-face con la ruta mal puesta no tira error —
     el navegador cae a la de respaldo y todo "se ve bien". Por eso no alcanza
     con preguntar por --op-mono: hay que confirmar que la familia cargó Y que
     realmente cambia el ancho del texto. */
  const fuente = await js(`(async () => {
    await document.fonts.ready;
    const cargadas = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ':' + f.weight);
    const medir = (fam) => { const s = document.createElement('span');
      s.style.cssText = 'position:fixed;left:-9999px;font-size:64px;white-space:pre;font-family:' + fam;
      s.textContent = 'MMMiiilll0O1'; document.body.appendChild(s);
      const w = s.getBoundingClientRect().width; s.remove(); return Math.round(w); };
    return {
      cargadas,
      declarada: getComputedStyle(document.documentElement).getPropertyValue('--op-mono').trim(),
      roboto: medir("'Roboto Mono'"), serif: medir('serif'),
      disponible: document.fonts.check('400 13px "Roboto Mono"'),
    };
  })()`);
  ok('el @font-face resolvió a archivos reales', fuente.cargadas.length > 0, JSON.stringify(fuente.cargadas));
  ok('Roboto Mono está disponible para pintar', fuente.disponible, JSON.stringify(fuente));
  ok('y NO está cayendo a la de respaldo', fuente.roboto !== fuente.serif, `roboto=${fuente.roboto} serif=${fuente.serif}`);
  // Ojo: getComputedStyle RESUELVE el var(), así que acá se ve la familia final
  // y no la indirección. Que --op-mono apunte a un token se verifica sobre el
  // texto del CSS, en tokens.test.mjs.
  ok('la familia efectiva es la empaquetada', fuente.declarada.includes('Roboto Mono'), fuente.declarada);

  /* Los bloques (█ ▀ ▛…): Roboto Mono no los trae, y los de la fuente de
     respaldo no llenaban la celda (un dibujo de bloques, como el mascot de
     Claude Code en una terminal, salía rayado). fonts.css suma los propios
     (tools/bloques.mjs). Se mide que vengan de ahí y que tengan las medidas
     de la mono: el ancho de la W, de la línea de arriba a la de abajo, y la
     mitad donde va. Con los del respaldo fallan las cuatro. */
  const bloques = await js(`(async () => {
    const caras = await document.fonts.load('64px "Roboto Mono"', '█');
    const c = document.createElement('canvas').getContext('2d');
    c.font = '64px "Roboto Mono"';
    const w = c.measureText('W'), lleno = c.measureText('█'), arriba = c.measureText('▀');
    return {
      caras: caras.length,
      ancho: +(lleno.width - w.width).toFixed(2),
      sobraArriba: +(lleno.actualBoundingBoxAscent - w.fontBoundingBoxAscent).toFixed(2),
      sobraAbajo: +(lleno.actualBoundingBoxDescent - w.fontBoundingBoxDescent).toFixed(2),
      mitad: +(-arriba.actualBoundingBoxDescent - (w.fontBoundingBoxAscent - w.fontBoundingBoxDescent) / 2).toFixed(2),
    };
  })()`);
  ok('los bloques salen de los propios, no del respaldo', bloques.caras > 0, JSON.stringify(bloques));
  ok('un bloque mide lo mismo que la W', Math.abs(bloques.ancho) < 0.5, JSON.stringify(bloques));
  ok('y llena la línea de arriba a abajo', bloques.sobraArriba >= 0 && bloques.sobraAbajo >= 0, JSON.stringify(bloques));
  // El canvas redondea las medidas a pixeles enteros: a 64 px, la mitad cae a ±1 (con el respaldo, a -6).
  ok('el medio bloque corta en la mitad de la línea', Math.abs(bloques.mitad) <= 1.5, JSON.stringify(bloques));

  const monos = await js(`document.querySelectorAll('#knob-mono [data-mono]').length`);
  ok('la vitrina descubrió las monos declaradas', monos >= 2, `${monos}`);
  const antesMono = await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`);
  await click('#knob-mono [data-mono="sistema"]');
  await sleep(300);
  ok('cambiar la mono cambia lo que se pinta',
    (await js(`getComputedStyle(document.querySelector('#mono-sample')).fontFamily`)) !== antesMono);

  console.log('\n8. Las perillas re-tintan de verdad');
  const antes = await js(`getComputedStyle(document.body).backgroundColor`);
  await js(`(() => { const h=document.getElementById('knob-hue'); h.value=30; h.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(300);
  ok('cambiar el matiz cambia el fondo', (await js(`getComputedStyle(document.body).backgroundColor`)) !== antes);
  await click('#knob-reset');
  await sleep(300);
  ok('el reset vuelve al original', (await js(`getComputedStyle(document.body).backgroundColor`)) === antes);

  /* El color que el renderer le manda a la ventana.
     Va acá y no en tokens.test.mjs porque ese test compara ARCHIVOS: verifica
     que el hex de main.cjs derive del token. Este mide lo que pasa en tiempo
     de ejecución, que es otra cosa y es donde estuvo el bug — el renderer
     pisaba el backgroundColor correcto con uno mal traducido. */
  console.log('\n8-bis. El color que va a la ventana');
  const colorVentana = await js(`(async () => {
    const { colorToken, aHex } = await import('./js/ui.js');
    const computado = (() => {
      const p = document.createElement('span');
      p.style.cssText = 'position:fixed;left:-9999px;color:var(--op-bg)';
      document.body.appendChild(p);
      const c = getComputedStyle(p).color;
      p.remove();
      return c;
    })();
    return {
      computado,
      hex: colorToken('--op-bg'),
      // El regex viejo, para dejar constancia de qué habría devuelto.
      conRegexViejo: (() => {
        const n = computado.match(/[0-9]+/g);
        return n ? '#' + n.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('') : null;
      })(),
      // aHex tiene que dar lo mismo pase lo que pase por la notación.
      desdeRgb: aHex('rgb(10, 11, 13)'),
      desdeHex: aHex('#0a0b0d'),
    };
  })()`);
  ok('el token resuelve a un hex de 6 dígitos',
    /^#[0-9a-f]{6}$/i.test(colorVentana.hex || ''), JSON.stringify(colorVentana));
  ok('coincide con el backgroundColor de main.cjs',
    colorVentana.hex.toLowerCase() === BG_MAIN, `${colorVentana.hex} vs ${BG_MAIN}`);
  /* La red de seguridad de verdad: que el fondo NO sea un color saturado. El
     bug daba #009500 —un hex perfectamente válido— así que validar la FORMA no
     alcanza; hay que mirar el color. */
  ok('y no es un verde/magenta salido de parsear mal el oklch', (() => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colorVentana.hex.slice(i, i + 2), 16));
    return Math.max(r, g, b) - Math.min(r, g, b) < 40;
  })(), `${colorVentana.hex} (el regex viejo daba ${colorVentana.conRegexViejo})`);
  ok('aHex normaliza cualquier notación',
    colorVentana.desdeRgb === '#0a0b0d' && colorVentana.desdeHex === '#0a0b0d',
    JSON.stringify(colorVentana));

  /* ── Botones de solo ícono ─────────────────────────────────────────────────
     Un botón que solo lleva un SVG tiene que tenerlo centrado. Suena obvio y no
     lo era: Chromium le da `padding: 1px 6px` a todo `<button>` y este reset no
     lo tocaba. En los controles chicos eso deja la caja de contenido más
     angosta que el ícono; el ícono desborda, y un ítem de grid que desborda su
     área cae de `center` a `start`. El tilde del `.op-check` salía 4px a la
     derecha y recortado contra el borde; el `.op-iconbtn`, 1,5px — invisible de
     a uno y repetido en la titlebar, el rail y cada fila.

     Corre sobre Piezas, que es donde están todos los primitivos juntos. */
  console.log('\n8-ter. Los botones de solo ícono centran su contenido');
  const descentrados = await js(`(() => {
    const malos = [];
    for (const b of document.querySelectorAll('button')) {
      // Solo ícono: un único hijo elemento, que es un svg, y sin texto.
      if (b.children.length !== 1 || b.textContent.trim()) continue;
      const hijo = b.firstElementChild;
      if (hijo.tagName.toLowerCase() !== 'svg') continue;
      const rb = b.getBoundingClientRect();
      const rh = hijo.getBoundingClientRect();
      if (!rb.width || !rh.width) continue;
      const d = ((rh.left + rh.right) / 2) - ((rb.left + rb.right) / 2);
      const desborda = rh.right > rb.right + 0.5 || rh.left < rb.left - 0.5;
      if (Math.abs(d) > 0.51 || desborda) {
        malos.push({ clase: b.className.slice(0, 34), corrimiento: +d.toFixed(2), desborda });
      }
    }
    return { malos, revisados: [...document.querySelectorAll('button')].length };
  })()`);
  ok('ninguno tiene el ícono corrido ni desbordado',
    descentrados.malos.length === 0, JSON.stringify(descentrados.malos));
  ok('y había botones que revisar', descentrados.revisados > 10, `${descentrados.revisados}`);

  /* ── La tarjeta sin encabezado ──────────────────────────────────────────────
     `.op-card__body` llevaba `padding-top: 0` para no repetir el aire que el
     `__head` ya pone. Con head quedaba perfecto; SIN head el contenido se
     pegaba al borde de arriba — 0 px contra 16 abajo.

     Vivió tanto porque esta misma vitrina mostraba UNA tarjeta y con `padding`
     inline: el único lugar que existe para ver las piezas era el único donde la
     pieza rota no se veía. */
  console.log('\n8-quater. Las dos formas de la tarjeta');

  const tarjetas = await js(`(() => [...document.querySelectorAll('.op-card__body')].map((b) => {
    const s = getComputedStyle(b);
    const head = b.previousElementSibling?.classList.contains('op-card__head');
    const arriba = b.getBoundingClientRect().top - b.closest('.op-card').getBoundingClientRect().top;
    return {
      head: !!head,
      top: parseFloat(s.paddingTop),
      bottom: parseFloat(s.paddingBottom),
      // Lo que de verdad separa al contenido del filo: el padding del cuerpo
      // MÁS lo que haya arriba de él.
      aire: +(arriba + parseFloat(s.paddingTop)).toFixed(1),
    };
  }))()`);

  const sinHead = tarjetas.filter((t) => !t.head);
  const conHead = tarjetas.filter((t) => t.head);

  ok('la vitrina muestra las dos formas', sinHead.length > 0 && conHead.length > 0,
    JSON.stringify(tarjetas));
  ok('sin encabezado, el cuerpo pone su propio aire arriba',
    sinHead.every((t) => t.top > 0 && t.top === t.bottom), JSON.stringify(sinHead));
  /* Y el arreglo NO puede romper el caso que ya estaba bien: con head, repetir
     el padding separaría el cuerpo de su propio título. */
  ok('con encabezado, el cuerpo NO lo repite', conHead.every((t) => t.top === 0),
    JSON.stringify(conHead));
  ok('pero el contenido igual queda separado del filo',
    tarjetas.every((t) => t.aire >= 12), JSON.stringify(tarjetas.map((t) => t.aire)));

  /* ── El vidrio está puesto donde va, y solo ahí ────────────────────────────
     La regla de las hojas es fácil de romper en las dos direcciones: una card
     que hereda blur "porque queda lindo" (paga GPU en cada scroll) o un shell
     que lo pierde en una refactorización (y el sistema entero deja de ser
     vidrio sin que ningún test de unidad lo note). Se mide el computado, no
     la clase: lo que importa es lo que pinta el compositor. */
  console.log('\n8-quinquies. El vidrio: en el shell y los overlays, no en las cards');
  const vidrio = await js(`(() => {
    const bf = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backdropFilter : null; };
    return { fog: !!document.querySelector('.op-fog'), titlebar: bf('.op-titlebar'),
             rail: bf('.op-rail'), vista: bf('#view'), panel: bf('.op-panel'), composer: bf('.op-composer__box'),
             inspector: bf('.op-inspector'), card: bf('.op-card') };
  })()`);
  ok('el sustrato de niebla existe', vidrio.fog);
  /* Desde que las hojas flotan (oct 2026), la titlebar es aire sobre la
     niebla: sin relleno y sin blur. Las hojas son el rail, la vista, el
     panel derecho y el compositor. */
  ok('la titlebar es aire, sin blur', vidrio.titlebar === 'none', String(vidrio.titlebar));
  ok('el rail es vidrio', /blur\(/.test(vidrio.rail || ''), String(vidrio.rail));
  ok('la vista es una hoja de vidrio', /blur\(/.test(vidrio.vista || ''), String(vidrio.vista));
  ok('el panel derecho y el compositor también', /blur\(/.test(vidrio.panel || '') && /blur\(/.test(vidrio.composer || ''), JSON.stringify(vidrio));
  ok('el inspector, que vive adentro de la hoja de la vista, no', !vidrio.inspector || vidrio.inspector === 'none', String(vidrio.inspector));
  ok('la card NO lleva blur de fábrica (regla de las hojas)', vidrio.card === 'none', String(vidrio.card));

  await click('#demo-menu');
  await sleep(400);
  const menuGlass = await js(`(() => { const m = document.querySelector('.op-menu'); return m ? getComputedStyle(m).backdropFilter : null; })()`);
  ok('el menú es vidrio', /blur\(/.test(menuGlass || ''), String(menuGlass));
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await sleep(400);

  /* La demo de la vitrina vive ADENTRO del scroller, donde el backdrop queda
     ciego (la máscara del esfumado es frontera): tiene que usar el ESPEJO —
     copia del fondo con filter, alineada al píxel — y no backdrop-filter. */
  const espejo = await js(`(() => {
    const demo = document.getElementById('glass-demo');
    const hoja = document.getElementById('glass-hoja');
    const copia = document.querySelector('#glass-espejo > div');
    if (!demo || !hoja || !copia) return null;
    const rd = demo.getBoundingClientRect(); const rc = copia.getBoundingClientRect();
    return {
      filtro: getComputedStyle(copia).filter,
      alineada: Math.abs(rc.left - rd.left) < 1.5 && Math.abs(rc.top - rd.top) < 1.5
             && Math.abs(rc.width - rd.width) < 1.5 && Math.abs(rc.height - rd.height) < 1.5,
      sinBackdrop: getComputedStyle(hoja).backdropFilter === 'none',
    };
  })()`);
  ok('la demo usa el espejo (filter con blur en la copia)', /blur\(/.test(espejo?.filtro || ''), JSON.stringify(espejo));
  ok('la copia queda alineada con el fondo', espejo?.alineada === true, JSON.stringify(espejo));
  ok('y la hoja no intenta backdrop adentro del scroller', espejo?.sinBackdrop === true);
  /* Sin base opaca, el espejo solo SUMA borrón y el texto real de abajo se
     sigue leyendo nítido a través del relleno translúcido: la oclusión es
     parte del truco, no un detalle. */
  const espejoOpaco = await js(`(() => {
    const host = document.getElementById('glass-espejo');
    if (!host) return null;
    const c = getComputedStyle(host).backgroundColor;
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    const alfa = m && m[1].split(',').length === 4 ? parseFloat(m[1].split(',')[3]) : 1;
    return { color: c, alfa };
  })()`);
  ok('y el espejo es opaco (ocluye el original)', espejoOpaco && espejoOpaco.alfa >= 0.99, JSON.stringify(espejoOpaco));

  /* ── Rutas largas: el pie del rail trunca y el tooltip contiene ────────────
     El bug real: en dev la ruta de datos es corta y todo parece andar; la app
     INSTALADA llega con C:\Users\...\Roaming\App\data y el span inline no
     trunca (text-overflow pide caja de bloque) mientras el tooltip desborda
     su burbuja (una cadena sin espacios no envuelve sin overflow-wrap). Se
     inyecta una ruta larga y se miden CAJAS, no clases. */
  console.log('\n8-sexies. Rutas largas: el pie trunca y el tooltip contiene');
  const rutas = await js(`(async () => {
    const foot = document.getElementById('rail-foot');
    const original = foot.innerHTML;
    const ruta = ['C:', 'Users', 'usuario', 'AppData', 'Roaming', 'UnaAppDeNombreLargo', 'data'].join('\\\\');
    foot.innerHTML = '<span class="op-meta op-truncate"></span>';
    const el = foot.firstElementChild;
    el.dataset.tip = ruta;
    el.textContent = ruta;
    const r = {
      truncado: el.scrollWidth > el.clientWidth + 1,
      elipsis: getComputedStyle(el).textOverflow === 'ellipsis',
      contenido: el.getBoundingClientRect().right <= foot.getBoundingClientRect().right + 1,
    };
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 700));
    const tip = document.querySelector('.op-tooltip');
    if (tip) {
      const rt = tip.getBoundingClientRect();
      const ra = el.getBoundingClientRect();
      r.tip = {
        dentroDeSi: tip.scrollWidth <= tip.clientWidth + 1 && tip.scrollHeight <= tip.clientHeight + 1,
        centradoOClampeado: Math.abs((rt.left + rt.right) / 2 - (ra.left + ra.right) / 2) < 12 || rt.left <= 12,
        enVentana: rt.left >= 0 && rt.right <= window.innerWidth,
      };
    }
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    foot.innerHTML = original;
    return r;
  })()`);
  ok('la ruta larga trunca con elipsis', rutas.truncado && rutas.elipsis, JSON.stringify(rutas));
  ok('y no desborda el rail', rutas.contenido === true);
  ok('el tooltip contiene su texto (nada cuelga afuera del vidrio)', rutas.tip?.dentroDeSi === true, JSON.stringify(rutas.tip));
  ok('y queda centrado sobre el ancla (o clampeado al borde) y en ventana',
    rutas.tip?.centradoOClampeado === true && rutas.tip?.enVentana === true, JSON.stringify(rutas.tip));

  console.log('\n9. Las reglas de oro');
  const glifos = await js(`(() => {
    const malo = /[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u27BF\\u2B00-\\u2BFF\\uFE0F\\u{1F300}-\\u{1FAFF}]/u;
    const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) if (malo.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 40));
    return out;
  })()`);
  ok('cero emojis y glifos unicode en la UI', glifos.length === 0, JSON.stringify(glifos));
  ok('cero title= nativo', (await js(`document.querySelectorAll('[title]').length`)) === 0);
  const reglas = await js(`(() => { const r = [...document.styleSheets].flatMap(ss => { try { return [...ss.cssRules] } catch { return [] } })
      .map(x => x.selectorText).filter(Boolean).join(' ');
    return { scrollbar: r.includes('::-webkit-scrollbar'), seleccion: r.includes('::selection'), focus: r.includes(':focus-visible') }; })()`);
  ok('scrollbar propia', reglas.scrollbar);
  ok('::selection propia', reglas.seleccion);
  ok('focus ring propio (:focus-visible)', reglas.focus);
  /* Sin esto, lo que Chromium dibuja por su cuenta (el calendario de un campo
     de fecha, el selector de color) sale con su blanco de fábrica. */
  ok('la interfaz se declara oscura (color-scheme)', (await js(`getComputedStyle(document.documentElement).colorScheme`)) === 'dark');

  /* ── 9-bis. Ningún anillo de foco se corta ─────────────────────────────────
     El anillo de base.css sale 3.5px por fuera del elemento. Si el elemento se
     ve entero pero esos 3.5px caen afuera de un contenedor que recorta (un
     .op-scroll, el borde de la ventana) o encima del canto de una superficie
     (una card, el carril del segmentado), con Tab se ve cortado: pasó en los
     controles de ventana, el primer ítem del rail, el segmentado y las filas
     de una tabla de borde a borde (Apex, sep 2026). Cada elemento se enfoca
     como con teclado y se mide su anillo real (solo las sombras duras: una
     difusa es elevación, no anillo), así los que van hacia adentro cuentan
     cero. Las filas de tabla se prueban como si tuvieran tabindex, porque las
     apps se lo ponen.

     Medir cero no alcanza para pasar: también se mira que el foco SE NOTE.
     El anillo era una sombra, y los controles con sombra propia (primario,
     secundario, switch, check, select) le ganaban; medían cero, se los
     salteaba como si fueran hacia adentro, y con Tab no mostraban nada. */
  console.log('\n9-bis. Ningún anillo de foco se corta');
  const AUDITAR_ANILLOS = `((scope) => {
  if (!document.getElementById('aud-notr')) document.head.insertAdjacentHTML('beforeend', '<style id="aud-notr">*,*::before{transition:none!important}</style>');
  // Lo que se ve de un elemento y puede marcar el foco (el de las ventanas va en su ::before).
  const look = (el) => {
    const s = getComputedStyle(el);
    const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor);
    return [ring, s.boxShadow, s.backgroundColor, s.borderColor, getComputedStyle(el, '::before').boxShadow].join('|');
  };
  // Cuánto sale el anillo REAL por fuera del elemento: se lo enfoca como con
  // teclado y se leen sus sombras de afuera y su outline. Y si el foco se
  // nota en algo: un anillo que mide cero puede ser uno hacia adentro (el
  // segmentado) o uno que no está (el primario, cuando su sombra le ganaba).
  let marked = true;
  const extent = (el) => {
    const before = look(el);
    el.focus({ focusVisible: true, preventScroll: true });
    marked = !el.matches(':focus') || look(el) !== before;
    const s = getComputedStyle(el);
    let m = 0;
    for (const part of s.boxShadow.split(/,(?![^(]*\\))/)) {
      if (part.includes('inset') || part.trim() === 'none') continue;
      const nums = part.replace(/rgba?\\([^)]*\\)|oklch\\([^)]*\\)/g, '').match(/-?[\\d.]+px/g) || [];
      const [x = 0, y = 0, blur = 0, spread = 0] = nums.map(parseFloat);
      if (blur > 0) continue;   // una sombra difusa (elevación, brillo) no es el anillo
      m = Math.max(m, spread + Math.max(Math.abs(x), Math.abs(y)));
    }
    if (s.outlineStyle !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(s.outlineColor)) m = Math.max(m, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
    el.blur();
    return m;
  };
  const SEL = 'a[href],button:not([disabled]):not([tabindex="-1"]),input:not([disabled]):not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  const name = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
    const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    return el.tagName.toLowerCase() + id + cls + (txt ? ' «' + txt + '»' : '');
  };
  const out = [];
  for (const el of scope.querySelectorAll(SEL)) {
    if (el.closest('[inert],[hidden],[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const R = extent(el);
    if (!marked) { out.push(name(el) + '  no marca el foco'); continue; }
    if (R <= 0.5) continue;
    const boxes = [{ who: 'ventana', l: 0, t: 0, r: innerWidth, b: innerHeight }];
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none' || /paint|strict|content/.test(s.contain)) {
        const ar = a.getBoundingClientRect();
        const l = ar.left + a.clientLeft; const t = ar.top + a.clientTop;
        boxes.push({ who: name(a), l, t, r: l + a.clientWidth, b: t + a.clientHeight });
      }
    }
    const e = 0.5;
    // ¿Roza el canto de una superficie (card, panel, modal)? Un fondo o una
    // sombra con radio: el anillo se pisa con su borde aunque nada lo recorte.
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      const surf = (s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.boxShadow !== 'none') && parseFloat(s.borderTopLeftRadius) > 0;
      if (!surf) continue;
      const ar = a.getBoundingClientRect();
      const g = [r.left - ar.left, r.top - ar.top, ar.right - r.right, ar.bottom - r.bottom];
      if (g.some((x) => x < -e)) continue;
      const lados = ['izq', 'arriba', 'der', 'abajo'].filter((_, i) => g[i] < R - e).map((n, i) => n);
      const det = g.map((x, i) => ['izq', 'arriba', 'der', 'abajo'][i] + ' ' + x.toFixed(1)).filter((_, i) => g[i] < R - e);
      if (det.length) { out.push(name(el) + '  roza ' + name(a) + '  [' + det.join(', ') + ']'); break; }
    }
    for (const bx of boxes) {
      const inside = r.left >= bx.l - e && r.top >= bx.t - e && r.right <= bx.r + e && r.bottom <= bx.b + e;
      if (!inside) break;   // el elemento mismo ya está recortado: no es culpa del anillo
      const lados = [];
      if (r.left - R < bx.l - e) lados.push('izq ' + (r.left - bx.l).toFixed(1));
      if (r.top - R < bx.t - e) lados.push('arriba ' + (r.top - bx.t).toFixed(1));
      if (r.right + R > bx.r + e) lados.push('der ' + (bx.r - r.right).toFixed(1));
      if (r.bottom + R > bx.b + e) lados.push('abajo ' + (bx.b - r.bottom).toFixed(1));
      if (lados.length) { out.push(name(el) + '  ← ' + bx.who + '  [' + lados.join(', ') + ']'); break; }
    }
  }
  document.querySelectorAll('.op-scroll, .op-main, [class*="scroll"]').forEach((s) => { s.scrollTop = 0; s.scrollLeft = 0; });
  return out;
})(document)`;
  // Sin foco en la ventana, :focus-visible no se aplica y todo anillo mide
  // cero: la auditoría pasaría sin haber medido nada.
  win.focus();
  win.webContents.focus();
  await sleep(150);
  ok('la ventana tiene el foco (si no, no hay anillos que medir)', await js('document.hasFocus()'));
  for (const v of ['inicio', 'items', 'piezas', 'ajustes']) {
    await click(`[data-view="${v}"]`);
    await sleep(700);
    await js(`document.querySelectorAll('#view tbody tr').forEach((tr) => tr.tabIndex = 0)`);
    const cortes = await js(AUDITAR_ANILLOS);
    ok(`${v}: todo control marca el foco, y ningún anillo se corta ni roza un canto`, cortes.length === 0, '\n      ' + cortes.join('\n      '));
  }
  await js(`document.getElementById('aud-notr')?.remove()`);

  /* ── 10. Modales en fila ─────────────────────────────────────────────────────
     Modal.show() con otro abierto pisaba `open`: el de abajo quedaba con su
     velo tapando todo, sus botones y Escape no lo cerraban, y su promesa no
     se resolvía nunca. Ahora espera su turno. */
  console.log('\n10. Un modal que llega con otro abierto espera su turno');
  await click('[data-view="piezas"]');
  await sleep(800);
  const fila = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const vivos = () => [...document.querySelectorAll('.op-modal__anim:not([data-state="closing"]) .op-modal__title')].map((e) => e.textContent);
    const velos = () => document.querySelectorAll('.op-scrim:not([data-state="closing"])').length;
    // Con un tope: una promesa que no se resuelve nunca (el bug) es una falla, no un cuelgue.
    const within = (p, ms = 1500) => Promise.race([p, wait(ms).then(() => 'sin respuesta')]);
    const boton = (sel = '.op-btn') => document.querySelector('.op-modal__anim:not([data-state="closing"]) .op-modal__foot ' + sel);
    const r = {};
    const a = Modal.show({ title: 'Primero', actions: [{ label: 'Listo', value: 'a' }] });
    const b = Modal.show({ title: 'Segundo', actions: [{ label: 'Listo', value: 'b' }] });
    await wait(450);
    r.conDos = vivos(); r.velosConDos = velos();
    boton()?.click();
    r.a = await within(a);
    await wait(500);
    r.trasA = vivos(); r.velosTrasA = velos();
    boton()?.click();
    r.b = await within(b);
    await wait(500);
    r.alFinal = vivos(); r.velosAlFinal = document.querySelectorAll('.op-scrim').length;
    // signal: el de la fila se retira sin verse; el que se ve se cierra (ese, no otro).
    const c1 = new AbortController(); const c2 = new AbortController();
    const x = Modal.show({ title: 'Tercero', signal: c1.signal });
    const y = Modal.show({ title: 'Retirado', signal: c2.signal });
    await wait(300);
    c2.abort(); r.y = await within(y);
    r.sigueElTercero = vivos();
    c1.abort(); r.x = await within(x);
    await wait(500);
    r.trasRetirar = vivos(); r.velosTrasRetirar = document.querySelectorAll('.op-scrim').length;
    // arm: lo que se abre solo no toma un click que venía para otra cosa.
    const z = Modal.show({ title: 'Armándose', arm: 600, actions: [{ label: 'Sí', value: true, variant: 'primary', autofocus: true }] });
    await wait(150);
    const prim = boton('.op-btn--primary');
    r.armandoNoToma = !!prim && getComputedStyle(prim).pointerEvents === 'none';
    r.focoEnElDialogo = document.activeElement?.classList.contains('op-modal');
    await wait(650);
    r.despuesToma = !!prim && getComputedStyle(prim).pointerEvents !== 'none';
    prim?.click();
    r.z = await within(z);
    await wait(500);
    return r;
  })()`);
  ok('con uno abierto, el segundo espera: se ve uno solo, con un velo',
    JSON.stringify(fila.conDos) === '["Primero"]' && fila.velosConDos === 1, JSON.stringify(fila));
  ok('al cerrar el primero, el segundo entra sobre el mismo velo',
    fila.a === 'a' && JSON.stringify(fila.trasA) === '["Segundo"]' && fila.velosTrasA === 1, JSON.stringify(fila));
  ok('y al cerrar el segundo no queda nada a la vista', fila.b === 'b' && !fila.alFinal.length && fila.velosAlFinal === 0, JSON.stringify(fila));
  ok('signal retira al de la fila sin que se vea', fila.y === null && JSON.stringify(fila.sigueElTercero) === '["Tercero"]', JSON.stringify(fila));
  ok('y cierra al que se ve, con su velo', fila.x === null && !fila.trasRetirar.length && fila.velosTrasRetirar === 0, JSON.stringify(fila));
  ok('arm: mientras se arma, el botón no toma clicks y el foco está en el diálogo',
    fila.armandoNoToma && fila.focoEnElDialogo && fila.despuesToma && fila.z === true, JSON.stringify(fila));

  /* ── 11. Movimiento ──────────────────────────────────────────────────────────
     Lo que ya se ve se pone al día: las filas que siguen son el mismo nodo,
     un número en medio de una oración cambia sin partirla, lo que corre
     arranca de donde iba, y lo que ya se está yendo no se borra de golpe. */
  console.log('\n11. Movimiento: lo que ya se ve se pone al día');
  const mov = await js(`(async () => {
    const m = await import('./js/motion.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const r = {};
    document.getElementById('mv').scrollIntoView({ block: 'center' });
    await wait(100);
    const lista = document.getElementById('mv-lista');
    const filtro = document.getElementById('mv-filtro');
    const antes = new Map([...lista.children].map((el) => [el.dataset.key, el]));
    filtro.value = 'ta';
    filtro.dispatchEvent(new Event('input', { bubbles: true }));
    r.saliendo = lista.querySelectorAll('[data-state="closing"]').length;
    await wait(500);
    r.quedan = [...lista.children].map((el) => el.dataset.key);
    r.mismosNodos = r.quedan.length > 0 && r.quedan.every((k) => antes.get(k) === lista.querySelector('[data-key="' + k + '"]'));
    filtro.value = '';
    filtro.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(600);
    r.vuelven = lista.children.length;

    const frase = document.getElementById('mv-frase');
    const alto0 = frase.getBoundingClientRect().height;
    document.getElementById('mv-mas').click();
    let peor = alto0;
    for (let i = 0; i < 20; i++) { await frame(); peor = Math.max(peor, frase.getBoundingClientRect().height); }
    r.alto = [alto0, peor];
    await wait(400);
    r.cuenta = document.getElementById('mv-cuenta').textContent;

    const total = document.getElementById('mv-total');
    document.getElementById('mv-sumar').click();
    await wait(120);
    r.rollEnCamino = total.textContent;
    await wait(500);
    r.rollFin = total.textContent;

    const pan = document.getElementById('mv-paneles');
    const titulo = (c) => c.querySelector('.op-subtitle').textContent;
    document.getElementById('mv-alternar').click();
    await frame();
    r.durante = [...pan.children].map((c) => titulo(c) + (c.classList.contains('op-dissolving') ? ' (calco)' : ''));
    r.calcoArriba = getComputedStyle(pan.querySelector('.op-dissolving')).zIndex === '1';
    await wait(500);
    r.despues = [...pan.children].map(titulo);

    const caja = document.createElement('div');
    caja.style.cssText = 'height:40px;animation:op-fade-out 300ms both';
    document.body.appendChild(caja);
    const p1 = m.exit(caja, { fallback: 700 });
    const p2 = m.collapse(caja);
    r.sigueAlPlegar = caja.isConnected;
    r.mismaSalida = p1 === p2;
    await p2;
    r.seFue = !caja.isConnected;
    return r;
  })()`);
  ok('filtrar: lo que no está se esfuma (no desaparece de golpe)', mov.saliendo > 0, JSON.stringify(mov));
  ok('y las filas que siguen son el mismo nodo', mov.mismosNodos && mov.vuelven === 8, JSON.stringify(mov));
  ok('un número en medio de una oración cambia sin partirla', mov.alto[1] - mov.alto[0] < 1 && mov.cuenta === '4', JSON.stringify(mov.alto));
  ok('roll corre: a medio camino no está ni en 0 ni en el final', mov.rollEnCamino !== '0' && mov.rollEnCamino !== mov.rollFin && mov.rollFin === '1.250', JSON.stringify(mov));
  ok('dissolve: el viejo, encima, se esfuma sobre el nuevo', mov.durante.length === 2 && mov.durante[1] === 'Panel A (calco)' && mov.calcoArriba, JSON.stringify(mov.durante));
  ok('y al final queda solo el nuevo', JSON.stringify(mov.despues) === '["Panel B"]', JSON.stringify(mov.despues));
  ok('collapse() sobre algo que ya se va devuelve esa salida, no lo borra de golpe',
    mov.sigueAlPlegar && mov.mismaSalida && mov.seFue, JSON.stringify(mov));

  /* ── 11-bis. Lo que trajo Onyx (octubre de 2026) ───────────────────────────
     swap() con relevo/fundido/dir, frase, numero, contador, ocupar,
     deslizarAlto, .op-plegable y el `dot` del menú. Cada uno con lo que lo
     rompía: el calco que no conserva la caja vieja, la frase entera que se
     releva por una cifra, el contador que vuelve y se corta de golpe. */
  console.log('\n11-bis. swap, frase, contador, ocupar y plegables');
  const onyx = await js(`(async () => {
    const m = await import('./js/motion.js');
    const { Menu } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = {};
    const caja = document.createElement('div');
    caja.style.cssText = 'position:fixed;left:40px;top:80px;width:360px;z-index:50';
    document.getElementById('view').appendChild(caja);
    const nuevo = (html = '', css = '') => { const el = document.createElement('div'); el.style.cssText = css; el.innerHTML = html; caja.appendChild(el); return el; };

    // swap: la primera vez con lo mismo que ya dice, nada.
    const a = nuevo('<span>Hola</span>');
    m.swap(a, '<span>Hola</span>', { relevo: true });
    r.mismoNada = !a.querySelector('.op-swap-out');
    // relevo: un calco encima, clavado en la caja vieja (una frase larga que se
    // va por una corta no se parte en dos renglones).
    const b = nuevo('<span>Una frase bastante larga que ocupa su ancho</span>', 'display:inline-block;white-space:nowrap');
    const h0 = b.getBoundingClientRect().height;
    const w0 = b.getBoundingClientRect().width;
    m.swap(b, '<span>Corta</span>', { relevo: true });
    const calco = b.querySelector(':scope > .op-swap-out--over');
    r.calco = !!calco && calco.dataset.state === 'closing';
    r.calcoCaja = calco && Math.abs(calco.getBoundingClientRect().width - w0) < 1 && calco.getBoundingClientRect().height <= h0 + 0.5;
    r.nuevoEsperaTurno = !!b.querySelector(':scope > .op-swap-in.is-after');
    await wait(400);
    r.calcoSeFue = !b.querySelector('.op-swap-out');
    // valores (sin opciones): en el lugar, sin calco.
    m.swap(b, '<span>Corta 2</span>');
    r.valoresSinCalco = !b.querySelector('.op-swap-out') && b.textContent === 'Corta 2';
    // se va: cada hijo termina de irse.
    m.swap(b, '');
    r.seVaAnimado = b.querySelectorAll(':scope > .op-swap-out[data-state="closing"]').length === 1;
    await wait(400);
    r.seVaVacio = b.childElementCount === 0;

    // dir: desde oct 2026 no sube ni baja. Es un relevo en su lugar (nada
    // anima un transform) y el contenedor destella, como un número que cambió.
    const d = nuevo('Quedan <span id="t-dir">3</span> en la fila');
    const num = d.querySelector('#t-dir');
    m.swapText(num, '4', { dir: 1 });
    r.dirCalco = !!num.querySelector('.op-swap-out');
    const entra = num.querySelector('.op-swap-in');
    const mueve = (a) => (a.effect?.getKeyframes?.() || []).some((k) => k.transform && k.transform !== 'none');
    r.dirEntra = !!entra && getComputedStyle(entra).transform === 'none' && !num.getAnimations({ subtree: true }).some(mueve);
    r.dirDestella = num.classList.contains('op-ticked');
    await wait(450);
    r.dirFin = num.textContent;

    // fundido: el calco lleva fondo propio; adentro de la vista, la niebla.
    const f = nuevo('<table><tr><td>uno</td></tr></table>');
    m.swap(f, '<table><tr><td>uno</td><td>dos</td></tr></table>', { fundido: true });
    const cf = f.querySelector('.op-swap-out--fundido');
    r.fundido = !!cf && getComputedStyle(cf).backgroundImage.includes('gradient') && getComputedStyle(cf).zIndex === '3';
    r.fundidoQuieto = !f.querySelector('.op-swap-in');
    await wait(400);

    // frase: si cambian solo las cifras, en el lugar y destella; si cambia la frase, relevo.
    const fr = nuevo('', 'display:inline-block');
    m.frase(fr, 'Bajando… 41 %');
    await wait(400);
    m.frase(fr, 'Bajando… 48 %');
    r.fraseCifras = !fr.querySelector('.op-swap-out') && fr.classList.contains('op-ticked') && fr.textContent === 'Bajando… 48 %';
    m.frase(fr, 'Listo: se instala al cerrar.');
    r.fraseRelevo = !!fr.querySelector('.op-swap-out--over');
    await wait(400);

    // numero: el primer llenado no destella; el cambio sí.
    const n = nuevo('', '');
    m.numero(n, 12);
    r.numeroPrimero = !n.classList.contains('op-ticked');
    m.numero(n, 13);
    r.numeroCambio = n.classList.contains('op-ticked') && n.textContent === '13';

    // Un progreso: { destello: false } cambia sin destellar.
    const p = nuevo('', '');
    m.numero(p, '41 %'); m.numero(p, '42 %', { destello: false });
    r.progreso = !p.classList.contains('op-ticked') && p.textContent === '42 %';
    const pf = nuevo('Bajando… 41 %', '');
    m.frase(pf, 'Bajando… 42 %', { destello: false });
    r.progresoFrase = !pf.querySelector('.op-swap-out') && !pf.classList.contains('op-ticked') && pf.textContent === 'Bajando… 42 %';

    // contador: 12 → 0 → 12 rápido revive el que se iba, desde donde estaba.
    const c = nuevo('', '');
    m.contador(c, 12);
    await wait(400);
    m.contador(c, 0);
    await wait(60);
    const yendose = c.querySelector(':scope > .op-swap-out[data-state="closing"]');
    const opYendo = yendose ? +getComputedStyle(yendose).opacity : -1;
    m.contador(c, 12);
    r.contadorRevive = !!yendose && yendose.isConnected && !yendose.dataset.state && +getComputedStyle(yendose).opacity >= opYendo - 0.05;
    await wait(400);
    r.contadorQueda = c.textContent.trim() === '12' && !c.querySelector('.op-swap-out');
    m.contador(c, 7);
    r.contadorCambia = c.textContent.trim() === '7' && c.classList.contains('op-ticked');

    // ocupar: marca el estado, el ancho viaja, y con el mismo estado no hace nada.
    const btn = nuevo('<button class="op-btn op-btn--secondary" data-ocupado="0">Exportar</button>').firstElementChild;
    m.ocupar(btn, true, 'Exportando las 12 páginas…');
    r.ocupado = btn.dataset.ocupado === '1' && btn.getAttribute('aria-busy') === 'true';
    r.anchoViaja = btn.getAnimations().some((x) => x.effect?.getKeyframes().some((k) => k.width));
    const antes = btn.innerHTML;
    m.ocupar(btn, true, 'otra cosa');
    r.mismoEstadoNada = btn.innerHTML === antes;
    await wait(400);

    // deslizarAlto: el alto viaja.
    const al = nuevo('<div style="height:20px"></div>');
    m.deslizarAlto(al, () => { al.innerHTML = '<div style="height:80px"></div>'; });
    r.altoViaja = al.getAnimations().some((x) => x.effect?.getKeyframes().some((k) => k.height));

    // plegable: desde oct 2026, hidden lo apaga EN SU LUGAR. No cambia de alto
    // nunca (lo de abajo no se mueve), la opacidad baja de a poco, y apagado
    // sigue ocupando su hueco pero invisible y sin tomar clicks.
    const pl = nuevo('<div class="op-plegable"><div style="height:60px"></div></div>').firstElementChild;
    const alto = () => Math.round(pl.getBoundingClientRect().height);
    const opa = () => +getComputedStyle(pl).opacity;
    await wait(400);
    r.plegableAbierto = alto();
    pl.hidden = true;
    await wait(70);
    r.plegableMedio = alto() === 60 && opa() > 0.02 && opa() < 0.98;
    await wait(400);
    const csP = getComputedStyle(pl);
    r.plegableCerrado = csP.display !== 'none' && csP.visibility === 'hidden' && opa() === 0 && alto() === 60;
    pl.hidden = false;
    await wait(150);
    r.plegableVuelve = alto() === 60 && opa() > 0.02 && opa() < 0.999;
    // asentarPlegables: uno que nace visible queda en su alto en el primer cuadro.
    const pl2 = nuevo('<div class="op-plegable"><div style="height:60px"></div></div>').firstElementChild;
    m.asentarPlegables(caja);
    r.asentado = Math.round(pl2.getBoundingClientRect().height) === 60;

    // dot: un puntito en el lugar del ícono, del mismo ancho.
    Menu.show(btn, [{ label: 'Con ícono', icon: 'copy' }, { label: 'Con punto', dot: 'rgb(200, 100, 50)' }]);
    await wait(300);
    const dot = document.querySelector('.op-menu .op-menuitem__dot');
    const ico = document.querySelector('.op-menu .op-menuitem .op-icon');
    const ancho = (el) => { const cs = getComputedStyle(el); return el.getBoundingClientRect().width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight); };
    const rot = [...document.querySelectorAll('.op-menu .op-truncate')].map((t) => Math.round(t.getBoundingClientRect().left));
    r.dot = !!dot && getComputedStyle(dot).backgroundColor === 'rgb(200, 100, 50)' && Math.abs(ancho(dot) - ancho(ico)) < 0.5 && rot[0] === rot[1];
    Menu.close();
    await wait(300);

    // danger: el ítem peligroso es rojo en reposo Y resaltado por teclado
    // (.is-active), texto e ícono. Con las flechas el texto se iba al blanco
    // del resaltado genérico (lo cazó el humo de Nexus). Se compara contra el
    // token resuelto en una sonda, no contra un literal.
    Menu.show(btn, [{ label: 'Copiar', icon: 'copy' }, { label: 'Eliminar', icon: 'trash', danger: true }]);
    await wait(300);
    const sonda = document.createElement('span');
    sonda.style.color = 'var(--op-danger)';
    document.body.appendChild(sonda);
    const rojo = getComputedStyle(sonda).color;
    sonda.remove();
    const peligro = document.querySelector('.op-menu .op-menuitem--danger');
    const pinta = () => ({ texto: getComputedStyle(peligro).color, icono: getComputedStyle(peligro.querySelector('.op-icon')).color });
    const reposo = pinta();
    peligro.classList.add('is-active');
    await wait(300);   // la transición de color termina
    const activo = pinta();
    r.danger = { rojo, reposo, activo };
    r.dangerOk = [reposo.texto, reposo.icono, activo.texto, activo.icono].every((c) => c === rojo);
    Menu.close();
    await wait(300);
    caja.remove();
    return r;
  })()`);
  ok('swap con el mismo HTML que ya hay no hace nada', onyx.mismoNada, JSON.stringify(onyx));
  ok('relevo: lo viejo se va en un calco con su caja de antes, lo nuevo espera su turno',
    onyx.calco && onyx.calcoCaja && onyx.nuevoEsperaTurno && onyx.calcoSeFue, JSON.stringify(onyx));
  ok('cambiar valores es en el lugar, sin calco', onyx.valoresSinCalco, JSON.stringify(onyx));
  ok('vaciar: cada hijo termina de irse', onyx.seVaAnimado && onyx.seVaVacio, JSON.stringify(onyx));
  ok('dir: se releva en su lugar, sin subir ni bajar, y destella', onyx.dirCalco && onyx.dirEntra && onyx.dirDestella && onyx.dirFin === '4', JSON.stringify(onyx));
  ok('fundido: el calco lleva la niebla y tapa al th sticky; lo nuevo quieto debajo', onyx.fundido && onyx.fundidoQuieto, JSON.stringify(onyx));
  ok('frase: solo cifras destella en el lugar; otra frase releva', onyx.fraseCifras && onyx.fraseRelevo, JSON.stringify(onyx));
  ok('numero: el primer llenado no destella, el cambio sí', onyx.numeroPrimero && onyx.numeroCambio, JSON.stringify(onyx));
  ok('numero y frase con { destello: false }: un progreso cambia sin destellar', onyx.progreso && onyx.progresoFrase, JSON.stringify(onyx));
  ok('contador: el que vuelve mientras se iba revive desde donde estaba',
    onyx.contadorRevive && onyx.contadorQueda && onyx.contadorCambia, JSON.stringify(onyx));
  ok('ocupar: marca el estado, el ancho viaja, y repetirlo no hace nada',
    onyx.ocupado && onyx.anchoViaja && onyx.mismoEstadoNada, JSON.stringify(onyx));
  ok('deslizarAlto: el alto viaja', onyx.altoViaja, JSON.stringify(onyx));
  ok('plegable: se apaga y se prende en su lugar, sin cambiar de alto, y guarda su hueco',
    onyx.plegableAbierto === 60 && onyx.plegableMedio && onyx.plegableCerrado && onyx.plegableVuelve, JSON.stringify(onyx));
  ok('asentarPlegables: el que nace visible queda en su alto', onyx.asentado, JSON.stringify(onyx));
  ok('menú: el dot ocupa lo mismo que un ícono y los rótulos alinean', onyx.dot, JSON.stringify(onyx));
  ok('menú: el ítem peligroso sigue rojo resaltado por teclado (texto e ícono)', onyx.dangerOk, JSON.stringify(onyx.danger));

  /* ── 12. Las salidas de los overlays ───────────────────────────────────────── */
  console.log('\n12. Tooltip, menú y toast se van animados');
  const salidas = await js(`(async () => {
    const { Toast, Menu } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const r = {};
    // El tooltip que se cierra con "ya" (un click) también sale animado.
    const b = document.getElementById('mv-mas');
    b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await wait(700);
    r.tip = !!document.querySelector('.op-tooltip');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const tip = document.querySelector('.op-tooltip');
    r.tipSaliendo = !!tip && tip.dataset.state === 'closing';
    await wait(350);
    r.tipSeFue = !document.querySelector('.op-tooltip');
    // Un menú que reemplaza a otro: el primero se va con su salida.
    Menu.show(document.getElementById('demo-menu'), [{ label: 'Uno' }]);
    await wait(250);
    const viejo = document.querySelector('.op-menu');
    Menu.show(document.getElementById('demo-modal'), [{ label: 'Dos' }]);
    r.menuSaliendo = viejo.isConnected && viejo.dataset.state === 'closing';
    await wait(350);
    r.menuSeFue = !viejo.isConnected;
    Menu.close();
    await wait(350);
    // Los toasts van de a uno. El mismo aviso otra vez no se dispara: el que
    // está vuelve a empezar su cuenta (la barra se rellena).
    const vivos = () => [...document.querySelectorAll('.op-toast')].filter((t) => t.dataset.state !== 'closing');
    Toast.show({ title: 'Estás al día', text: 'Igual', duration: 1500 });
    await wait(900);
    const primero = vivos()[0];
    Toast.show({ title: 'Estás al día', text: 'Igual', duration: 1500 });
    await wait(50);
    r.igualNoDuplica = vivos().length === 1 && vivos()[0] === primero;
    await wait(900);   // 1800 ms desde el primero: sin renovar ya se habría ido
    r.igualRenueva = primero.isConnected && primero.dataset.state !== 'closing';
    // Otro aviso lo releva: el viejo sale y el nuevo entra cuando el viejo ya
    // va por la mitad. Nunca hay dos vivos.
    Toast.show({ title: 'Otro', duration: 0 });
    r.releva = primero.dataset.state === 'closing';
    let maxVivos = 0;
    for (let i = 0; i < 30; i++) { await frame(); maxVivos = Math.max(maxVivos, vivos().length); }
    r.maxVivos = maxVivos;
    r.nuevoEntro = vivos().length === 1 && vivos()[0].textContent.includes('Otro');
    vivos()[0].querySelector('[data-close]').click();
    await wait(700);
    r.toastsQuedan = document.querySelectorAll('.op-toast').length;
    return r;
  })()`);
  ok('el tooltip cerrado por un click sale animado', salidas.tip && salidas.tipSaliendo && salidas.tipSeFue, JSON.stringify(salidas));
  ok('un menú reemplazado por otro sale animado', salidas.menuSaliendo && salidas.menuSeFue, JSON.stringify(salidas));
  ok('toast: el mismo aviso otra vez no se duplica, y renueva su cuenta',
    salidas.igualNoDuplica && salidas.igualRenueva, JSON.stringify(salidas));
  ok('toast: otro aviso releva al que está, y nunca hay dos a la vista',
    salidas.releva && salidas.maxVivos === 1 && salidas.nuevoEntro && salidas.toastsQuedan === 0, JSON.stringify(salidas));

  /* ── 13. Un menú largo ───────────────────────────────────────────────────────
     Con un tope del 60 % de la ventana, un menú largo escondía sus últimos
     ítems aunque hubiera lugar, y nada avisaba que había más. */
  console.log('\n13. Un menú largo entra, o deja ver que hay más');
  const abrirLargo = () => js(`(async () => {
    const { Menu } = await import('./js/overlays.js');
    let a = document.getElementById('ancla-larga');
    if (!a) { a = document.createElement('button'); a.id = 'ancla-larga'; a.textContent = 'Largo'; a.style.cssText = 'position:fixed;left:300px;top:60px;z-index:5'; document.body.appendChild(a); }
    Menu.show(a, Array.from({ length: 24 }, (_, i) => ({ label: 'Ítem ' + (i + 1) })));
    return true;
  })()`);
  const menuVivo = `document.querySelector('.op-menu:not([data-state="closing"])')`;
  await abrirLargo();
  await sleep(400);
  ok('con lugar, entra entero sin desplazarse', await js(`(() => { const m = ${menuVivo}; return !!m && m.scrollHeight <= m.clientHeight + 1 && m.getBoundingClientRect().bottom <= innerHeight; })()`));
  escape();
  await sleep(400);
  win.setContentSize(1100, 500);
  await sleep(400);
  await abrirLargo();
  await sleep(400);
  ok('con una ventana baja, se corta en el borde de la ventana', await js(`(() => { const m = ${menuVivo}; return !!m && m.getBoundingClientRect().bottom <= innerHeight - 9; })()`));
  ok('y deja ver que hay más: se desplaza, con la barrita a la vista', await js(`(() => { const m = ${menuVivo}; return m.scrollHeight > m.clientHeight + 1 && !m.classList.contains('is-bottom'); })()`));
  await js(`(() => { const m = ${menuVivo}; m.scrollTop = m.scrollHeight; return true; })()`);
  await sleep(200);
  ok('y desplazándolo se llega al último', await js(`(() => { const m = ${menuVivo}; const u = [...m.querySelectorAll('.op-menuitem')].pop().getBoundingClientRect(); return m.classList.contains('is-bottom') && u.bottom <= m.getBoundingClientRect().bottom; })()`));
  escape();
  await sleep(400);
  win.setContentSize(W, H);
  await sleep(400);
  await js(`document.getElementById('ancla-larga')?.remove(); true`);

  /* ── 14. El ítem deshabilitado ─────────────────────────────────────────────── */
  console.log('\n14. Un ítem deshabilitado se ve apagado y el teclado lo saltea');
  await click('#demo-menu');
  await sleep(400);
  const apagado = await js(`(() => { const b = [...document.querySelectorAll('.op-menu .op-menuitem')].find((x) => x.textContent.includes('Pegar')); return b ? { disabled: b.disabled, opacidad: getComputedStyle(b).opacity } : null; })()`);
  ok('se ve apagado', apagado?.disabled && Number(apagado.opacidad) < 0.5, JSON.stringify(apagado));
  const activos = [];
  for (let i = 0; i < 6; i++) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    await sleep(60);
    activos.push(await js(`document.querySelector('.op-menu .op-menuitem.is-active')?.textContent.trim().split(/\\s+/)[0] || ''`));
  }
  ok('las flechas lo saltean', activos.length === 6 && !activos.includes('Pegar') && activos.includes('Eliminar'), JSON.stringify(activos));
  escape();
  await sleep(400);

  /* ── 15. El menú de los campos ─────────────────────────────────────────────
     Electron no trae menú contextual en los campos: el click derecho no hacía
     nada. Se prueba con un click derecho de verdad, por el canal de entrada. */
  console.log('\n15. El click derecho en un campo');
  const derecho = async (sel) => {
    const p = await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
    await sleep(150);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await sleep(450);
    return p;
  };
  const items = () => js(`[...document.querySelectorAll('.op-menu:not([data-state="closing"]) .op-menuitem')].map((b) => (b.disabled ? '-' : '+') + b.textContent.trim().replace(/\\s*Ctrl.*$/, ''))`);
  await js(`(() => { const i = document.getElementById('demo-input'); i.focus(); i.value = 'Sin título'; i.setSelectionRange(i.value.length, i.value.length); return true; })()`);
  const punto = await derecho('#demo-input');
  const menuCampo = await js(`(() => { const m = ${menuVivo}; if (!m) return null; const r = m.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
  ok('aparece el menú, donde fue el click', !!menuCampo && Math.abs(menuCampo.x - punto.x) <= 12 && Math.abs(menuCampo.y - punto.y) <= 12, JSON.stringify({ punto, menuCampo }));
  // El click derecho deja el cursor donde cayó (como en Chrome): ahí se pega.
  const cursor = await js(`document.getElementById('demo-input').selectionStart`);
  const sinSeleccion = await items();
  ok('sin nada seleccionado: copiar y cortar apagados, pegar prendido',
    ['-Cortar', '-Copiar', '+Pegar', '+Seleccionar todo'].every((x) => sinSeleccion.includes(x)), JSON.stringify(sinSeleccion));
  const pegar = await js(`(() => { const b = [...document.querySelectorAll('.op-menu .op-menuitem')].find((x) => x.textContent.includes('Pegar')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
  if (pegar) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pegar.x, y: pegar.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pegar.x, y: pegar.y, button: 'left', clickCount: 1 });
  }
  await sleep(450);
  const pegado = await js(`(() => { const i = document.getElementById('demo-input'); return { valor: i.value, foco: document.activeElement === i, menu: !!${menuVivo} }; })()`);
  const esperado = 'Sin título'.slice(0, cursor) + PEGADO + 'Sin título'.slice(cursor);
  ok('Pegar escribe lo copiado donde estaba el cursor', pegado.valor === esperado, JSON.stringify({ ...pegado, cursor }));
  ok('y el campo no pierde el foco (el menú no se lo lleva)', pegado.foco && !pegado.menu, JSON.stringify(pegado));
  await js(`(() => { const i = document.getElementById('demo-input'); i.value = 'Sin título'; return true; })()`);
  await derecho('#demo-stepper input');
  ok('un campo numérico no lleva este menú', !(await js(`!!${menuVivo}`)));

  // Dentro de un modal: el menú no lo cierra, y el primer Escape es del menú.
  await js(`(async () => { const { Modal } = await import('./js/overlays.js'); Modal.show({ title: 'Con un campo', body: '<input class="op-input" id="campo-modal" value="algo">' }); return true; })()`);
  await sleep(500);
  await derecho('#campo-modal');
  ok('en un campo de un modal, el menú abre encima', (await js(`!!${menuVivo}`)) && (await hayModal()));
  escape();
  await sleep(400);
  ok('el primer Escape cierra el menú y el modal sigue', !(await js(`!!${menuVivo}`)) && (await hayModal()));
  escape();
  await sleep(500);
  ok('el segundo cierra el modal', !(await hayModal()));

  /* Enter sobre «Más» abría su menú Y la fila; elegir un ítem del menú con
     Enter también abría la fila de atrás. */
  await click('[data-view="items"]');
  await sleep(800);
  const enter = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  };
  await js(`document.querySelector('#view [data-menu="item"]').focus(); true`);
  enter();
  await sleep(500);
  ok('Enter sobre «Más» abre su menú y no la fila', (await js(`!!${menuVivo}`)) && !(await js(`!!document.querySelector('.op-inspector')`)));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  await sleep(100);
  const elegido = await js(`document.querySelector('.op-menu .op-menuitem.is-active')?.textContent.trim()`);
  enter();
  await sleep(600);
  ok('elegir «Renombrar…» con Enter abre su diálogo y no la fila',
    elegido?.startsWith('Renombrar') && (await hayModal()) && !(await js(`!!document.querySelector('.op-inspector')`)), String(elegido));
  escape();
  await sleep(500);

  /* ── 16. Cambiar y repintar la vista ───────────────────────────────────────
     Navegar cortaba la vista vieja de un cuadro al otro y la nueva arrancaba
     desde transparente. Repintar la misma (Router.refresh) era un innerHTML en
     seco: el scroll volvía arriba, el foco se iba, los contadores volvían a
     contar y las cápsulas nacían de cero. */
  console.log('\n16. Cambiar y repintar la vista');
  const vistaR = { x: 1260, y: 320, width: 160, height: 240 };   // a la derecha de la vista: solo niebla
  await click('[data-view="piezas"]');
  await sleep(900);
  const nieblaAntes = (await win.webContents.capturePage(vistaR)).toBitmap();
  const navegar = await js(`(async () => {
    const { default: Router } = await import('./js/router.js');
    Router.go('ajustes');
    const calco = document.querySelector('.op-main--saliente');
    const host = document.getElementById('view');
    const r = { calco: !!calco, opaco: calco && getComputedStyle(calco).opacity === '1', nuevaPintada: host.children.length > 0, nuevaQuieta: !host.classList.contains('op-view') };
    // Congelado en su primer cuadro: así se ve lo que tapa.
    for (const a of calco?.getAnimations() || []) { a.pause(); a.currentTime = 0; }
    return r;
  })()`);
  await sleep(60);
  const nieblaCalco = (await win.webContents.capturePage(vistaR)).toBitmap();
  let distintos = 0;
  for (let i = 0; i < Math.min(nieblaAntes.length, nieblaCalco.length); i += 4) {
    if (Math.abs(nieblaAntes[i] - nieblaCalco[i]) + Math.abs(nieblaAntes[i + 1] - nieblaCalco[i + 1]) + Math.abs(nieblaAntes[i + 2] - nieblaCalco[i + 2]) > 6) distintos++;
  }
  ok('al navegar, la vieja pasa a un calco opaco encima y la nueva ya está debajo, quieta',
    navegar.calco && navegar.opaco && navegar.nuevaPintada && navegar.nuevaQuieta, JSON.stringify(navegar));
  ok('la niebla del calco cae exactamente sobre la de la ventana', distintos === 0, `${distintos} píxeles distintos`);
  const fundido = await js(`(async () => {
    const calco = document.querySelector('.op-main--saliente');
    if (!calco) return { ya: true };
    for (const a of calco.getAnimations()) a.play();
    const ops = [];
    const t0 = performance.now();
    while (calco.isConnected && performance.now() - t0 < 800) { ops.push(Number(getComputedStyle(calco).opacity)); await new Promise((r) => requestAnimationFrame(r)); }
    return { ops, seFue: !calco.isConnected };
  })()`);
  ok('y se esfuma parejo hasta irse', fundido.ya || (fundido.seFue && fundido.ops.every((v, i) => !i || v <= fundido.ops[i - 1] + 0.001)), JSON.stringify(fundido));

  await click('[data-view="piezas"]');
  await sleep(900);
  const repinte = await js(`(async () => {
    const { default: Router } = await import('./js/router.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const scroll = document.getElementById('design-scroll');
    document.querySelector('#demo-seg [data-value="c"]').click();
    await wait(450);
    scroll.scrollTop = 1500;
    const antesScroll = scroll.scrollTop;
    // La opción que tiene la cápsula prendida (cada opción lleva la suya).
    const cap = (s) => [...s.querySelectorAll('.op-segmented__opt')].findIndex((o) => +getComputedStyle(o, '::before').opacity > 0.99);
    const mueve = (a) => (a.effect?.getKeyframes?.() || []).some((k) => k.transform || k.width || k.left);
    const antesCap = cap(document.getElementById('demo-seg'));
    document.getElementById('demo-input').focus();
    Router.refresh();
    const calco = !!document.querySelector('.op-main--saliente');
    // En el mismo instante del repintado: de dónde arranca la cápsula nueva.
    const seg = document.getElementById('demo-seg');
    const despuesCap = cap(seg);
    const viaja = document.getAnimations().filter((a) => seg.contains(a.effect?.target) && mueve(a)).length;
    await wait(40);
    const despuesScroll = document.getElementById('design-scroll').scrollTop;
    const foco = document.activeElement?.id;
    await wait(400);
    return { calco, antesScroll, despuesScroll, foco, antesCap, despuesCap, viaja, alFinal: cap(seg) };
  })()`);
  ok('repintar la misma vista también es un fundido', repinte.calco, JSON.stringify(repinte));
  ok('y no pierde el lugar: el scroll y el foco siguen donde estaban',
    Math.abs(repinte.despuesScroll - repinte.antesScroll) <= 1 && repinte.foco === 'demo-input', JSON.stringify(repinte));
  /* La muestra de Piezas no guarda su opción: lo repintado vuelve a la primera.
     Desde oct 2026 cada opción lleva su cápsula: la nueva se prende en la
     primera, en su lugar, y nada viaja. */
  ok('si la opción cambió, la cápsula se prende en la otra opción, sin viajar',
    repinte.antesCap > 0 && repinte.viaja === 0 && repinte.alFinal === 0, JSON.stringify(repinte));
  await click('[data-view="ajustes"]');
  await sleep(900);
  const quieta = await js(`(async () => {
    const { default: Router } = await import('./js/router.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#set-densidad [data-value="amplia"]').click();
    await wait(600);
    const seg = () => document.getElementById('set-densidad');
    const cap = () => [...seg().querySelectorAll('.op-segmented__opt')].findIndex((o) => +getComputedStyle(o, '::before').opacity > 0.99);
    const antes = cap();
    Router.refresh();
    await wait(40);
    const viajando = document.getAnimations().filter((a) => seg().contains(a.effect?.target)).length;
    return { antes, despues: cap(), viajando };
  })()`);
  ok('si no cambió (Ajustes la guarda), la cápsula se queda quieta', quieta.antes > 0 && quieta.despues === quieta.antes && quieta.viajando === 0, JSON.stringify(quieta));
  await click('[data-view="inicio"]');
  await sleep(1200);
  const contador = await js(`(async () => {
    const { default: Router } = await import('./js/router.js');
    const final = document.getElementById('k-items').textContent;
    Router.refresh();
    const alRepintar = document.getElementById('k-items').textContent;
    await new Promise((r) => requestAnimationFrame(r));
    return { final, alRepintar, enElCuadro: document.getElementById('k-items').textContent };
  })()`);
  ok('un contador no vuelve a contar desde 0 al repintar', contador.alRepintar === contador.final && contador.enElCuadro === contador.final, JSON.stringify(contador));

  /* ── 17. Los indicadores nacen en su lugar ─────────────────────────────── */
  console.log('\n17. La cápsula y el subrayado nacen en su lugar');
  const nacer = await js(`(async () => {
    const { bindSwitcher } = await import('./js/motion.js');
    const box = document.createElement('div');
    box.innerHTML = '<div class="op-segmented" id="nace-seg"><button class="op-segmented__opt" data-value="a">Uno</button><button class="op-segmented__opt" data-value="b">Dos</button><button class="op-segmented__opt is-active" data-value="c">Tres</button></div>'
      + '<div class="op-tabs" id="nace-tabs"><button class="op-tab" data-value="1">Uno</button><button class="op-tab is-active" data-value="2">Dos</button></div>';
    box.style.cssText = 'position:fixed;left:300px;top:300px;z-index:5;width:400px';
    document.body.append(box);
    bindSwitcher(box.querySelector('#nace-seg'));
    bindSwitcher(box.querySelector('#nace-tabs'));
    await new Promise((r) => setTimeout(r, 120));
    const anims = (el, p) => document.getAnimations().filter((a) => a.effect?.target === el && a.effect?.pseudoElement === p).length;
    const r = { seg: anims(box.querySelector('#nace-seg'), '::before'), tabs: anims(box.querySelector('#nace-tabs'), '::after'),
      pressed: [...box.querySelectorAll('.op-segmented__opt')].map((o) => o.getAttribute('aria-pressed')).join(','),
      selected: [...box.querySelectorAll('.op-tab')].map((o) => o.getAttribute('role') + ':' + o.getAttribute('aria-selected')).join(',') };
    box.remove();
    return r;
  })()`);
  ok('la cápsula del segmentado no viaja al nacer', nacer.seg === 0, JSON.stringify(nacer));
  ok('el subrayado de los tabs tampoco', nacer.tabs === 0, JSON.stringify(nacer));
  ok('y un lector de pantalla sabe cuál es la elegida', nacer.pressed === 'false,false,true' && nacer.selected === 'tab:false,tab:true', JSON.stringify(nacer));

  /* ── 18. Detalles ──────────────────────────────────────────────────────── */
  console.log('\n18. Detalles: toast, tooltip, modal, campos y botones');
  await click('[data-view="piezas"]');
  await sleep(900);
  const toast = await js(`(async () => {
    const { Toast } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    Toast.show({ title: 'Con hover', duration: 2000 });
    await wait(200);   // si había otro, este entra de relevo un instante después
    const el = [...document.querySelectorAll('.op-toast')].find((t) => t.textContent.includes('Con hover'));
    el.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(600);
    el.dispatchEvent(new PointerEvent('pointerleave'));
    await wait(1200);
    const sigue = el.isConnected && el.dataset.state !== 'closing';
    await wait(1100);
    return { sigueA1200: sigue, seFueA2300: !el.isConnected || el.dataset.state === 'closing' };
  })()`);
  ok('el toast tocado al principio sigue con el tiempo que le quedaba', toast.sigueA1200 && toast.seFueA2300, JSON.stringify(toast));

  const tip = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.createElement('button');
    // Un texto largo: la escala de la entrada lo corre varios píxeles si se mide mal.
    b.className = 'op-iconbtn'; b.dataset.tip = 'Se va, y es un tooltip bastante largo'; b.innerHTML = '<svg width="14" height="14"></svg>';
    b.style.cssText = 'position:fixed;left:600px;top:400px;z-index:5';
    document.body.append(b);
    b.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await wait(700);
    const t = document.querySelector('.op-tooltip:not([data-state="closing"])');
    const rb = b.getBoundingClientRect(); const rt = t?.getBoundingClientRect();
    const centrado = t ? Math.abs((rt.left + rt.right) / 2 - (rb.left + rb.right) / 2) : null;
    const nombre = b.getAttribute('aria-label');
    b.remove();
    await wait(450);
    return { seVio: !!t, centrado, nombre, huerfano: !!document.querySelector('.op-tooltip:not([data-state="closing"])') };
  })()`);
  ok('un tooltip queda centrado sobre su ancla (medido sin la escala de su entrada)', tip.seVio && tip.centrado <= 1, JSON.stringify(tip));
  ok('si su ancla se va del DOM, el tooltip se va', tip.seVio && !tip.huerfano, JSON.stringify(tip));
  ok('un botón de solo ícono toma su nombre del tooltip', tip.nombre === 'Se va, y es un tooltip bastante largo', JSON.stringify(tip));

  /* Con el teclado: sin la ventana enfocada no hay :focus-visible, y la de
     prueba compite por el foco con el escritorio. Se insiste: un tooltip que
     no aparece con el teclado no aparece nunca. */
  let tipTeclado = {};
  await until(async () => {
    win.focus(); win.webContents.focus();
    tipTeclado = await js(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const b = document.querySelector('[data-tip="Botón de ícono"]');
      b.scrollIntoView({ block: 'center' });
      b.focus({ focusVisible: true });
      const foco = b.matches(':focus-visible');
      await wait(650);
      const visto = document.querySelector('.op-tooltip:not([data-state="closing"])')?.textContent;
      b.blur();
      await wait(300);
      return { foco, visto, seFue: !document.querySelector('.op-tooltip:not([data-state="closing"])') };
    })()`);
    return tipTeclado.foco && tipTeclado.visto === 'Botón de ícono' && tipTeclado.seFue;
  }, 8000);
  ok('el tooltip aparece también al llegar con Tab, y se va al salir', tipTeclado.visto === 'Botón de ícono' && tipTeclado.seFue, JSON.stringify(tipTeclado));

  const conEnter = await js(`(async () => {
    const { Modal } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Un campo escondido antes que el de verdad: el foco no se va a lo que no se ve.
    const p = Modal.show({ title: 'Con un campo', body: '<input class="op-input" id="campo-oculto" style="display:none"><input class="op-input" id="campo-enter" value="algo">',
      actions: [{ label: 'Cancelar', value: false }, { label: 'Guardar', value: 'guardado', variant: 'primary' }] });
    await wait(200);
    const foco = document.activeElement?.id;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const v = await Promise.race([p, wait(1200).then(() => 'sin respuesta')]);
    // Si Enter no lo cerró, se cierra acá: el siguiente esperaría su turno para siempre.
    if (v === 'sin respuesta') { Modal.close(null); await p; }
    await wait(400);
    // Con autofocus en el botón, el botón se queda el foco aunque haya campos (imprimir).
    const q = Modal.show({ title: 'De opciones', body: '<input class="op-input" id="campo-copias" type="number" value="1">',
      actions: [{ label: 'Cancelar', value: null }, { label: 'Imprimir', value: 'go', variant: 'primary', autofocus: true }] });
    await wait(200);
    const focoAuto = document.activeElement?.textContent;
    Modal.close(null);
    await Promise.race([q, wait(1500)]);
    await wait(400);
    return { foco, v, focoAuto };
  })()`);
  ok('en un modal con un campo, el foco arranca en el primer campo visible', conEnter.foco === 'campo-enter', JSON.stringify(conEnter));
  ok('y Enter en el campo confirma con la acción primaria', conEnter.v === 'guardado', JSON.stringify(conEnter));
  ok('un botón con autofocus se queda el foco aunque haya campos', conEnter.focoAuto === 'Imprimir', JSON.stringify(conEnter));

  const piezas = await js(`(() => {
    const h = (sel) => document.querySelector(sel)?.getBoundingClientRect().height;
    const cs = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
    const sw = document.querySelector('[data-toggle]');
    const antes = sw.getAttribute('aria-checked');
    sw.click();
    const despues = sw.getAttribute('aria-checked');
    sw.click();
    // La que está activa (según dónde quedó el campo).
    const stp = document.querySelector('#demo-stepper [data-step]:not(:disabled)');
    const swap = document.getElementById('demo-iconswap');
    const icons = swap ? [...swap.querySelectorAll('.op-icon')].map((i) => i.getBoundingClientRect()) : [];
    return {
      alturas: [h('#demo-input'), h('#demo-select'), h('.op-btn--secondary')],
      switchRol: sw.getAttribute('role'), antes, despues,
      flecha: getComputedStyle(stp).color, flechaApagada: getComputedStyle(document.querySelector('#demo-stepper [data-step]:disabled') || stp).color,
      texto3: (() => { const p = document.createElement('span'); p.style.color = 'var(--op-text-3)'; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; })(),
      flechaOpacidad: getComputedStyle(stp).opacity,
      apagado: getComputedStyle(document.querySelector('.op-iconbtn[disabled]')).opacity,
      // Los centros: el que está escondido va achicado, así que sus cantos no coinciden.
      iconswapMismaCelda: icons.length === 2 && Math.abs((icons[0].left + icons[0].right) - (icons[1].left + icons[1].right)) < 1 && Math.abs((icons[0].top + icons[0].bottom) - (icons[1].top + icons[1].bottom)) < 1,
      salida: (() => { const s = document.createElement('div'); s.className = 'op-swap-out op-swap-out--over'; s.dataset.state = 'closing'; document.body.append(s); const d = getComputedStyle(s).animationDuration; s.remove(); return d; })(),
    };
  })()`);
  ok('un campo mide lo mismo que un select y un botón (30 px)', piezas.alturas.every((v) => v === 30), JSON.stringify(piezas.alturas));
  ok('un switch dice qué es y cómo está', piezas.switchRol === 'switch' && piezas.antes !== piezas.despues, JSON.stringify(piezas));
  ok('las flechas del campo numérico que andan se ven (text-3, sin velo)', piezas.flecha === piezas.texto3 && piezas.flechaOpacidad === '1', JSON.stringify(piezas));
  ok('un botón de ícono apagado se ve apagado', Number(piezas.apagado) < 0.7, JSON.stringify(piezas));
  ok('los dos íconos de .op-iconswap viven en la misma celda', piezas.iconswapMismaCelda, JSON.stringify(piezas));
  ok('la salida de un relevo dura --op-t-out', piezas.salida === '0.15s', piezas.salida);
  await js(`document.getElementById('demo-iconswap').click(); true`);
  await sleep(450);
  const cruzado = await js(`[...document.querySelectorAll('#demo-iconswap .op-icon')].map((i) => getComputedStyle(i).opacity).join(',')`);
  ok('y con un click se cruzan', cruzado === '0,1', cruzado);

  /* ── 19. El vidrio que entra no deja un canto claro ────────────────────────
     Prism 0.2.13: un panel de vidrio que entraba moviéndose dejaba una línea
     blanca en su canto de arriba contra una página clara. Con Chromium 152 no
     pasa (medido congelando la entrada en 30, 70 y 120 ms, como allá), y por eso
     los overlays de Opal siguen siendo vidrio y siguen entrando con su
     movimiento. Esto avisa si una versión de Chromium lo trae de vuelta. */
  console.log('\n19. El vidrio que entra no deja un canto claro');
  await js(`(() => {
    const w = document.createElement('div'); w.id = 'canto-blanco';
    w.style.cssText = 'position:fixed;left:300px;top:236px;width:700px;height:500px;background:#fff;z-index:4';
    const a = document.createElement('button'); a.id = 'canto-ancla'; a.textContent = 'ancla';
    a.style.cssText = 'position:fixed;left:420px;top:200px;z-index:5';
    document.body.append(w, a);
    return true;
  })()`);
  const filas = async (t) => {
    await js(`(async () => { const { Menu } = await import('./js/overlays.js'); Menu.show(document.getElementById('canto-ancla'), [{ label: 'Uno' }, { label: 'Dos' }]); return true; })()`);
    await sleep(30);
    const r = await js(`(() => { const m = document.querySelector('.op-menu:not([data-state="closing"])'); for (const a of m.getAnimations()) { a.pause(); a.currentTime = ${t}; } const b = m.getBoundingClientRect(); return { x: Math.round(b.left + 12), y: Math.ceil(b.top), w: Math.round(b.width - 24), top: b.top }; })()`);
    await sleep(120);
    const img = await win.webContents.capturePage({ x: r.x, y: r.y, width: r.w, height: 12 });
    const bm = img.toBitmap(); const Wd = img.getSize().width;
    const out = [];
    for (let y = 0; y < 12; y++) { let s = 0; for (let x = 0; x < Wd; x++) { const i = (y * Wd + x) * 4; s += (bm[i] + bm[i + 1] + bm[i + 2]) / 3; } out.push(Math.round(s / Wd)); }
    await js(`(async () => { const { Menu } = await import('./js/overlays.js'); Menu.close(); return true; })()`);
    await sleep(350);
    /* El canto (las 3 filas de arriba) contra el cuerpo de la hoja (8 a 11),
       en el MISMO cuadro. Comparar el canto que entra con el canto quieto no
       sirve desde que lo que flota lleva base oscura (--op-flota): mientras
       entra por opacidad deja ver el blanco de atrás —es el fundido, no una
       línea—, y el canto quedaba «más claro» con el cuerpo igual de claro. La
       línea del bug era un canto más claro que su propia hoja. */
    return Math.max(...out.slice(0, 3)) - Math.round(out.slice(8, 12).reduce((a, b) => a + b, 0) / 4);
  };
  const quieto = await filas(400);
  const entrando = [await filas(30), await filas(70), await filas(120)];
  await js(`document.getElementById('canto-blanco').remove(); document.getElementById('canto-ancla').remove(); true`);
  ok('mientras entra, el canto no se despega de su hoja más que quieto', entrando.every((v) => v <= quieto + 8), JSON.stringify({ quieto, entrando }));

  /* ── 19-bis. Lo que flota tiene el tono de las tarjetas ────────────────────
     La regla de --op-flota (tokens.css): un menú o un toast queda del MISMO
     tono que la tarjeta que tapa, medido a píxel y no a ojo. Con solo luz y
     blur quedaban el doble de claros (tarjeta 25, menú 50, toast 34). */
  console.log('\n19-bis. Lo que flota tiene el tono de las tarjetas');
  await click('[data-view="piezas"]');
  await js(`document.querySelector('.op-main .op-scroll')?.scrollTo(0, 0); true`);
  await sleep(900);
  const zonas = await js(`(async () => {
    const { Menu, Toast } = await import('./js/overlays.js');
    const cards = [...document.querySelectorAll('.op-main .op-card')].filter((c) => { const r = c.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 20 && r.width > 200 && r.height > 120; });
    cards.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
    if (!cards.length) return null;
    const c = cards[0].getBoundingClientRect();
    Menu.showAt(c.left + 20, c.top + 10, [{ label: 'Abrir', icon: 'folder' }, { label: 'Copiar', icon: 'copy' }, { label: 'Eliminar', icon: 'trash', danger: true }]);
    Toast.show({ title: 'Tono', text: 'Medido a píxel', icon: 'check', duration: 0 });
    await new Promise((r) => setTimeout(r, 900));
    const m = document.querySelector('.op-menu').getBoundingClientRect();
    const t = document.querySelector('.op-toast:not([data-state="closing"])').getBoundingClientRect();
    return { tarjeta: [Math.min(c.right - 20, m.right + 30), c.top + 20], menu: [m.right - 14, m.top + 40], toast: [t.right - 60, t.bottom - 12] };
  })()`);
  const tonos = {};
  if (zonas) {
    const img = await win.webContents.capturePage();
    const bm = img.toBitmap(); const Wd = img.getSize().width;
    const tono = ([x, y]) => { let v = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const i = ((Math.round(y) + dy) * Wd + Math.round(x) + dx) * 4; v += (bm[i] + bm[i + 1] + bm[i + 2]) / 3; } return Math.round(v / 25); };
    for (const [k, p] of Object.entries(zonas)) tonos[k] = tono(p);
  }
  await js(`(async () => { const { Menu } = await import('./js/overlays.js'); Menu.close(); document.querySelector('.op-toast:not([data-state="closing"]) [data-close]')?.click(); return true; })()`);
  await sleep(500);
  ok('el menú tiene el tono de la tarjeta que tapa (±4)', zonas && Math.abs(tonos.menu - tonos.tarjeta) <= 4, JSON.stringify(tonos));
  ok('el toast también (±4)', zonas && Math.abs(tonos.toast - tonos.tarjeta) <= 4, JSON.stringify(tonos));

  /* Las variantes de más transparencia (30/10/2026): la base del menú baja de
     75 % a 45 % (Translúcido) y a 20 % (Vidrio), y la de fábrica vuelve sola. */
  const bases = await js(`(async () => {
    const { Shell } = await import('./js/shell.js');
    const { Menu } = await import('./js/overlays.js');
    const alfa = () => { Menu.showAt(200, 200, [{ label: 'Abrir', icon: 'folder' }]); const c = getComputedStyle(document.querySelector('.op-menu')).backgroundColor; Menu.close(); const n = c.match(/[\\d.]+/g).map(Number); return /\\//.test(c) || /rgba/.test(c) ? n.at(-1) : 1; };
    const r = {};
    for (const v of ['tarjeta', 'translucido', 'transparente', 'acrilico']) { Shell.set({ vidrio: v }); r[v] = alfa(); }
    // Acrílico (la receta de las ventanas de UmbroSys): nada opaco detrás, el
    // velo sobre el escritorio al 42 %, la ventana con --op-bg al 20 % y las
    // hojas del shell sin blur propio (la ventana ya es el vidrio)
    const fondo = (el) => getComputedStyle(el).backgroundColor;
    r.opacos = [document.documentElement, document.body, document.querySelector('.op-app')].map(fondo).filter((c) => c !== 'rgba(0, 0, 0, 0)');
    r.velo = fondo(document.querySelector('.op-fog'));
    r.capas = getComputedStyle(document.querySelector('.op-fog')).backgroundImage;
    r.hojas = ['.op-rail', '.op-main'].map((s) => getComputedStyle(document.querySelector(s)).backdropFilter);
    r.hoja = getComputedStyle(document.documentElement).getPropertyValue('--op-s0').trim();
    r.puente = typeof window.opal?.win?.setAcrilico;
    Shell.set({ vidrio: 'tarjeta' });
    r.opacoVuelve = fondo(document.body) !== 'rgba(0, 0, 0, 0)';
    r.vuelve = alfa();
    r.html = document.documentElement.className;
    return r;
  })()`);
  ok('el vidrio de lo que flota: Translúcido y Vidrio bajan la base del menú, y la de fábrica vuelve', bases.tarjeta === 0.75 && bases.translucido === 0.45 && bases.transparente === 0.2 && bases.vuelve === 0.75 && !/vidrio-/.test(bases.html), JSON.stringify(bases));
  ok('Acrílico (receta de UmbroSys): lo flotante con la base de la ventana (20 %), nada opaco detrás, velo al 42 %, la ventana al 20 % y las hojas sin blur', bases.acrilico === 0.2 && !bases.opacos.length && /\/ 0\.42\)/.test(bases.velo) && /\/ 0\.2\)/.test(bases.capas) && bases.hojas.every((f) => f === 'none') && /\.022\)/.test(bases.hoja) && bases.opacoVuelve && bases.puente === 'function', JSON.stringify(bases));

  /* ── 19-ter. La terminal ─────────────────────────────────────────────────
     Las teclas van por el canal de entrada de la ventana, como las de una
     persona: el campo de verdad es un textarea invisible y el cursor de
     bloque se repinta donde quedó el caret. */
  console.log('\n19-ter. La terminal');
  const teclear = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(12); } await sleep(80); };
  /* Una tecla de verdad trae su carácter: Enter, el '\r'. Sin él, Chromium
     se come el SIGUIENTE carácter (el que sigue a un keydown cancelado se
     descarta, porque se lo supone de esa tecla) y la primera letra del
     comando que viene no llegaba. */
  const tecla = async (k, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers });
    if (k === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers });
    await sleep(120);
  };
  const termOut = () => js(`[...document.querySelectorAll('.op-term__out .op-term__line')].map((l) => l.textContent)`);
  await click('[data-view="terminal"]');
  await sleep(700);
  const term0 = await js(`({
    foco: document.activeElement?.classList.contains('op-term__input'),
    fuente: getComputedStyle(document.querySelector('.op-term')).fontFamily,
    cursor: (() => { const c = document.querySelector('.op-term__cur'); const cs = c && getComputedStyle(c); return cs && { fondo: cs.backgroundColor, glow: cs.boxShadow, ancho: c.getBoundingClientRect().width }; })(),
  })`);
  ok('abre con el foco en su campo', term0.foco === true);
  ok('escribe en Roboto Mono', /Roboto Mono/.test(term0.fuente), term0.fuente);
  await tecla('End');   // suelta el carácter pendiente de la última tecla cancelada (el Escape de arriba)
  ok('el cursor es un bloque de luz con resplandor', term0.cursor && term0.cursor.ancho >= 6 && !/rgba?\(0, 0, 0, 0\)|transparent/.test(term0.cursor.fondo) && /px/.test(term0.cursor.glow), JSON.stringify(term0.cursor));
  await teclear('echo hola humo');
  await tecla('Left'); await tecla('Left'); await tecla('Left'); await tecla('Left');
  const bajoCursor = await js(`({ letra: document.querySelector('.op-term__cur').textContent, valor: document.querySelector('.op-term__input').value })`);
  ok('las flechas mueven el bloque sobre la letra', bajoCursor.letra === 'h', JSON.stringify(bajoCursor));
  await tecla('End'); await tecla('Return');
  await sleep(200);
  const trasEcho = await termOut();
  ok('Enter ejecuta: echo responde', trasEcho.includes('hola humo'), JSON.stringify(trasEcho.slice(-3)));
  await tecla('Up');
  ok('la flecha de arriba trae el último comando', (await js(`document.querySelector('.op-term__input').value`)) === 'echo hola humo');
  await js(`(() => { const i = document.querySelector('.op-term__input'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);
  await teclear('ec'); await tecla('Tab');
  ok('Tab completa el comando', (await js(`document.querySelector('.op-term__input').value`)) === 'echo ');
  await js(`(() => { const i = document.querySelector('.op-term__input'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()`);
  await teclear('blabla'); await tecla('Return');
  await sleep(200);
  ok('un comando que no existe responde en rojo', await js(`!!document.querySelector('.op-term__out .op-term__line:nth-last-child(2) .op-term__err')`));
  const antesN = await js(`document.querySelector('[data-view="items"] .op-navitem__count').textContent`);
  await teclear('nuevo Humo terminal'); await tecla('Return');
  await sleep(700);
  ok('nuevo crea un ítem de verdad', Number(await js(`document.querySelector('[data-view="items"] .op-navitem__count').textContent`)) === Number(antesN) + 1);
  await teclear('npm test'); await tecla('Return');
  await sleep(700);
  const ocupada = await js(`document.querySelector('.op-term').classList.contains('is-busy')`);
  await tecla('C', ['control']);
  await sleep(700);
  const tras = await termOut();
  ok('npm test escribe de a poco y Ctrl+C lo corta', ocupada && tras.includes('^C') && !tras.some((l) => l.includes('tests 5')) && !(await js(`document.querySelector('.op-term').classList.contains('is-busy')`)));
  const lineas = (await termOut()).length;
  await click('[data-view="inicio"]'); await sleep(500);
  await click('[data-view="terminal"]'); await sleep(600);
  ok('irse y volver la deja como estaba', (await termOut()).length === lineas);
  await tecla('L', ['control']);
  ok('Ctrl+L limpia', (await termOut()).length === 0);

  /* ── 19-quater. Las variantes del shell ──────────────────────────────────
     Se prenden con Shell.set y entran haciendo viajar las pistas de la
     grilla: se mide dónde terminan, no la clase. */
  console.log('\n19-quater. Las variantes del shell');
  const shell = (o) => js(`(async () => { const { Shell } = await import('./js/shell.js'); Shell.set(${JSON.stringify(o)}); return true; })()`);
  await click('[data-view="items"]'); await sleep(500);
  await shell({ panel: true, composer: true });
  await sleep(700);
  const prendido = await js(`(() => {
    const p = document.getElementById('panel'), c = document.getElementById('composer');
    const v = document.querySelector('.op-viewhead__title').getBoundingClientRect(), t = document.querySelector('.op-panel__title')?.getBoundingClientRect();
    return { panel: Math.round(p.getBoundingClientRect().width), panelInert: p.inert, comp: Math.round(c.getBoundingClientRect().height), compInert: c.inert,
             titulos: t ? Math.abs((v.top + v.height / 2) - (t.top + t.height / 2)) : null };
  })()`);
  ok('el panel derecho entra con el ancho del rail', prendido.panel === 224 && !prendido.panelInert, JSON.stringify(prendido));
  ok('el título del panel queda a la altura del de la vista', prendido.titulos !== null && prendido.titulos <= 1, String(prendido.titulos));
  ok('el compositor entra', prendido.comp > 40 && !prendido.compInert, JSON.stringify(prendido));
  const antesC = await js(`document.querySelector('[data-view="items"] .op-navitem__count').textContent`);
  await js(`(() => { const i = document.getElementById('composer-input'); i.focus(); i.value = 'Desde el chat del humo'; i.dispatchEvent(new Event('input')); return true; })()`);
  ok('con texto, enviar se prende', await js(`!document.getElementById('composer-send').disabled`));
  await tecla('Return');
  await sleep(800);
  ok('Enter en el compositor crea un ítem y lo vacía',
    Number(await js(`document.querySelector('[data-view="items"] .op-navitem__count').textContent`)) === Number(antesC) + 1 && (await js(`document.getElementById('composer-input').value`)) === '');
  ok('el toast cae arriba del compositor', await js(`(() => { const t = document.querySelector('.op-toast:not([data-state="closing"])'); return !!t && t.getBoundingClientRect().bottom <= document.querySelector('.op-composer__box').getBoundingClientRect().top; })()`));
  await shell({ titlebar: false, statusbar: false });
  await sleep(700);
  const sinBarras = await js(`(() => {
    const tb = document.querySelector('.op-titlebar').getBoundingClientRect(), sb = document.querySelector('.op-statusbar').getBoundingClientRect();
    const wc = document.querySelector('.op-wincontrols').getBoundingClientRect(), br = document.querySelector('.op-rail__brand').getBoundingClientRect();
    return { titlebar: Math.round(tb.height), statusbar: Math.round(sb.height), controles: Math.round(wc.top), marca: Math.round(br.height) };
  })()`);
  ok('sin titlebar ni statusbar, las dos filas miden 0', sinBarras.titlebar === 0 && sinBarras.statusbar === 0, JSON.stringify(sinBarras));
  ok('la marca baja al rail y los controles flotan en la esquina', sinBarras.marca > 20 && sinBarras.controles === 12, JSON.stringify(sinBarras));
  await shell({ titlebar: true, statusbar: true, panel: false, composer: false });
  await sleep(700);
  const guardado = await js(`({ panel: Math.round(document.getElementById('panel').getBoundingClientRect().width), comp: Math.round(document.getElementById('composer').getBoundingClientRect().height),
    inert: document.getElementById('panel').inert && document.getElementById('composer').inert })`);
  ok('guardados, el panel y el compositor miden 0 y Tab no entra', guardado.panel === 0 && guardado.comp === 0 && guardado.inert, JSON.stringify(guardado));

  /* ── 19-quinquies. Nada cambia de lugar para entrar o salir (oct 2026) ────
     Fran vio «botones saltando» en el humo de Umbral. Desde entonces lo que
     aparece se enciende en su lugar, lo que cambia de estado se cruza en la
     misma celda, y lo que se cierra apaga lo de adentro antes de cerrarse. */
  console.log('\n19-quinquies. Nada cambia de lugar para entrar o salir');
  const nadaSeMueve = await js(`(async () => {
    const m = await import('./js/motion.js');
    const { Toast } = await import('./js/overlays.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = {};
    // Los únicos @keyframes que mueven algo son los que giran, barren, cuentan
    // o respiran, y el del tooltip (Fran lo prefiere así).
    const permitidos = new Set(['op-spin', 'op-breathe', 'op-meter-sweep', 'op-toast-life', 'op-pop-in', 'op-pop-out']);
    r.mueven = [];
    r.activoMueve = [];
    for (const sh of document.styleSheets) {
      let reglas; try { reglas = sh.cssRules; } catch { continue; }
      for (const k of reglas) {
        if (k.type === CSSRule.KEYFRAMES_RULE && !permitidos.has(k.name) && /transform|translate/.test(k.cssText)) r.mueven.push(k.name);
        // Los botones. La tarjeta interactiva sube y se achica a propósito (Fran
        // la quiso así) y la perilla del slider crece al agarrarla.
        if (k.type === CSSRule.STYLE_RULE && /:active/.test(k.selectorText) && /btn|send|segmented|op-tab|navitem|wincontrol/.test(k.selectorText) && k.style.transform) r.activoMueve.push(k.selectorText);
      }
    }
    // Una celda: el botón no cambia de ancho ni el vecino de lugar, en ningún cuadro.
    const caja = document.createElement('div');
    caja.style.cssText = 'position:fixed;left:20px;top:20px;display:flex;gap:8px;z-index:9999';
    caja.innerHTML = '<span id="q-vecino">vecino</span><button class="op-btn op-btn--secondary" id="q-btn"><span class="op-celda"><span>Copiar</span><span hidden>Copiado al portapapeles</span></span></button>';
    document.body.append(caja);
    const btn = caja.querySelector('#q-btn'), vec = caja.querySelector('#q-vecino');
    const w0 = btn.getBoundingClientRect().width, x0 = vec.getBoundingClientRect().left;
    m.celda(btn, 1);
    const anchos = [];
    for (let i = 0; i < 10; i++) { await wait(30); anchos.push(btn.getBoundingClientRect().width); }
    m.celda(btn, 0);
    for (let i = 0; i < 6; i++) { await wait(30); anchos.push(btn.getBoundingClientRect().width); }
    r.celdaQuieta = anchos.every((w) => Math.abs(w - w0) < 0.01) && vec.getBoundingClientRect().left === x0;
    r.celdaMideLoMasGrande = w0 > 120;
    const estados = [...btn.querySelector('.op-celda').children];
    r.celdaVuelve = !estados[0].hidden && estados[1].hidden;
    caja.remove();
    // Un toast que releva a otro aparece en el mismo lugar, y ninguno se mueve.
    Toast.show({ title: 'Uno', text: 'el primero' });
    await wait(350);
    const uno = document.querySelector('.op-toast');
    const abajo0 = uno.getBoundingClientRect().bottom;
    Toast.show({ title: 'Otro', text: 'el que lo releva' });
    const los = () => [...document.querySelectorAll('.op-toast')];
    const muestras = [];
    for (let i = 0; i < 12; i++) {
      await wait(30);
      for (const t of los()) muestras.push({ b: Math.round(t.getBoundingClientRect().bottom), tr: getComputedStyle(t).transform });
    }
    r.toastsJuntos = muestras.length > 12;
    r.toastMismoLugar = muestras.every((s) => Math.abs(s.b - Math.round(abajo0)) <= 1);
    r.toastQuieto = muestras.every((s) => s.tr === 'none');
    r.toastUnoSolo = los().length === 1;
    document.querySelector('.op-toast [data-close]')?.click();
    await wait(400);
    return r;
  })()`);
  ok('ningún @keyframes mueve nada salvo los que giran, barren, cuentan o respiran', nadaSeMueve.mueven.length === 0, JSON.stringify(nadaSeMueve.mueven));
  ok('presionar no achica ni corre ningún botón', nadaSeMueve.activoMueve.length === 0, JSON.stringify(nadaSeMueve.activoMueve));
  ok('celda: el botón mide lo del rótulo más largo y no cambia de ancho en ningún cuadro; el vecino no se mueve',
    nadaSeMueve.celdaQuieta && nadaSeMueve.celdaMideLoMasGrande && nadaSeMueve.celdaVuelve, JSON.stringify(nadaSeMueve));
  ok('toast: el que releva aparece en el mismo lugar, ninguno se desplaza, y queda uno solo',
    nadaSeMueve.toastsJuntos && nadaSeMueve.toastMismoLugar && nadaSeMueve.toastQuieto && nadaSeMueve.toastUnoSolo, JSON.stringify(nadaSeMueve));

  // El panel se apaga ANTES de que su pista se cierre: el texto no llega
  // visible al borde (Fran, oct 2026).
  await shell({ panel: true });
  await sleep(700);
  const cierre = await js(`(async () => {
    const { Shell } = await import('./js/shell.js');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const p = document.getElementById('panel');
    const w0 = p.getBoundingClientRect().width;
    Shell.set({ panel: false });
    await wait(90);
    const a90 = { w: p.getBoundingClientRect().width, o: +getComputedStyle(p).opacity };
    await wait(110);
    const a200 = { w: p.getBoundingClientRect().width, o: +getComputedStyle(p).opacity };
    await wait(400);
    return { w0, a90, a200, fin: p.getBoundingClientRect().width };
  })()`);
  ok('al guardar el panel, a los 90 ms ya casi no se ve y su pista todavía no se movió',
    cierre.w0 > 100 && cierre.a90.w === cierre.w0 && cierre.a90.o < 0.3, JSON.stringify(cierre));
  ok('cuando la pista se cierra, el panel ya está apagado del todo', cierre.a200.o === 0 && cierre.fin === 0, JSON.stringify(cierre));

  /* ── 20. Si se cae la interfaz, vuelve sola ───────────────────────────────
     Va al final: recarga la ventana. */
  console.log('\n20. Si se cae el proceso de la interfaz, la ventana vuelve sola');
  const { keepAlive } = require(path.join(ROOT, 'src', 'recover.cjs'));
  const caidas = [];
  keepAlive(win, { onGone: (d) => caidas.push(d.reason) });
  win.webContents.forcefullyCrashRenderer();
  const volvio = await until(async () => js(`!document.getElementById('boot-splash') && document.getElementById('view').children.length > 0`).catch(() => false), 15000);
  ok('se recarga y la app arranca de nuevo', !!volvio && caidas.length === 1, JSON.stringify({ volvio, caidas }));
  if (!volvio) {
    // Con la página muerta, la limpieza de abajo esperaría para siempre.
    if (OWN_DATA) fs.rmSync(process.env.OPAL_DATA, { recursive: true, force: true });
    console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
    app.exit(1);
    return;
  }

  // El test no puede dejar basura en los datos.
  if (id) await js(`window.opal.col('items').remove(${JSON.stringify(id)})`);
  await js(`window.opal.settings.save({ densidad:'comoda' })`);
  if (OWN_DATA) fs.rmSync(process.env.OPAL_DATA, { recursive: true, force: true });

  console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
  console.log(errores.length ? `CONSOLA:\n  ${errores.join('\n  ')}` : 'CONSOLA: limpia');
  app.exit(fail || errores.length ? 1 : 0);
});
