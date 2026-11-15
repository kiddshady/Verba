'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   OPAL — puente IPC
   El renderer no tiene fs, ni require, ni red: `contextIsolation` está activo.
   Todo lo que necesite del sistema pasa por acá, y acá se decide qué se puede
   pedir. Es la superficie de ataque de la app: todo lo que agregues es una
   puerta más.

   Convención: cada handler devuelve {ok:true, data} o {ok:false, error}. El
   preload la desenvuelve y convierte el error en una excepción real, así el
   renderer escribe try/catch normal en vez de chequear banderas.
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcMain, app, clipboard, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store.cjs');
const motor = require('./motor.cjs');
const { FORMATOS } = require('./texto.cjs');

/* Las colecciones que el renderer puede tocar. Es una lista blanca a
   propósito: sin ella, cualquier bug en el renderer puede crear carpetas
   sueltas en tu directorio de datos. Verba no le da ninguna: las clases y los
   vocabularios pasan por los canales `verba:` de abajo, que validan. */
const COLLECTIONS = [];

function coll(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`colección no permitida: ${name}`);
  return store.collection(name);
}

/** Envuelve un handler para que un throw viaje como error y no como crash. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      // Lo de Verba espera a que las clases y los vocabularios estén leídos.
      if (channel.startsWith('verba:')) await motor.listo;
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      console.error(`[ipc] ${channel}:`, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

function register() {
  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: store.ROOT,
    electron: process.versions.electron,
    dev: process.argv.includes('--dev'),
  }));

  /* ── Verba ───────────────────────────────────────────────────────────────
     Las clases (audio + transcripción), la cola y los vocabularios. */
  handle('verba:lista', () => motor.lista());
  handle('verba:motor', () => motor.estado());
  handle('verba:formatos', () => Object.entries(FORMATOS).map(([id, f]) => ({ id, nombre: f.nombre, ext: f.ext.trim() })));
  // El diálogo de Windows para elegir audios. Devuelve [{ ruta, archivo }].
  handle('verba:elegir', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
      title: 'Agregar audios',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio y video', extensions: motor.AUDIO.map((e) => e.slice(1)) }],
    });
    return r.canceled ? [] : motor.expandir(r.filePaths);
  });
  // Lo que se soltó sobre la ventana: archivos sueltos o carpetas.
  handle('verba:expandir', (rutas) => motor.expandir((Array.isArray(rutas) ? rutas : []).map(String)));
  handle('verba:agregar', (rutas, opciones) => motor.agregar((Array.isArray(rutas) ? rutas : []).map(String), opciones || {}));
  handle('verba:quitar', (id) => motor.quitar(String(id)));
  handle('verba:reintentar', (id, terminos) => motor.reintentar(String(id), terminos));
  handle('verba:editar', (id, cambios) => motor.editar(String(id), cambios || {}));
  handle('verba:abrir', (id) => motor.abrir(String(id)));
  handle('verba:exportar', (id, formato, pisar) => motor.exportar(String(id), String(formato), pisar === true));
  handle('verba:texto', (id) => motor.textoPlano(String(id)));
  handle('verba:vocab', () => motor.vocabularios());
  handle('verba:grupo-guardar', (nombre, datos) => motor.guardarGrupo(nombre, datos || {}));
  handle('verba:grupo-quitar', (nombre) => motor.quitarGrupo(String(nombre)));
  handle('verba:grupo-renombrar', (viejo, nuevo) => motor.renombrarGrupo(String(viejo), nuevo));
  // Mostrar un archivo en el Explorador. Solo si existe: no abre nada.
  handle('verba:mostrar', (ruta) => {
    if (!fs.existsSync(String(ruta))) throw new Error('Ese archivo ya no está.');
    shell.showItemInFolder(path.normalize(String(ruta)));
    return true;
  });
  // Los archivos de datos que se apartaron por ilegibles: la app lo avisa.
  handle('store:asides', () => store.asides().map((a) => ({ file: path.basename(a.file), dead: a.dead })));

  /* El texto del portapapeles, para el "Pegar" del menú de los campos. Desde
     la página, leerlo pide un permiso; acá no. Con tope: un portapapeles
     gigante no tiene por qué cruzar entero. Desde Electron 44 el
     portapapeles del proceso principal es asíncrono, como el de la web. */
  handle('clip:read', async () => (await clipboard.readText()).slice(0, 100000));

  handle('settings:get', () => store.loadSettings());
  handle('settings:save', (patch) => store.saveSettings(patch));

  handle('doc:read', (name, fallback = null) => store.doc(name, fallback).read());
  handle('doc:write', (name, data) => store.doc(name).write(data).then(() => true));

  handle('col:list', (name) => coll(name).list());
  handle('col:get', (name, id) => coll(name).get(id));
  handle('col:save', (name, item) => coll(name).save(item));
  handle('col:remove', (name, id) => coll(name).remove(id).then(() => true));
  handle('col:next-id', (name, prefix) => coll(name).nextId(prefix));
}

module.exports = { register, COLLECTIONS };
