import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell,
} from 'electron';
import type { Language } from '@core/models';
import { APP_OP_NAMES, AppOps, GIT_OP_NAMES, GitOps, MainEvents } from '../shared/api';
import { GitError, GitRunner } from './git/git-runner';
import { GitService } from './git/git-service';
import { appMenuTemplate } from './app-menu';
import { createEditorHelper } from './git/editor-helper';
import { ProviderRegistry } from './providers/provider-registry';
import { RepoWatcher } from './repo-watcher';
import { SettingsStore } from './settings-store';

const isDev = !!process.env['GITORA_DEV'];
let win: BrowserWindow | null = null;

// Una sola instancia: abrir otra ventana enfoca la existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName('Gitora');

const store = new SettingsStore(app.getPath('userData'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
});
const runner = new GitRunner(store.get().gitPath);
const providers = new ProviderRegistry(store);

function send<K extends keyof MainEvents>(event: K, payload: MainEvents[K]) {
  win?.webContents.send(`gitora:event:${event}`, payload);
}

runner.onLog((entry) => send('command-log', entry));
runner.onProgress((evt) => send('progress', evt));
const watcher = new RepoWatcher((repo, gitOnly) => send('repo-changed', { repo, gitOnly }));

let git: GitService;

/* ───────────── operaciones de la app ───────────── */

const appOps: AppOps = {
  async getSettings() {
    return store.get();
  },
  async updateSettings(patch) {
    const s = store.update(patch);
    if (patch.gitPath !== undefined) runner.setGitPath(s.gitPath);
    if (patch.watchWorkingTree !== undefined) watcher.setWorkingTree(s.watchWorkingTree);
    if (patch.theme) nativeTheme.themeSource = s.theme;
    if (patch.language) applyMenu(s.language);
    return s;
  },
  async gitVersion() {
    try {
      return (await runner.run(['--version'], { cwd: app.getPath('home'), silent: true })).trim();
    } catch {
      return null;
    }
  },
  async pickDirectory(title) {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  async pickFiles(title) {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  async pickSavePath(title, defaultName) {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath: defaultName });
    return r.canceled ? null : r.filePath ?? null;
  },
  async showInFolder(p) {
    shell.showItemInFolder(p);
  },
  async openExternal(url) {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  },
  async openTerminal(dir) {
    openTerminal(dir, store.get().terminal);
  },
  async openInEditor(p) {
    await shell.openPath(p);
  },
  async watchRepo(repo) {
    const info = await git.open(repo);
    watcher.watch(info.path, info.gitDir, store.get().watchWorkingTree);
    store.addRecent(info.path);
  },
  async unwatchRepo(repo) {
    watcher.unwatch(repo);
  },
  async setTitleBarTheme(dark) {
    if (process.platform !== 'darwin' && win) {
      try {
        win.setTitleBarOverlay({
          color: dark ? '#16181d' : '#f3f4f6',
          symbolColor: dark ? '#c9ced8' : '#374151',
          height: 40,
        });
      } catch { /* algunos gestores de ventanas de Linux no lo soportan */ }
    }
  },
  async setRepoActive(active) {
    if (active === repoActive) return;
    repoActive = active;
    applyMenu(store.get().language);
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

/** Abre la terminal preferida (o una razonable para cada sistema) en la carpeta del repo. */
function openTerminal(dir: string, preferred: string) {
  const detached = { cwd: dir, detached: true, stdio: 'ignore' as const };
  if (preferred) {
    spawn(preferred, [], { ...detached, shell: true }).unref();
    return;
  }
  if (process.platform === 'win32') {
    const wt = path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WindowsApps', 'wt.exe');
    if (existsSync(wt)) spawn(wt, ['-d', dir], detached).unref();
    else spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], detached).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dir], detached).unref();
    return;
  }
  // Linux: probamos las terminales más comunes en Arch y derivados.
  const candidates = [
    process.env['TERMINAL'], 'kitty', 'alacritty', 'wezterm', 'foot', 'konsole',
    'gnome-terminal', 'xfce4-terminal', 'tilix', 'xterm',
  ].filter(Boolean) as string[];
  const tryNext = (i: number) => {
    if (i >= candidates.length) return;
    const child = spawn(candidates[i], [], detached);
    child.on('error', () => tryNext(i + 1));
    child.unref();
  };
  tryNext(0);
}

/* ───────────── IPC ───────────── */

function serializeError(e: unknown): Error {
  if (e instanceof GitError) {
    const err = new Error(e.message);
    (err as Error & { stderr?: string }).stderr = e.stderr;
    return err;
  }
  return e instanceof Error ? e : new Error(String(e));
}

function registerIpc() {
  const gitOps = new Set<string>(GIT_OP_NAMES);
  const appOpsAllowed = new Set<string>(APP_OP_NAMES);

  ipcMain.handle('gitora:git', async (event, op: string, args: unknown[]) => {
    if (event.sender !== win?.webContents) throw new Error('Origen no permitido');
    if (!gitOps.has(op)) throw new Error(`Operación git no permitida: ${op}`);
    try {
      const fn = (git as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
      return await fn.apply(git, args);
    } catch (e) {
      throw serializeError(e);
    }
  });

  ipcMain.handle('gitora:app', async (event, op: string, args: unknown[]) => {
    if (event.sender !== win?.webContents) throw new Error('Origen no permitido');
    if (!appOpsAllowed.has(op)) throw new Error(`Operación no permitida: ${op}`);
    try {
      const fn = (appOps as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
      return await fn.apply(appOps, args);
    } catch (e) {
      throw serializeError(e);
    }
  });
}

/** Menú de la aplicación en el idioma elegido; se reconstruye al cambiar de idioma. */
let repoActive = false;

function applyMenu(lang: Language) {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(lang, {
        isDev,
        isMac: process.platform === 'darwin',
        appName: app.name,
        repoActive,
        onCommand: (id) => send('menu-command', { id }),
      }),
    ),
  );
}

/* ───────────── ventana ───────────── */

/** Icono de la app: la copia que Angular deja en dist/renderer, o public/ al correr desde el código. */
function iconPath(): string {
  const built = path.join(__dirname, '..', 'renderer', 'icon.png');
  return existsSync(built) ? built : path.join(__dirname, '..', '..', 'public', 'icon.png');
}

function createWindow() {
  const settings = store.get();
  nativeTheme.themeSource = settings.theme;
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors);

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: 'Gitora',
    backgroundColor: dark ? '#16181d' : '#ffffff',
    show: false,
    icon: iconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : {
      color: dark ? '#16181d' : '#f3f4f6',
      symbolColor: dark ? '#c9ced8' : '#374151',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  applyMenu(settings.language);
  // Siempre se abre maximizada; width/height quedan como tamaño al restaurar.
  win.once('ready-to-show', () => {
    win?.maximize();
    win?.show();
  });
  win.on('focus', () => send('window-focus', { focused: true }));
  win.on('blur', () => send('window-focus', { focused: false }));

  // Enlaces externos al navegador; nunca navegar fuera de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost:4300')) e.preventDefault();
  });

  if (isDev) {
    win.loadURL('http://localhost:4300');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  const editor = createEditorHelper(app.getPath('userData'), process.execPath);
  git = new GitService(runner, (url) => providers.authConfigFor(url), editor, path.join(app.getPath('temp'), 'gitora'));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  watcher.dispose();
  app.quit();
});

// Tipos consumidos solo para comprobar que el contrato se cumple en compilación.
export type _Check = [GitOps, AppOps];
