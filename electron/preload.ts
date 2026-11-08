import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/**
 * Puente mínimo y seguro: el renderer no tiene acceso a Node. Solo puede invocar
 * operaciones por nombre; el proceso principal valida cada nombre contra una lista blanca.
 * (Con sandbox activo el preload no puede importar otros módulos locales.)
 */
const api = {
  git: (op: string, ...args: unknown[]) => ipcRenderer.invoke('gitora:git', op, args),
  app: (op: string, ...args: unknown[]) => ipcRenderer.invoke('gitora:app', op, args),
  on: (event: string, cb: (payload: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(`gitora:event:${event}`, listener);
    return () => ipcRenderer.removeListener(`gitora:event:${event}`, listener);
  },
};

contextBridge.exposeInMainWorld('gitora', api);
