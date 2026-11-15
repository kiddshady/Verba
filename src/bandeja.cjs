'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Verba — bandeja del sistema (el molde es el de Apex, src/bandeja.cjs)

   El ícono al lado del reloj. Existe mientras la app corre, y es lo que hace
   que cerrar la ventana no sea cerrar Verba: con `cerrarAlTray` la X esconde,
   la cola sigue transcribiendo y desde acá se vuelve.

   El menú es NATIVO, lo pinta Windows: es el único lugar de la app donde no
   mandan nuestros estilos. Por eso lleva lo mínimo, abrir y salir, y todo lo
   demás vive adentro de la ventana.
   ═══════════════════════════════════════════════════════════════════════════ */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

/* El ícono exacto de la app, con su baldosa (tools/icono.cjs). 32 px y no 16:
   Windows lo baja a 16 en pantallas al 100 % con mejor filtro que el que haría
   al agrandar, y lo usa tal cual al 200 %. */
const ICONO = path.join(__dirname, '..', 'build', 'icon.png');

let tray = null;

function icono() {
  const img = nativeImage.createFromPath(ICONO);
  // Si el PNG no viajó, la imagen viene vacía en vez de tirar: Windows pinta
  // un hueco, que es mejor que quedarse sin bandeja y sin forma de volver.
  return img.isEmpty() ? img : img.resize({ width: 32, height: 32, quality: 'best' });
}

/**
 * Crea el ícono. `mostrar` trae la ventana al frente; `salir` termina Verba de
 * verdad (con la X escondiendo, este menú es el único lugar desde donde se
 * puede). Llamarla dos veces no crea dos íconos.
 */
function crear({ mostrar, salir }) {
  if (tray) return tray;
  tray = new Tray(icono());
  rotular('');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Verba', click: mostrar },
    { type: 'separator' },
    { label: 'Salir', click: salir },
  ]));
  // Click izquierdo: mostrar, nunca alternar. Un toggle acá esconde la ventana
  // justo cuando alguien la fue a buscar.
  tray.on('click', mostrar);
  return tray;
}

/** Lo que dice el ícono al pasarle el mouse: en qué anda la cola. */
let ultimo = null;
function rotular(texto) {
  if (!tray || tray.isDestroyed()) return;
  const t = `Verba${texto ? ` · ${texto}` : ''}`.slice(0, 120);   // Windows corta en 127
  if (t === ultimo) return;
  ultimo = t;
  tray.setToolTip(t);
}

/** Sin esto, el ícono queda de fantasma en la bandeja hasta que pasás el mouse. */
function destruir() {
  if (!tray) return;
  tray.destroy();
  tray = null;
  ultimo = null;
}

module.exports = { crear, rotular, destruir, version: () => app.getVersion() };
