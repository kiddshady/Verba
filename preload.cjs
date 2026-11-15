'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   OPAL — preload
   La única puerta entre el renderer y el sistema. Todo lo que NO esté acá, el
   renderer no lo puede hacer: no tiene require, ni fs, ni acceso al proceso
   principal. Esa es la idea.

   Regla: exponé funciones, nunca objetos de Electron. `ipcRenderer` en el
   window anula por completo el aislamiento de contexto.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};

contextBridge.exposeInMainWorld('opal', {
  info: () => call('app:info'),
  /** Los archivos de datos ilegibles que se apartaron en esta corrida. */
  asides: () => call('store:asides'),

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    /** El renderer le pasa a la ventana su color base ya resuelto (ver app.js). */
    setBackground: (hex) => ipcRenderer.send('win:set-bg', hex),
    /** El vidrio «acrilico»: la ventana deja ver el escritorio (main.cjs). */
    setAcrilico: (on) => ipcRenderer.send('win:set-acrilico', !!on),
    onMaximized: (cb) => {
      const handler = (_e, value) => cb(value);
      ipcRenderer.on('win:maximized', handler);
      return () => ipcRenderer.off('win:maximized', handler);
    },
  },

  /** Leer el portapapeles (el "Pegar" del menú de los campos). Escribir no
      pasa por acá: navigator.clipboard.writeText no pide permiso. */
  clip: {
    read: () => call('clip:read'),
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
  },

  /** Verba: las clases, la cola, el motor y los vocabularios (src/motor.cjs). */
  verba: {
    lista: () => call('verba:lista'),
    motor: () => call('verba:motor'),
    formatos: () => call('verba:formatos'),
    elegir: () => call('verba:elegir'),
    expandir: (rutas) => call('verba:expandir', rutas),
    agregar: (rutas, opciones) => call('verba:agregar', rutas, opciones),
    quitar: (id) => call('verba:quitar', id),
    reintentar: (id, terminos) => call('verba:reintentar', id, terminos),
    editar: (id, cambios) => call('verba:editar', id, cambios),
    abrir: (id) => call('verba:abrir', id),
    exportar: (id, formato, pisar) => call('verba:exportar', id, formato, pisar),
    texto: (id) => call('verba:texto', id),
    vocab: () => call('verba:vocab'),
    guardarGrupo: (nombre, datos) => call('verba:grupo-guardar', nombre, datos),
    quitarGrupo: (nombre) => call('verba:grupo-quitar', nombre),
    renombrarGrupo: (viejo, nuevo) => call('verba:grupo-renombrar', viejo, nuevo),
    mostrar: (ruta) => call('verba:mostrar', ruta),
    /** La ruta en disco de un archivo soltado sobre la ventana. */
    rutaDe: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
    /** Lo que cuenta la cola: { tipo: 'clase'|'quitada'|'progreso'|'motor', … }. */
    onEvento: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('verba:ev', handler);
      return () => ipcRenderer.off('verba:ev', handler);
    },
  },

  /** Documento suelto: un borrador, un caché, el último estado de la UI. */
  doc: {
    read: (name, fallback = null) => call('doc:read', name, fallback),
    write: (name, data) => call('doc:write', name, data),
  },

  /** Colección: una carpeta con un archivo por ítem. */
  col: (name) => ({
    list: () => call('col:list', name),
    get: (id) => call('col:get', name, id),
    save: (item) => call('col:save', name, item),
    remove: (id) => call('col:remove', name, id),
    nextId: (prefix) => call('col:next-id', name, prefix),
  }),
});
