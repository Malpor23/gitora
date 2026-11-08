import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _electron, ElectronApplication, Locator, Page } from 'playwright-core';

/** Raíz del proyecto (desde dist/e2e/ hasta la carpeta del repo). */
export const ROOT = path.resolve(__dirname, '..', '..');

/** Ejecuta git y devuelve la salida sin espacios finales. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface Fixture {
  base: string;
  repo: string;
  bare: string;
  data: string;
  g: (...args: string[]) => string;
  /** Hace un commit desde otro clon y lo sube al remoto, simulando a otra persona. */
  remoteCommit: (file: string, message: string) => string;
  cleanup: () => void;
}

/** Repo desechable con remoto local, rama `feature/login`, cambios sin commit y un upstream. */
export function makeFixture(): Fixture {
  const base = mkdtempSync(path.join(os.tmpdir(), 'gitora-e2e-'));
  const repo = path.join(base, 'work');
  const bare = path.join(base, 'remote.git');
  const data = path.join(base, 'userdata');
  const g = (...args: string[]) => git(repo, ...args);
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(base, 'init', '-q', '-b', 'main', repo);
  g('config', 'user.name', 'Ana Torres');
  g('config', 'user.email', 'ana@example.com');
  g('remote', 'add', 'origin', bare);
  writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'chore: init');
  g('push', '-q', '-u', 'origin', 'main');
  g('checkout', '-qb', 'feature/login');
  writeFileSync(path.join(repo, 'src', 'login.ts'), 'export const l = 1;\n');
  g('add', '-A');
  g('commit', '-qm', 'feat: login');
  g('checkout', '-q', 'main');
  appendFileSync(path.join(repo, 'README.md'), 'second\n');
  g('add', '-A');
  g('commit', '-qm', 'docs: second');
  g('push', '-q', 'origin', 'main');
  appendFileSync(path.join(repo, 'README.md'), 'wip\n');
  writeFileSync(path.join(repo, 'src', 'new.ts'), 'x\n');

  const remoteCommit = (file: string, message: string): string => {
    const clone = path.join(base, 'other');
    rmSync(clone, { recursive: true, force: true });
    git(base, 'clone', '-q', bare, clone);
    git(clone, 'config', 'user.name', 'Bob');
    git(clone, 'config', 'user.email', 'bob@example.com');
    writeFileSync(path.join(clone, file), `${message}\n`);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', message);
    git(clone, 'push', '-q', 'origin', 'main');
    return git(clone, 'rev-parse', 'HEAD');
  };
  return { base, repo, bare, data, g, remoteCommit, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export interface RemoteFixture {
  base: string;
  repo: string;
  data: string;
  /** Rama de prueba, siempre con prefijo `gitora-e2e/`: es la única que las pruebas empujan o borran. */
  branch: string;
  /** Commit desde el que nace la rama de prueba; cadena vacía si el remoto está vacío (rama sin commits). */
  startPoint: string;
  g: (...args: string[]) => string;
  /** Commit desde otro clon, empujado solo a la rama de prueba. */
  remoteCommit: (file: string, message: string) => string;
  /** Hash de la rama de prueba en el remoto (cadena vacía si no existe). */
  remoteHead: () => string;
  /** Nombres de tags creados por la prueba (siempre `gitora-e2e-*`); se borran del remoto al terminar. */
  tags: string[];
  /** ¿Existe el tag en el remoto? */
  remoteHasTag: (name: string) => boolean;
  /** Borra la rama de prueba del remoto y la carpeta temporal. */
  cleanup: () => void;
}

/** Reintenta una consulta de red (SSH puede cerrar la conexión de forma transitoria). */
function retry<T>(fn: () => T, attempts = 4): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= attempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * i);
    }
  }
}

export const TEST_BRANCH_PREFIX = 'gitora-e2e/';
export const TEST_TAG_PREFIX = 'gitora-e2e-';

