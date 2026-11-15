'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   La marca de Verba: «la onda sola». Cinco barras cian sobre una baldosa
   carbón a sangre, con un resplandor suave detrás (la candidata 9 de
   S:\mockups\verba\icono.html, elegida por Fran el 15/11/2026).

   El dibujo es uno solo y sale de acá: el ícono de la app, la marca de la
   titlebar, la del rail y la del splash. tools/icono.cjs lo escribe en cada
   lugar, así no pueden desfasarse.
   ═══════════════════════════════════════════════════════════════════════════ */

const BALDOSA = '#0f1113';
const CIAN = '#22d3ee';

/**
 * El SVG de la marca.
 *   tam      lado en px (width/height)
 *   baldosa  false: solo las barras, sobre transparente
 *   id       prefijo para el degradado: dos marcas en la misma página no
 *            pueden compartir id
 */
function marca({ tam = 64, baldosa = true, id = 'vb' } = {}) {
  const fondo = baldosa
    ? `<rect width="64" height="64" rx="12" fill="${BALDOSA}"/><circle cx="32" cy="32" r="30" fill="url(#${id}-luz)" opacity=".22"/>`
    : '';
  const defs = baldosa
    ? `<defs><radialGradient id="${id}-luz"><stop offset="0" stop-color="${CIAN}"/><stop offset="1" stop-color="${CIAN}" stop-opacity="0"/></radialGradient></defs>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tam}" height="${tam}" viewBox="0 0 64 64">${defs}${fondo}`
    + `<path d="M16 27v10M24 21v22M32 16v32M40 23v18M48 27v10" fill="none" stroke="${CIAN}" stroke-width="5" stroke-linecap="round"/></svg>`;
}

module.exports = { marca, BALDOSA, CIAN };
