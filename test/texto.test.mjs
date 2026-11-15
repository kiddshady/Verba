/* El texto: calidad, párrafos, correcciones y formatos de salida (src/texto.cjs).
   Node pelado, sin Electron: `node test/texto.test.mjs`. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const T = createRequire(import.meta.url)('../src/texto.cjs');
let n = 0;
const caso = (nombre, fn) => { fn(); n++; console.log(`  pass  ${nombre}`); };

const seg = (s, e, t, lp = -0.1, extra = {}) => ({ s, e, t, lp, ns: 0.01, cr: 1.4, ...extra });

caso('reloj y lapso', () => {
  assert.equal(T.reloj(0), '0:00');
  assert.equal(T.reloj(75), '1:15');
  assert.equal(T.reloj(3725), '1:02:05');
  assert.equal(T.lapso(45), '45 s');
  assert.equal(T.lapso(271), '4 min 31 s');
  assert.equal(T.lapso(5160), '1 h 26 min');
  assert.equal(T.relojSrt(3661.5), '01:01:01,500');
});

caso('calidad: confianza por tiempo, bucles e inventos', () => {
  const q = T.calidad([
    seg(0, 30, 'Uno.', -0.1), seg(30, 40, 'Dos.', -0.8), seg(40, 50, 'Tres tres tres.', -0.2, { cr: 3.1 }),
    seg(50, 52, 'Gracias.', -0.9),
  ]);
  assert.deepEqual(q, { alta: 80, bucles: 1, inventos: 1 });
  assert.deepEqual(T.calidad([]), { alta: 0, bucles: 0, inventos: 0 });
});

caso('un «gracias» adentro de una oración no es invento', () => {
  assert.equal(T.esInvento(seg(0, 1, 'Gracias.')), true);
  assert.equal(T.esInvento(seg(0, 1, '¡Gracias!')), true);
  assert.equal(T.esInvento(seg(0, 1, 'Gracias a la MAO, se degrada.')), false);
  assert.equal(T.esInvento(seg(0, 1, 'Subtítulos realizados por la comunidad de Amara.org')), true);
});

caso('correcciones: palabra entera, sin distinguir mayúsculas', () => {
  const k = T.armarCorrector([{ de: 'reserfina', a: 'reserpina' }, { de: 'receptores H1', a: 'receptores α1' }]);
  const p = T.corregir('La reserfina baja la presión. Reserfina, dije. Los receptores H1 no; la reserfinada tampoco.', k);
  assert.equal(p.map((x) => x.t).join(''), 'La reserpina baja la presión. Reserpina, dije. Los receptores α1 no; la reserfinada tampoco.');
  assert.deepEqual(p.filter((x) => x.fx != null).map((x) => [x.fx, x.de]), [[0, 'reserfina'], [0, 'Reserfina'], [1, 'receptores H1']]);
  assert.equal(T.armarCorrector([{ de: '', a: 'x' }, { de: 'igual', a: 'Igual' }]), null);
});

caso('párrafos: cortan cerca de los 55 s y en un punto', () => {
  const segs = [];
  for (let i = 0; i < 20; i++) segs.push(seg(i * 10, i * 10 + 10, i % 2 ? 'sigue la idea' : 'Termina acá.'));
  const { parrafos } = T.parrafos(segs);
  assert.ok(parrafos.length >= 3);
  assert.equal(parrafos[0].t, 0);
  for (const p of parrafos.slice(0, -1)) {
    assert.ok(p.e - p.t >= 55 && p.e - p.t <= 90, `párrafo de ${p.e - p.t} s`);
    assert.match(T.textoDe(p), /\.$/);
  }
});

caso('párrafos: confianza baja, inventos marcados y usos con su minuto', () => {
  const segs = [seg(0, 20, 'La reserfina bloquea el VMAT.', -0.1), seg(20, 60, 'Otra vez reserfina.', -0.2), seg(60, 62, 'Gracias.', -1.2),
    seg(62, 120, '¿Y el propranolol dónde entra?', -0.9)];
  const { parrafos, usos } = T.parrafos(segs, [{ de: 'reserfina', a: 'reserpina' }]);
  assert.equal(parrafos.length, 2);
  assert.equal(parrafos[0].baja, false);
  assert.equal(parrafos[1].baja, true);
  assert.equal(parrafos[1].partes.some((x) => x.inv), true);
  assert.equal(T.textoDe(parrafos[1]), '¿Y el propranolol dónde entra?');
  assert.deepEqual(usos, [{ i: 0, de: 'reserfina', a: 'reserpina', en: [0, 20] }]);
});

const clase = {
  nombre: 'Sistema adrenérgico', archivo: 'QM 08-10.mp3', materia: 'Medicinal', dur: 122, modelo: 'large-v3-turbo', tardo: 9,
  segs: [seg(0, 20, 'La reserfina bloquea el VMAT.'), seg(20, 60, 'Otra vez reserfina.'), seg(60, 62, 'Gracias.'), seg(62, 120, '¿Y el propranolol?', -0.9)],
};
const corr = [{ de: 'reserfina', a: 'reserpina' }];

caso('Markdown: cabecera, tiempos, tabla de correcciones y lo que hay que chequear', () => {
  const md = T.aMarkdown(clase, corr);
  assert.match(md, /^# Sistema adrenérgico\n/);
  assert.match(md, /\*\*Duración:\*\* 2:02/);
  assert.match(md, /\*\*\[0:00\]\*\* La reserpina bloquea el VMAT\. Otra vez reserpina\./);
  assert.match(md, /\| reserfina \| reserpina \| 0:00, 0:20 \|/);
  assert.match(md, /\[1:00\] Posible invento en un silencio/);
  assert.match(md, /Confianza baja: «¿Y el propranolol\?»/);
  assert.doesNotMatch(md.split('## Correcciones')[0], /Gracias/);
});

caso('texto corrido, con tiempos y SRT', () => {
  assert.equal(T.aTexto(clase, corr), 'La reserpina bloquea el VMAT. Otra vez reserpina.\n\n¿Y el propranolol?\n');
  assert.match(T.aTexto(clase, corr, { tiempos: true }), /^\[0:00\] La reserpina/);
  const srt = T.aSrt(clase, corr);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:20,000\nLa reserpina bloquea el VMAT\.\n\n2\n/);
  assert.equal(srt.includes('Gracias'), false);
  assert.equal((srt.match(/-->/g) || []).length, 3);
});

console.log(`texto: ${n} casos, todos pasan`);
