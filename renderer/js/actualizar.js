/* ═══════════════════════════════════════════════════════════════════════════
   VERBA — las actualizaciones, en la cara
   El proceso principal busca al rato de abrir y cada cuatro horas, y una
   versión nueva se baja sola (src/actualizador.cjs). Acá no se interrumpe
   nada: mientras baja y cuando está lista, aparece un ítem en la statusbar; un
   solo aviso cuando ya se bajó; y en Ajustes, el estado con su botón.

   Reiniciar con algo transcribiéndose lo corta (vuelve a la cola al abrir):
   antes de hacerlo se pregunta.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Toast, Modal } from './overlays.js';
import { fmtBytes } from './format.js';

const api = window.opal?.update;
let estado = null;
let avisada = null;            // la versión de la que ya se avisó (un aviso por versión)
let ocupada = () => false;     // la app dice si hay algo transcribiéndose
const oyentes = new Set();

const pct = (s) => Math.round((s.progreso?.pct || 0) * 100);

/** Lo que muestra la statusbar: nada, salvo que haya una versión en camino. */
function pintarBarra() {
  const b = document.getElementById('stat-update');
  if (!b) return;
  const s = estado;
  let texto = '';
  if (s?.fase === 'disponible') texto = `Bajar Verba ${s.version}`;
  if (s?.fase === 'descargando') texto = `Bajando Verba ${s.version} · ${pct(s)} %`;
  if (s?.fase === 'listo') texto = `Reiniciar con Verba ${s.version}`;
  b.hidden = !texto;
  b.disabled = s?.fase === 'descargando';
  if (b.textContent !== texto) b.textContent = texto;
  b.dataset.tip = s?.fase === 'listo' ? 'Ya está bajada. Si no reiniciás, entra sola cuando cierres Verba.' : '';
}

function alCambiar(s) {
  const antes = estado;
  estado = s;
  if (!s) return;
  if (s.fase === 'listo' && avisada !== s.version) {
    avisada = s.version;
    Toast.show({ title: `Verba ${s.version || ''} está lista`.replace('  ', ' '), text: 'Se bajó sola y entra cuando cierres Verba. Para tenerla ya, reiniciá desde la barra de abajo.', icon: 'check' });
  } else if (s.manual && s.fase === 'al-dia' && antes?.fase === 'buscando') {
    Toast.show({ title: 'Estás al día', text: `Verba ${s.actual} es la última.`, icon: 'check' });
  } else if (s.fase === 'error' && (s.manual || antes?.fase === 'descargando') && antes?.error !== s.error) {
    Toast.show({ title: 'No se pudo actualizar', text: s.error, tone: 'error' });
  }
  pintarBarra();
  oyentes.forEach((fn) => fn(s));
}

async function reiniciar() {
  if (ocupada()) {
    const ok = await Modal.confirm({
      title: 'Hay una transcripción en curso',
      sub: 'Si reiniciás ahora, se corta. Vuelve a la cola y empieza de nuevo cuando abras Verba.',
      confirmLabel: 'Reiniciar igual',
    });
    if (!ok) return;
  }
  api.instalar();
}

/** Lo que corresponde hacer ahora: bajar, reiniciar o buscar. */
export function accionUpdate() {
  if (!api || !estado) return;
  if (estado.fase === 'disponible') api.descargar();
  else if (estado.fase === 'listo') reiniciar();
  else if (estado.fase !== 'buscando' && estado.fase !== 'descargando' && estado.fase !== 'sin-soporte') api.buscar({ manual: true });
}

/** El estado, dicho para Ajustes: { texto, boton, apagado }. */
export function vistaUpdate() {
  const s = estado;
  if (!api || !s) return { texto: '', boton: 'Buscar actualizaciones', apagado: true };
  switch (s.fase) {
    case 'sin-soporte': return { texto: s.motivo, boton: 'Buscar actualizaciones', apagado: true };
    case 'buscando': return { texto: 'Buscando una versión nueva.', boton: 'Buscar actualizaciones', apagado: true };
    case 'al-dia': return { texto: `Verba ${s.actual} es la última.`, boton: 'Buscar actualizaciones', apagado: false };
    case 'disponible': return { texto: `Hay una versión nueva: ${s.version}${s.bytes ? `, ${fmtBytes(s.bytes)}` : ''}.`, boton: `Bajar Verba ${s.version}`, apagado: false };
    case 'descargando': return { texto: `Bajando Verba ${s.version}: ${pct(s)} %.`, boton: 'Buscar actualizaciones', apagado: true };
    case 'listo': return { texto: `Verba ${s.version} ya está bajada. Entra sola cuando cierres la app.`, boton: 'Reiniciar ahora', apagado: false };
    case 'error': return { texto: s.error, boton: 'Buscar actualizaciones', apagado: false };
    default: return { texto: 'Se buscan solas al abrir y cada cuatro horas.', boton: 'Buscar actualizaciones', apagado: false };
  }
}

/** Avisa cada vez que cambia el estado. Devuelve cómo dejar de escuchar. */
export function onUpdate(fn) {
  oyentes.add(fn);
  return () => oyentes.delete(fn);
}

export function iniciarActualizaciones({ transcribiendo } = {}) {
  if (!api) return;
  if (transcribiendo) ocupada = transcribiendo;
  document.getElementById('stat-update')?.addEventListener('click', accionUpdate);
  api.onCambio(alCambiar);
  api.estado().then(alCambiar).catch(() => {});
}
