/**
 * Servidor SOLO PARA DESARROLLO: expone por HTTP las mismas operaciones que el proceso
 * principal de Electron, para poder usar la interfaz en un navegador con git real.
 *
 *   npm run start:web  →  ng serve (4300, con proxy /api) + este servidor (4301)
 *
 * Seguridad: escucha únicamente en 127.0.0.1 y rechaza cualquier petición cuyo Host u
 * Origin no sea el del servidor de desarrollo de Angular. Así otra página web abierta en el
 * navegador no puede ejecutar git sobre tus repositorios (CSRF / DNS rebinding).
 * No se empaqueta con la app (ver electron-builder.yml).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { APP_OP_NAMES, AppOps, GIT_OP_NAMES, GitOps, MainEvents } from '../shared/api';
import { createEditorHelper } from './git/editor-helper';
import { GitError, GitRunner } from './git/git-runner';
import { GitService } from './git/git-service';
import { ProviderRegistry } from './providers/provider-registry';
import { RepoWatcher } from './repo-watcher';
import { SettingsStore } from './settings-store';

const PORT = Number(process.env['GITORA_DEV_PORT'] ?? 4301);
const WEB_PORT = Number(process.env['GITORA_DEV_WEB_PORT'] ?? 4300);
const MAX_BODY = 8 * 1024 * 1024;

const ALLOWED_HOSTS = new Set(
  [PORT, WEB_PORT].flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`]),
);
const ALLOWED_ORIGINS = new Set([`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`]);

const dataDir = process.env['GITORA_DEV_DATA'] ?? path.join(os.homedir(), '.config', 'gitora-dev');

// Sin safeStorage (solo existe en Electron) los tokens de cuentas no se guardan en modo web.
const store = new SettingsStore(dataDir, {
  available: () => false,
  encrypt: () => {
    throw new Error('El almacén de credenciales no está disponible en modo web');
  },
  decrypt: () => {
    throw new Error('El almacén de credenciales no está disponible en modo web');
  },
});
const runner = new GitRunner(store.get().gitPath);
const providers = new ProviderRegistry(store);
const clients = new Set<http.ServerResponse>();

function emit<K extends keyof MainEvents>(event: K, payload: MainEvents[K]) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(frame);
}

runner.onLog((entry) => emit('command-log', entry));
runner.onProgress((evt) => emit('progress', evt));
const watcher = new RepoWatcher((repo, gitOnly) => emit('repo-changed', { repo, gitOnly }));

const editor = createEditorHelper(dataDir, process.execPath);
const git = new GitService(
  runner,
  (url) => providers.authConfigFor(url),
  editor,
  path.join(os.tmpdir(), 'gitora-dev'),
);

function unavailable(what: string): never {
  throw new Error(`${what} no está disponible en modo web`);
}

function openPath(target: string) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

const appOps: AppOps = {
  async getSettings() {
    return store.get();
  },
  async updateSettings(patch) {
    const s = store.update(patch);
    if (patch.gitPath !== undefined) runner.setGitPath(s.gitPath);
    return s;
  },
  async gitVersion() {
    try {
      return (await runner.run(['--version'], { cwd: os.homedir(), silent: true })).trim();
    } catch {
      return null;
    }
  },
  // Los diálogos nativos los resuelve el cliente web con prompt().
  pickDirectory: () => unavailable('El selector de carpetas'),
  pickFiles: () => unavailable('El selector de archivos'),
  pickSavePath: () => unavailable('El selector de ruta'),
  async showInFolder(p) {
    openPath(path.dirname(p));
  },
  async openExternal() {
    // Lo abre el cliente con window.open.
  },
  async openTerminal() {
    unavailable('La terminal externa');
  },
  async openInEditor(p) {
    openPath(p);
  },
  async watchRepo(repo) {
    const info = await git.open(repo);
    watcher.watch(info.path, info.gitDir, store.get().watchWorkingTree);
    store.addRecent(info.path);
  },
  async unwatchRepo(repo) {
    watcher.unwatch(repo);
  },
  async setTitleBarTheme() {
    // Sin barra de título nativa en el navegador.
  },
  async setRepoActive() {
    // Sin menú nativo en el navegador.
  },
  async platform() {
    return process.platform;
  },
  async commandHistory() {
    return runner.getHistory();
  },
  async addAccount(input) {
    return providers.addAccount(input);
  },
  async removeAccount(id) {
    providers.removeAccount(id);
  },
  async checkAccount(id) {
    return providers.checkAccount(id);
  },
  async oauthStart(input) {
    return providers.oauthStart(input);
  },
  async oauthComplete(sessionId) {
    return providers.oauthComplete(sessionId);
  },
  async oauthCancel(sessionId) {
    providers.oauthCancel(sessionId);
  },
  async listRemoteRepos(accountId, query) {
    return providers.listRepositories(accountId, query);
  },
  async locateRemote(url) {
    return providers.locate(url);
  },
  async pullRequests(repo, remoteName) {
    const remote = (await git.remotes(repo)).find((r) => r.name === remoteName);
    if (!remote) throw new Error(`Remoto no encontrado: ${remoteName}`);
    return providers.pullRequests(remote.fetchUrl);
  },
  async createPullRequest(repo, remoteName, pr) {
    const remote = (await git.remotes(repo)).find((r) => r.name === remoteName);
    if (!remote) throw new Error(`Remoto no encontrado: ${remoteName}`);
    return providers.createPullRequest(remote.fetchUrl, pr);
  },
};

const gitOps = new Set<string>(GIT_OP_NAMES);
const appOpsAllowed = new Set<string>(APP_OP_NAMES);
type Fn = (...a: unknown[]) => Promise<unknown>;

/** Explorador de disco para el selector del navegador: carpetas y, si se pide, archivos. */
async function listDirectory(requested: unknown, includeFiles: unknown) {
  const dir = path.resolve(typeof requested === 'string' && requested ? requested : os.homedir());
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const items: { name: string; kind: 'dir' | 'file'; isRepo: boolean }[] = [];
  const exists = (p: string) =>
    fs.stat(p).then(
      () => true,
      () => false,
    );
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      const st = await fs.stat(path.join(dir, e.name)).catch(() => null);
      isDir = !!st?.isDirectory();
      isFile = !!st?.isFile();
    }
    if (isDir)
      items.push({
        name: e.name,
        kind: 'dir',
        isRepo: await exists(path.join(dir, e.name, '.git')),
      });
    else if (isFile && includeFiles === true)
      items.push({ name: e.name, kind: 'file', isRepo: false });
  }
  items.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  );
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    isRepo: await exists(path.join(dir, '.git')),
    entries: items.slice(0, 2000),
  };
}

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          args?: unknown;
        };
        resolve(Array.isArray(parsed.args) ? parsed.args : []);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function allowed(req: http.IncomingMessage): boolean {
  if (!req.headers.host || !ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  // Las peticiones del proxy de ng serve llevan el origen de Angular; sin Origin
  // (p. ej. curl local) solo se acepta en GET, nunca para ejecutar operaciones.
  if (origin) return ALLOWED_ORIGINS.has(origin);
  return req.method === 'GET';
}

const server = http.createServer(async (req, res) => {
  if (!allowed(req)) return reply(res, 403, { message: 'Origen no permitido' });
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': conectado\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/fs/list') {
    try {
      const [dir, includeFiles] = await readBody(req);
      return reply(res, 200, { result: await listDirectory(dir, includeFiles) });
    } catch (e) {
      return reply(res, 400, { message: e instanceof Error ? e.message : String(e) });
    }
  }

  const m = /^\/api\/(git|app)\/([A-Za-z]+)$/.exec(url.pathname);
  if (req.method !== 'POST' || !m) return reply(res, 404, { message: 'No encontrado' });
  const [, kind, op] = m;
  const names = kind === 'git' ? gitOps : appOpsAllowed;
  if (!names.has(op)) return reply(res, 400, { message: `Operación no permitida: ${op}` });

  try {
    const args = await readBody(req);
    const target = (kind === 'git' ? git : appOps) as unknown as Record<string, Fn>;
    const result = await target[op].apply(target, args);
    reply(res, 200, { result: result ?? null });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    reply(res, 400, { message: err.message, stderr: e instanceof GitError ? e.stderr : undefined });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Gitora dev server en http://127.0.0.1:${PORT} (datos en ${dataDir})`);
});

process.on('SIGINT', () => {
  watcher.dispose();
  process.exit(0);
});

// Comprueba en compilación que se cumple el contrato compartido.
export type _Check = [GitOps, AppOps];
