import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { EditorHelper } from './git-service';

/**
 * Script que git ejecuta como editor (GIT_SEQUENCE_EDITOR y GIT_EDITOR).
 * - Si recibe el archivo git-rebase-todo y existe GITORA_TODO: lo reemplaza con el todo armado en la UI.
 * - Si recibe un mensaje de commit y hay mensajes en cola (GITORA_MSGS): escribe el siguiente.
 * - En cualquier otro caso no toca nada (equivale a aceptar el mensaje por defecto).
 * Se ejecuta con el propio binario de Electron en modo Node, así funciona igual en Windows y Linux.
 */
const SCRIPT = `
const fs = require('fs');
const target = process.argv[process.argv.length - 1];
try {
  const base = require('path').basename(target);
  if (base === 'git-rebase-todo' && process.env.GITORA_TODO) {
    fs.copyFileSync(process.env.GITORA_TODO, target);
  } else if (process.env.GITORA_MSGS && fs.existsSync(process.env.GITORA_MSGS)) {
    const queue = JSON.parse(fs.readFileSync(process.env.GITORA_MSGS, 'utf8'));
    if (queue.length) {
      fs.writeFileSync(target, queue.shift() + '\\n');
      fs.writeFileSync(process.env.GITORA_MSGS, JSON.stringify(queue));
    }
  }
  process.exit(0);
} catch (e) {
  console.error(e && e.message);
  process.exit(1);
}
`;

export function createEditorHelper(dataDir: string, execPath: string): EditorHelper {
  const dir = path.join(dataDir, 'helpers');
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'gitora-editor.js');
  writeFileSync(script, SCRIPT, 'utf8');

  // git interpreta el editor con sh (incluido en Git for Windows): usamos / y comillas.
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const command = `${q(execPath)} ${q(script)}`;

  return {
    command,
    env: (todo?: string, msgs?: string) => {
      const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
      if (todo) env['GITORA_TODO'] = todo;
      if (msgs) env['GITORA_MSGS'] = msgs;
      return env;
    },
  };
}
