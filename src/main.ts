import { isDevMode } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';
import type { PathPickResult } from './app/core/dev/path-picker/path-picker';

async function start() {
  // En desarrollo y fuera de Electron, usa el puente HTTP hacia git real (npm run start:web).
  const useHttpBridge = isDevMode() && !window.gitora;
  if (useHttpBridge) {
    (await import('./app/core/dev/http-bridge')).installHttpBridge();
  }
  const app = await bootstrapApplication(App, appConfig);
  if (useHttpBridge) {
    // El navegador no tiene el diálogo nativo de carpetas: se usa un modal propio.
    const [{ setPathPicker }, { PathPicker }, { DialogService }] = await Promise.all([
      import('./app/core/dev/http-bridge'),
      import('./app/core/dev/path-picker/path-picker'),
      import('@core/services'),
    ]);
    const dialogs = app.injector.get(DialogService);
    setPathPicker(
      async (req) => (await dialogs.open<PathPickResult>(PathPicker, req, 560)) ?? null,
    );
  }
}

start().catch((err) => console.error(err));