/** Clona un remoto real (por su URL) y deja una rama local de prueba nueva, sin tocar ninguna otra rama remota. */
export function makeRemoteFixture(url: string): RemoteFixture {
  const base = mkdtempSync(path.join(os.tmpdir(), 'gitora-e2e-remote-'));
  const repo = path.join(base, 'work');
  const data = path.join(base, 'userdata');
  const branch = `${TEST_BRANCH_PREFIX}${Date.now()}`;
  git(base, 'clone', '-q', url, repo);
  const g = (...args: string[]) => git(repo, ...args);
  g('config', 'user.name', 'Gitora E2E');
  g('config', 'user.email', 'gitora-e2e@example.com');
  let startPoint = '';
  try {
    startPoint = g('rev-parse', 'HEAD');
  } catch {
    /* repositorio vacío: la rama de prueba nace sin commits */
  }
  g('checkout', '-q', '-b', branch);
  const remoteHead = (): string => {
    const out = retry(() => g('ls-remote', 'origin', `refs/heads/${branch}`));
    return out.split('\t')[0] ?? '';
  };
  const remoteCommit = (file: string, message: string): string => {
    if (!branch.startsWith(TEST_BRANCH_PREFIX)) throw new Error('rama fuera del prefijo de prueba');
    const clone = path.join(base, 'other');
    rmSync(clone, { recursive: true, force: true });
    git(base, 'clone', '-q', '--branch', branch, url, clone);
    git(clone, 'config', 'user.name', 'Bob E2E');
    git(clone, 'config', 'user.email', 'bob-e2e@example.com');
    writeFileSync(path.join(clone, file), `${message}\n`);
    git(clone, 'add', '-A');
    git(clone, 'commit', '-qm', message);
    git(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    return git(clone, 'rev-parse', 'HEAD');
  };
  const tags: string[] = [];
  const remoteHasTag = (name: string): boolean => retry(() => g('ls-remote', '--tags', 'origin', `refs/tags/${name}`)) !== '';
  const cleanup = () => {
    try {
      if (branch.startsWith(TEST_BRANCH_PREFIX) && remoteHead()) g('push', 'origin', '--delete', branch);
      for (const t of tags) if (t.startsWith(TEST_TAG_PREFIX) && remoteHasTag(t)) g('push', 'origin', '--delete', `refs/tags/${t}`);
    } catch {
      /* si el remoto no responde, la rama de prueba queda y se avisa en la salida */
      console.warn(`No se pudo limpiar el remoto (rama ${branch}, tags ${tags.join(', ')}). Si el remoto estaba vacío, GitHub convierte la primera rama empujada en la rama por defecto y no permite borrarla: bórrala a mano o cambia la rama por defecto.`);
    }
    rmSync(base, { recursive: true, force: true });
  };
  return { base, repo, data, branch, startPoint, g, remoteCommit, remoteHead, tags, remoteHasTag, cleanup };
}

export type MenuName = 'fetch' | 'pull' | 'push' | 'branch' | 'rebase' | 'stash' | 'repository';
const CHEVRON_INDEX: Record<Exclude<MenuName, 'repository'>, number> = {
  fetch: 0,
  pull: 1,
  push: 2,
  branch: 3,
  rebase: 4,
  stash: 5,
};

export class App {
  private constructor(
    readonly electron: ElectronApplication,
    readonly page: Page,
    readonly pageErrors: string[],
  ) {}

  /** Abre Gitora con un perfil de datos aparte y el repositorio indicado en una pestaña. */
  static async launch(fx: Pick<Fixture, 'repo' | 'data'>): Promise<App> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require('electron') as unknown as string;
    const electron = await _electron.launch({
      executablePath: electronPath,
      args: ['.', '--no-sandbox', `--user-data-dir=${fx.data}`],
      cwd: ROOT,
    });
    const page = await electron.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    // El diálogo nativo de carpeta se sustituye por una respuesta fija
    await electron.evaluate(({ dialog }, repo) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] });
    }, fx.repo);
    await page.getByRole('button', { name: /Abrir repositorio local|Open local repository/ }).waitFor();
    await page.keyboard.press('Control+o');
    await page.getByRole('tab').first().waitFor({ timeout: 15000 });
    return new App(electron, page, pageErrors);
  }

  get dialog(): Locator {
    return this.page.locator('[role=dialog]');
  }

  get chevrons(): Locator {
    return this.page.getByRole('button', { name: /Más opciones|More options/ });
  }

  async openMenu(name: MenuName): Promise<void> {
    if (name === 'repository') await this.page.getByRole('button', { name: /Repositorio|Repository/ }).first().click();
    else await this.chevrons.nth(CHEVRON_INDEX[name]).click();
    await this.page.locator('[role=menu]').waitFor();
  }

  async menuItems(name: MenuName): Promise<string[]> {
    await this.openMenu(name);
    const items = await this.page.locator('[role=menuitem]').allInnerTexts();
    await this.page.keyboard.press('Escape');
    return items.map((s) => s.split('\n')[0].trim());
  }

  /** Abre un dropdown y hace clic en el ítem cuyo texto cumple `label`. */
  async pick(name: MenuName, label: RegExp): Promise<void> {
    await this.openMenu(name);
    await this.page.locator('[role=menuitem]').filter({ hasText: label }).first().click();
    await this.page.waitForTimeout(600);
  }

  async fill(id: string, value: string): Promise<void> {
    await this.page.locator(`#${id}`).fill(value);
  }

  /** Pulsa el botón principal (o de peligro) del diálogo, y de los de confirmación que sigan. */
  async confirm(): Promise<void> {
    for (let i = 0; i < 3 && (await this.dialog.count()); i++) {
      const button = this.dialog.locator('.btn.primary, .btn.danger').last();
      // Un botón ocupado (operación de red en curso) se espera, no se vuelve a pulsar
      if (await button.isDisabled()) {
        await this.dialog.last().waitFor({ state: 'detached', timeout: 90000 }).catch(() => undefined);
        break;
      }
      await button.click();
      await this.page.waitForTimeout(1000);
    }
    await this.page.waitForTimeout(400);
  }

  /** Cierra menús y diálogos que hayan quedado abiertos. */
  async closeAll(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      if ((await this.dialog.count()) || (await this.page.locator('[role=menu]').count())) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(200);
      }
    }
  }

  async close(): Promise<void> {
    await this.electron.close();
  }
}
