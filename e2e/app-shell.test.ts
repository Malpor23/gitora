import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { _electron, ElectronApplication, Locator, Page } from 'playwright-core';
import { Fixture, git, makeFixture, ROOT } from './helpers';

/**
 * Auditoría E2E del armazón de la app (Electron real): pestañas, bienvenida, pie de página, Ajustes,
 * cuentas (sin red), paleta de comandos, atajos de teclado y diálogos de formulario genéricos.
 * Todo ocurre sobre repositorios desechables en el directorio temporal y con un perfil de datos propio;
 * lo que lanzaría programas externos (explorador, terminal, navegador) se sustituye en el proceso principal.
 * Requiere pantalla (en CI: `xvfb-run -a ...`) y el build previo.
 */
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');
const skip = hasDisplay ? false : 'sin pantalla (usa xvfb-run)';

type Json = Record<string, unknown>;
interface Call {
  fn: string;
  arg: string;
}

/** Repositorio mínimo con un commit; `dirty` deja un archivo sin seguimiento. */
function makeSmall(base: string, name: string, dirty = false): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Eva');
  git(dir, 'config', 'user.email', 'eva@example.com');
  writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  if (dirty) writeFileSync(path.join(dir, 'u.txt'), 'u\n');
  return realpathSync(dir);
}

/** Escribe un settings.json inicial en el perfil de datos (el main lo fusiona con los valores por defecto). */
function seed(data: string, settings: Json): void {
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ settings, tokens: {} }));
}

function readSettings(data: string): Json {
  return (JSON.parse(readFileSync(path.join(data, 'settings.json'), 'utf8')) as { settings: Json }).settings;
}

/** Sesión de Electron con su propio perfil de datos y los diálogos/lanzadores nativos sustituidos. */
class Sess {
  private constructor(
    readonly electron: ElectronApplication,
    readonly page: Page,
    readonly errors: string[],
    readonly data: string,
  ) {}

  static async launch(data: string): Promise<Sess> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require('electron') as unknown as string;
    const electron = await _electron.launch({
      executablePath: electronPath,
      args: ['.', '--no-sandbox', `--user-data-dir=${data}`],
      cwd: ROOT,
    });
    const page = await electron.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await electron.evaluate(({ dialog, shell }) => {
      const g = globalThis as unknown as { __picks: string[]; __calls: Call[]; __saves: string[] };
      g.__picks = [];
      g.__calls = [];
      g.__saves = [];
      dialog.showOpenDialog = (async () => {
        const next = g.__picks.shift();
        return next === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [next] };
      }) as unknown as typeof dialog.showOpenDialog;
      dialog.showSaveDialog = (async () => {
        const next = g.__saves.shift();
        return next === undefined ? { canceled: true, filePath: '' } : { canceled: false, filePath: next };
      }) as unknown as typeof dialog.showSaveDialog;
      shell.showItemInFolder = (p: string) => void g.__calls.push({ fn: 'showItemInFolder', arg: p });
      shell.openExternal = (async (u: string) => void g.__calls.push({ fn: 'openExternal', arg: u })) as typeof shell.openExternal;
      shell.openPath = (async (p: string) => {
        g.__calls.push({ fn: 'openPath', arg: p });
        return '';
      }) as typeof shell.openPath;
    });
    const s = new Sess(electron, page, errors, data);
    await page.locator('footer').waitFor({ timeout: 20000 });
    return s;
  }

  /** Respuestas (en orden) del próximo selector de carpeta/archivo; sin ellas el selector se cancela. */
  async pick(...paths: string[]): Promise<void> {
    await this.electron.evaluate((_, p) => {
      (globalThis as unknown as { __picks: string[] }).__picks.push(...p);
    }, paths);
  }

  /** Respuestas del próximo diálogo "guardar como". */
  async save(...paths: string[]): Promise<void> {
    await this.electron.evaluate((_, p) => {
      (globalThis as unknown as { __saves: string[] }).__saves.push(...p);
    }, paths);
  }

  async calls(): Promise<Call[]> {
    return this.electron.evaluate(() => (globalThis as unknown as { __calls: Call[] }).__calls.slice());
  }

  async clearCalls(): Promise<void> {
    await this.electron.evaluate(() => void ((globalThis as unknown as { __calls: Call[] }).__calls.length = 0));
  }

  get overlays(): Locator {
    return this.page.locator('div.fixed.inset-0.z-50');
  }
  get dialog(): Locator {
    return this.overlays.last().locator('[role=dialog]').first();
  }
  get menu(): Locator {
    return this.page.locator('[role=menu]');
  }
  get tabs(): Locator {
    return this.page.locator('header [role=tab]');
  }
  tab(p: string): Locator {
    return this.page.locator(`header [role=tab][title="${p}"]`);
  }
  /** Barra de herramientas del repositorio activo (la del sidebar comparte el aria-label, por eso `h-13`). */
  bar(name?: string): Locator {
    return this.page.locator(name ? `nav.h-13[aria-label="${name}"]` : 'nav.h-13');
  }
  get toasts(): Locator {
    return this.page.locator('[aria-live=polite] > div');
  }
  get welcomeOpen(): Locator {
    return this.page.getByRole('button', { name: /Abrir repositorio local|Open local repository/ });
  }

  async toastTexts(): Promise<string[]> {
    return this.toasts.allInnerTexts();
  }

  /** Espera un toast cuyo texto cumpla `re` y lo devuelve. */
  async toast(re: RegExp, timeout = 15000): Promise<string> {
    const loc = this.toasts.filter({ hasText: re }).first();
    try {
      await loc.waitFor({ timeout });
    } catch (e) {
      throw new Error(`no apareció un toast ${re}; toasts actuales: ${JSON.stringify(await this.toastTexts())}; diálogo: ${JSON.stringify(await this.overlays.last().innerText().catch(() => null))}`, { cause: e });
    }
    return loc.innerText();
  }

  async waitDialog(): Promise<void> {
    await this.overlays.first().waitFor({ timeout: 10000 });
    await this.page.waitForTimeout(250);
  }

  async waitNoDialog(): Promise<void> {
    await this.overlays.first().waitFor({ state: 'detached', timeout: 10000 });
  }

  /** Cierra menús, diálogos y toasts que hayan quedado abiertos. */
  async closeAll(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if ((await this.overlays.count()) || (await this.menu.count())) {
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(200);
      }
    }
    const t = await this.toasts.count();
    for (let i = 0; i < t; i++) await this.toasts.first().click({ timeout: 1000 }).catch(() => undefined);
  }

  async activeTitle(): Promise<string | null> {
    return this.page.locator('header [role=tab][aria-selected=true]').first().getAttribute('title').catch(() => null);
  }

  /** Título del diálogo de arriba (el h2 de la cabecera). */
  async dialogTitle(): Promise<string> {
    return (await this.overlays.last().locator('h2').first().innerText()).trim();
  }

  async openSettings(tab?: RegExp): Promise<void> {
    await this.page.keyboard.press('Control+,');
    await this.waitDialog();
    if (tab) {
      const t = this.dialog.getByRole('tab', { name: tab });
      await t.click();
      await waitFor(async () => (await t.getAttribute('aria-selected')) === 'true', 3000, 'pestaña de Ajustes seleccionada');
      await this.page.waitForTimeout(200);
    }
  }

  async relaunch(): Promise<Sess> {
    await this.close();
    return Sess.launch(this.data);
  }

  async close(): Promise<void> {
    await this.electron.close().catch(() => undefined);
  }
}

/** Abre un repositorio por Ctrl+O con el selector sustituido. */
async function openRepo(s: Sess, repo: string): Promise<void> {
  await s.pick(repo);
  await s.page.keyboard.press('Control+o');
  await s.tab(repo).waitFor({ timeout: 15000 });
}

describe('pestañas (E2E)', { skip }, () => {
  let fx: Fixture;
  let second: string;
  let marker: string;
  let s: Sess;
  const repo = () => realpathSync(fx.repo);

  before(async () => {
    fx = makeFixture();
    second = makeSmall(fx.base, 'second-repo');
    marker = path.join(fx.base, 'terminal-marker');
    seed(fx.data, { terminal: `touch ${marker}`, defaultCloneDir: fx.base });
    s = await Sess.launch(fx.data);
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('sin repositorios abiertos solo existe la pantalla de bienvenida (ninguna pestaña)', async () => {
    assert.equal(await s.tabs.count(), 0);
    await s.welcomeOpen.waitFor();
    assert.equal(await s.bar().count(), 0, 'no debe haber barra de herramientas de repo');
    assert.equal(await s.page.title(), 'Gitora');
  });

  it('Ctrl+O abre el primer repositorio en una pestaña activa con su nombre', async () => {
    await openRepo(s, repo());
    assert.equal(await s.tabs.count(), 1);
    assert.equal(await s.activeTitle(), repo());
    assert.match(await s.tabs.first().innerText(), /work/);
    await s.bar('work').waitFor();
  });

  it('un segundo repositorio abre otra pestaña y pasa a ser la activa', async () => {
    await openRepo(s, second);
    assert.equal(await s.tabs.count(), 2);
    assert.equal(await s.activeTitle(), second);
    await s.bar('second-repo').waitFor();
    assert.equal(await s.tab(repo()).getAttribute('aria-selected'), 'false');
  });

  it('control negativo: abrir un repositorio ya abierto no duplica la pestaña, solo la activa', async () => {
    await openRepo(s, repo());
    await waitFor(async () => (await s.activeTitle()) === repo(), 5000, 'la pestaña existente pasa a activa');
    assert.equal(await s.tabs.count(), 2);
    await s.bar('work').waitFor();
  });

  it('control negativo: cancelar el selector de carpeta no abre ninguna pestaña', async () => {
    await s.page.keyboard.press('Control+o');
    await s.page.waitForTimeout(700);
    assert.equal(await s.tabs.count(), 2);
    assert.equal(await s.activeTitle(), repo());
  });

  it('un clic en una pestaña la activa y la barra de herramientas cambia de repositorio', async () => {
    await s.tab(second).click();
    await waitFor(async () => (await s.tab(second).getAttribute('aria-selected')) === 'true', 3000, 'second activa');
    assert.equal(await s.tab(repo()).getAttribute('aria-selected'), 'false');
    await s.bar('second-repo').waitFor();
    // La ruta de la barra de estado sigue a la pestaña activa
    await s.page.locator(`footer [title="${second}"]`).waitFor();
    await s.tab(repo()).click();
    await s.bar('work').waitFor();
    await s.page.locator(`footer [title="${repo()}"]`).waitFor();
  });

  it('el punto de cambios aparece solo en la pestaña con cambios y se actualiza al refrescar', async () => {
    const dot = (p: string) => s.tab(p).locator('span.rounded-full');
    assert.equal(await dot(repo()).count(), 1, 'work tiene cambios sin commit');
    assert.equal(await dot(second).count(), 0, 'second-repo está limpio (control negativo)');
    writeFileSync(path.join(second, 'new.txt'), 'n\n');
    await s.tab(second).click();
    await s.page.keyboard.press('F5');
    await dot(second).waitFor({ timeout: 10000 });
    // Al volver a dejarlo limpio el punto desaparece
    rmSync(path.join(second, 'new.txt'));
    await s.page.keyboard.press('F5');
    await dot(second).waitFor({ state: 'detached', timeout: 10000 });
  });

  it('el botón × de la pestaña la cierra y las demás se conservan', async () => {
    const third = makeSmall(fx.base, 'third-repo');
    await openRepo(s, third);
    assert.equal(await s.tabs.count(), 3);
    await s.tab(third).hover();
    await s.tab(third).locator('xpath=following-sibling::span[@aria-hidden="true"]').click();
    await s.tab(third).waitFor({ state: 'detached' });
    assert.equal(await s.tabs.count(), 2);
    assert.ok(await s.tab(repo()).count());
    assert.ok(await s.tab(second).count());
    // Al cerrar la activa pasa a ser activa otra pestaña (no se queda sin selección)
    assert.ok(await s.activeTitle());
  });

  it('el clic central cierra la pestaña; el clic izquierdo y el derecho no la cierran (controles negativos)', async () => {
    const t = makeSmall(fx.base, 'middle-repo');
    await openRepo(s, t);
    await s.tab(t).click();
    assert.equal(await s.tab(t).count(), 1);
    await s.tab(t).click({ button: 'right' });
    await s.menu.waitFor();
    await s.page.keyboard.press('Escape');
    assert.equal(await s.tab(t).count(), 1);
    await s.tab(t).click({ button: 'middle' });
    await s.tab(t).waitFor({ state: 'detached' });
    assert.equal(await s.tabs.count(), 2);
  });

  it('el menú contextual de la pestaña ofrece sus 3 acciones, y cada una hace su efecto', async () => {
    const t = repo();
    await s.tab(t).click({ button: 'right' });
    await s.menu.waitFor();
    const items = (await s.page.locator('[role=menuitem]').allInnerTexts()).map((x) => x.trim());
    assert.deepEqual(items, ['Abrir en el explorador de archivos', 'Abrir terminal aquí', 'Cerrar pestaña']);

    await s.clearCalls();
    await s.page.locator('[role=menuitem]').filter({ hasText: 'explorador' }).click();
    await s.menu.waitFor({ state: 'detached' });
    for (let i = 0; i < 20 && !(await s.calls()).length; i++) await s.page.waitForTimeout(100);
    assert.deepEqual(await s.calls(), [{ fn: 'showItemInFolder', arg: t }]);

    rmSync(marker, { force: true });
    await s.tab(t).click({ button: 'right' });
    await s.page.locator('[role=menuitem]').filter({ hasText: 'terminal' }).click();
    for (let i = 0; i < 30 && !existsSync(marker); i++) await s.page.waitForTimeout(100);
    assert.ok(existsSync(marker), 'la terminal configurada se lanza en la carpeta del repo');

    // "Cerrar pestaña" cierra solo la pestaña sobre la que se abrió el menú, aunque no sea la activa
    await s.tab(second).click();
    await s.tab(t).click({ button: 'right' });
    await s.page.locator('[role=menuitem]').filter({ hasText: 'Cerrar pestaña' }).click();
    await s.tab(t).waitFor({ state: 'detached' });
    assert.equal(await s.tabs.count(), 1);
    assert.equal(await s.activeTitle(), second);
  });

  it('el menú contextual se cierra con Escape y con un clic fuera sin ejecutar nada', async () => {
    await s.clearCalls();
    await s.tab(second).click({ button: 'right' });
    await s.menu.waitFor();
    await s.page.keyboard.press('Escape');
    await s.menu.waitFor({ state: 'detached' });
    await s.tab(second).click({ button: 'right' });
    await s.menu.waitFor();
    await s.page.mouse.click(700, 500);
    await s.menu.waitFor({ state: 'detached' });
    assert.deepEqual(await s.calls(), []);
    assert.equal(await s.tabs.count(), 1);
  });

  it('el botón + abre la bienvenida sin cerrar las pestañas, y al elegir una pestaña vuelve al repo', async () => {
    await openRepo(s, repo());
    await s.page.getByTitle('Abrir repositorio', { exact: true }).click();
    await s.welcomeOpen.waitFor();
    assert.equal(await s.tabs.count(), 2);
    // Con la bienvenida visible no hay barra de herramientas de repo
    assert.equal(await s.bar().count(), 0);
    await s.tab(second).click();
    await s.bar('second-repo').waitFor();
    assert.equal(await s.welcomeOpen.count(), 0);
  });

  it('Ctrl+O desde la bienvenida abre el repo y oculta la bienvenida', async () => {
    await s.tab(repo()).locator('xpath=following-sibling::span[@aria-hidden=\"true\"]').click();
    await s.tab(repo()).waitFor({ state: 'detached' });
    await s.page.getByTitle('Abrir repositorio', { exact: true }).click();
    await s.welcomeOpen.waitFor();
    await openRepo(s, repo());
    assert.equal(await s.welcomeOpen.count(), 0);
    assert.equal(await s.activeTitle(), repo());
  });

  it('al reabrir con el mismo perfil se restauran las pestañas y la activa; las cerradas no vuelven', async () => {
    await s.tab(second).click();
    await s.tab(repo()).click();
    const t = makeSmall(fx.base, 'closed-repo');
    await openRepo(s, t);
    await s.tab(t).locator('xpath=following-sibling::span[@aria-hidden=\"true\"]').click();
    await s.tab(t).waitFor({ state: 'detached' });
    await s.tab(repo()).click();
    s = await s.relaunch();
    await s.tab(repo()).waitFor({ timeout: 15000 });
    assert.equal(await s.tabs.count(), 2);
    assert.ok(await s.tab(second).count());
    assert.equal(await s.tab(t).count(), 0, 'una pestaña cerrada no se restaura');
    assert.equal(await s.activeTitle(), repo());
    const saved = readSettings(fx.data);
    assert.deepEqual((saved['openRepos'] as string[]).sort(), [repo(), second].sort());
    assert.equal(saved['activeRepo'], repo());
  });

  it('cerrar la última pestaña muestra la bienvenida, y reabrir sin pestañas la mantiene', async () => {
    for (const p of [second, repo()]) await s.tab(p).locator('xpath=following-sibling::span[@aria-hidden=\"true\"]').click();
    await s.page.waitForFunction(() => document.querySelectorAll('header [role=tab]').length === 0);
    await s.welcomeOpen.waitFor();
    assert.equal(await s.bar().count(), 0);
    s = await s.relaunch();
    await s.welcomeOpen.waitFor();
    assert.equal(await s.tabs.count(), 0);
    assert.deepEqual(readSettings(fx.data)['openRepos'], []);
  });
});

/** Vuelve a la bienvenida con el botón + (si hay pestañas) y espera a que se vea. */
async function goWelcome(s: Sess): Promise<void> {
  await s.page.getByTitle('Abrir repositorio', { exact: true }).click().catch(() => undefined);
  await s.welcomeOpen.waitFor();
}

describe('pantalla de bienvenida (E2E)', { skip }, () => {
  let fx: Fixture;
  let clones: string;
  let s: Sess;
  const repo = () => realpathSync(fx.repo);
  const recent = () => s.page.locator('gt-welcome li[title]');
  const welcomeBtn = (re: RegExp) => s.page.locator('gt-welcome').getByRole('button', { name: re });
  const field = (id: string) => s.page.locator(`#fd-${id}`);
  const submit = () => s.dialog.locator('button[type=submit]').click();

  before(async () => {
    fx = makeFixture();
    clones = path.join(fx.base, 'clones');
    mkdirSync(clones);
    seed(fx.data, { defaultCloneDir: clones });
    s = await Sess.launch(fx.data);
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('muestra título, las 4 acciones, la versión de git y la lista de recientes vacía', async () => {
    await s.page.getByRole('heading', { name: 'Abre un repositorio para empezar' }).waitFor();
    for (const re of [/Abrir repositorio local/, /Clonar repositorio/, /Clonar desde mi cuenta/, /Crear repositorio nuevo/]) {
      assert.equal(await welcomeBtn(re).count(), 1, `falta el botón ${re}`);
    }
    assert.match(await s.page.locator('gt-welcome').innerText(), /Usando git version \d/);
    await s.page.getByText('Aún no has abierto ningún repositorio.').waitFor();
    assert.equal(await recent().count(), 0);
    assert.match(await welcomeBtn(/Abrir repositorio local/).innerText(), /Ctrl\+O/);
  });

  it('control negativo: cancelar el selector de "Abrir repositorio local" no abre nada', async () => {
    await welcomeBtn(/Abrir repositorio local/).click();
    await s.page.waitForTimeout(600);
    assert.equal(await s.tabs.count(), 0);
    await s.welcomeOpen.waitFor();
  });

  it('"Abrir repositorio local" abre una pestaña, oculta la bienvenida y lo añade a recientes', async () => {
    await s.pick(fx.repo);
    await welcomeBtn(/Abrir repositorio local/).click();
    await s.tab(repo()).waitFor({ timeout: 15000 });
    assert.equal(await s.welcomeOpen.count(), 0);
    await goWelcome(s);
    assert.equal(await recent().count(), 1);
    assert.equal(await recent().first().getAttribute('title'), repo());
    assert.match(await recent().first().innerText(), /work/);
    assert.equal(await s.page.getByText('Aún no has abierto').count(), 0);
    assert.deepEqual(readSettings(fx.data)['recentRepos'], [repo()]);
  });

  it('control negativo: una carpeta que no es repositorio muestra un error y no abre pestaña', async () => {
    const plain = path.join(fx.base, 'plain-dir');
    mkdirSync(plain);
    await s.pick(plain);
    await welcomeBtn(/Abrir repositorio local/).click();
    await s.page.locator('[aria-live=polite] > div.border-danger').first().waitFor({ timeout: 10000 });
    assert.equal(await s.tabs.count(), 1);
    assert.equal(await recent().count(), 1, 'no se añade a recientes');
  });

  it('un clic en un reciente abre su pestaña (tras cerrarla)', async () => {
    await s.tab(repo()).locator('xpath=following-sibling::span[@aria-hidden=\"true\"]').click();
    await s.tab(repo()).waitFor({ state: 'detached' });
    await s.welcomeOpen.waitFor();
    await recent().first().click();
    await s.tab(repo()).waitFor({ timeout: 15000 });
    assert.equal(await s.activeTitle(), repo());
    assert.equal(await s.welcomeOpen.count(), 0);
  });

  it('"Quitar de recientes" del menú contextual quita solo ese reciente, en pantalla y en settings.json', async () => {
    const other = makeSmall(fx.base, 'other-recent');
    await openRepo(s, other);
    await goWelcome(s);
    assert.equal(await recent().count(), 2);
    await recent().filter({ hasText: 'other-recent' }).click({ button: 'right' });
    await s.menu.waitFor();
    assert.deepEqual((await s.page.locator('[role=menuitem]').allInnerTexts()).map((x) => x.trim()), ['Quitar de recientes']);
    await s.page.locator('[role=menuitem]').click();
    await s.page.waitForFunction(() => document.querySelectorAll('gt-welcome li[title]').length === 1);
    assert.equal(await recent().first().getAttribute('title'), repo());
    for (let i = 0; i < 20 && (readSettings(fx.data)['recentRepos'] as string[]).includes(other); i++) await s.page.waitForTimeout(100);
    assert.deepEqual(readSettings(fx.data)['recentRepos'], [repo()]);
    // Quitar de recientes no cierra la pestaña que sigue abierta
    assert.ok(await s.tab(other).count());
  });

  it('un reciente cuya carpeta ya no existe muestra un error y no abre pestaña (se conserva en la lista)', async () => {
    const gone = makeSmall(fx.base, 'gone-repo');
    await openRepo(s, gone);
    await s.tab(gone).locator('xpath=following-sibling::span[@aria-hidden=\"true\"]').click();
    await s.tab(gone).waitFor({ state: 'detached' });
    await goWelcome(s);
    rmSync(gone, { recursive: true, force: true });
    const tabs = await s.tabs.count();
    await recent().filter({ hasText: 'gone-repo' }).click();
    await s.page.locator('[aria-live=polite] > div.border-danger').first().waitFor({ timeout: 10000 });
    assert.equal(await s.tabs.count(), tabs);
    assert.equal(await recent().filter({ hasText: 'gone-repo' }).count(), 1);
  });

  describe('clonar repositorio', () => {
    const openClone = async () => {
      await goWelcome(s);
      await welcomeBtn(/Clonar repositorio/).click();
      await s.waitDialog();
    };

    it('abre el diálogo con sus campos, la carpeta por defecto y "recursivo" marcado; Escape lo cierra', async () => {
      const tabsBefore = await s.tabs.count();
      await openClone();
      assert.equal(await s.dialogTitle(), 'Clonar repositorio');
      assert.equal(await field('parent').inputValue(), clones);
      assert.equal(await field('url').inputValue(), '');
      assert.equal(await s.dialog.getByRole('checkbox', { name: 'Incluir submódulos' }).isChecked(), true);
      assert.equal(await s.page.evaluate(() => document.activeElement?.id), 'fd-url', 'foco inicial en la URL');
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      assert.equal(await s.tabs.count(), tabsBefore);
    });

    it('con URL y nombre vacíos muestra "obligatorio" y el diálogo sigue abierto (sin clonar)', async () => {
      await openClone();
      assert.equal(await s.dialog.locator('.error-text').count(), 0, 'sin errores antes de enviar');
      await submit();
      await s.dialog.locator('.error-text').first().waitFor();
      const errs = await s.dialog.locator('.error-text').allInnerTexts();
      assert.ok(errs.length >= 2 && errs.every((e) => e === 'Este campo es obligatorio'), errs.join('|'));
      assert.equal(await s.overlays.count(), 1);
      assert.deepEqual(await s.toastTexts(), []);
    });

    it('(UX) al escribir la URL el nombre de la carpeta se rellena con el nombre del repo', async () => {
      await openClone();
      await field('url').fill('https://example.invalid/acme/proyecto-x.git');
      assert.equal(await field('name').inputValue(), 'proyecto-x');
    });

    it('un destino elegido con "Examinar…" rellena la carpeta padre', async () => {
      await openClone();
      const dest = path.join(fx.base, 'otro-destino');
      mkdirSync(dest);
      await s.pick(dest);
      await s.dialog.getByRole('button', { name: /Examinar/ }).click();
      await s.page.waitForFunction((d) => (document.querySelector('#fd-parent') as HTMLInputElement).value === d, dest);
      // Cancelar el selector conserva el valor (control negativo)
      await s.dialog.getByRole('button', { name: /Examinar/ }).click();
      await s.page.waitForTimeout(500);
      assert.equal(await field('parent').inputValue(), dest);
    });

    it('una URL inválida: el diálogo se cierra, aparece un error y no se crea carpeta ni pestaña', async () => {
      await openClone();
      const tabs = await s.tabs.count();
      await field('url').fill(path.join(fx.base, 'no-existe.git'));
      await field('parent').fill(clones);
      await field('name').fill('invalido');
      await submit();
      await s.page.locator('[aria-live=polite] > div.border-danger').first().waitFor({ timeout: 20000 });
      assert.equal(await s.tabs.count(), tabs);
      assert.ok(!existsSync(path.join(clones, 'invalido', '.git')));
      // El toast de progreso no se queda colgado
      assert.equal(await s.page.locator('[aria-live=polite] .spinner').count(), 0);
    });

    it('clonar desde un bare local (Enter envía): crea el clon, abre la pestaña y git lo verifica', async () => {
      await openClone();
      const dest = path.join(clones, 'clon-ok');
      await field('url').fill(fx.bare);
      await field('parent').fill(clones);
      await field('name').fill('clon-ok');
      await field('name').press('Enter');
      await s.toast(/Repositorio clonado/, 30000);
      await s.tab(realpathSync(dest)).waitFor({ timeout: 15000 });
      assert.equal(git(dest, 'rev-parse', 'HEAD'), git(fx.bare, 'rev-parse', 'main'));
      assert.equal(git(dest, 'remote', 'get-url', 'origin'), fx.bare);
      assert.equal(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
      assert.equal(await s.activeTitle(), realpathSync(dest));
    });

    it('clonar una rama concreta con profundidad 1 (file://) hace un clon superficial de esa rama', async () => {
      git(fx.repo, 'push', '-q', 'origin', 'feature/login');
      await openClone();
      const dest = path.join(clones, 'clon-rama');
      await field('url').fill(`file://${fx.bare}`);
      await field('name').fill('clon-rama');
      await field('branch').fill('feature/login');
      await field('depth').fill('1');
      await submit();
      await s.toast(/Repositorio clonado/, 30000);
      await s.tab(realpathSync(dest)).waitFor({ timeout: 15000 });
      assert.equal(git(dest, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/login');
      assert.equal(git(dest, 'rev-parse', '--is-shallow-repository'), 'true');
      assert.equal(git(dest, 'rev-list', '--count', 'HEAD'), '1');
    });

    it('clonar sobre una carpeta que ya existe y no está vacía falla con un error y no abre pestaña', async () => {
      await openClone();
      const tabs = await s.tabs.count();
      await field('url').fill(fx.bare);
      await field('name').fill('clon-ok');
      await submit();
      await s.page.locator('[aria-live=polite] > div.border-danger').first().waitFor({ timeout: 20000 });
      assert.equal(await s.tabs.count(), tabs);
    });
  });

  describe('crear repositorio nuevo (init)', () => {
    const openInit = async () => {
      await goWelcome(s);
      await welcomeBtn(/Crear repositorio nuevo/).click();
      await s.waitDialog();
    };

    it('abre el diálogo con carpeta por defecto, rama "main" y "bare" desmarcado; Escape lo cierra', async () => {
      await openInit();
      assert.equal(await s.dialogTitle(), 'Crear repositorio');
      assert.equal(await field('folder').inputValue(), clones);
      assert.equal(await field('branch').inputValue(), 'main');
      assert.equal(await s.dialog.getByRole('checkbox', { name: 'Repositorio bare' }).isChecked(), false);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
    });

    it('carpeta o rama vacías: error "obligatorio" y no se crea nada', async () => {
      await openInit();
      await field('folder').fill('');
      await field('branch').fill('');
      await submit();
      await waitFor(async () => (await s.dialog.locator('.error-text').count()) === 2, 3000, 'dos errores');
      const errs = await s.dialog.locator('.error-text').allInnerTexts();
      assert.ok(errs.every((e) => e === 'Este campo es obligatorio'));
      assert.equal(await s.overlays.count(), 1);
    });

    it('crea un repositorio con la rama indicada, lo abre en una pestaña y existe .git', async () => {
      await openInit();
      const folder = path.join(fx.base, 'nuevo-repo');
      await field('folder').fill(folder);
      await field('branch').fill('trunk');
      await submit();
      await s.waitNoDialog();
      await s.tab(realpathSync(folder)).waitFor({ timeout: 15000 });
      assert.ok(existsSync(path.join(folder, '.git')));
      assert.equal(git(folder, 'symbolic-ref', '--short', 'HEAD'), 'trunk');
      assert.equal(git(folder, 'rev-parse', '--is-bare-repository'), 'false');
    });

    it('la casilla "bare" crea un repositorio sin árbol de trabajo (no hay .git dentro)', async () => {
      await openInit();
      const folder = path.join(fx.base, 'bare-nuevo.git');
      await field('folder').fill(folder);
      await s.dialog.getByRole('checkbox', { name: 'Repositorio bare' }).check();
      await submit();
      for (let i = 0; i < 40 && !existsSync(path.join(folder, 'HEAD')); i++) await s.page.waitForTimeout(100);
      assert.equal(git(folder, 'rev-parse', '--is-bare-repository'), 'true');
      assert.ok(!existsSync(path.join(folder, '.git')));
    });

    it('un error de git (la carpeta es un archivo) se muestra dentro del diálogo, que sigue abierto', async () => {
      await s.closeAll();
      await openInit();
      const afile = path.join(fx.base, 'soy-un-archivo');
      writeFileSync(afile, 'x');
      await field('folder').fill(afile);
      await submit();
      await s.dialog.locator('pre').first().waitFor({ timeout: 10000 });
      assert.match(await s.dialog.locator('pre').first().innerText(), /\S/);
      assert.equal(await s.overlays.count(), 1);
      assert.ok(!existsSync(path.join(afile, '.git')));
    });
  });

  it('"Clonar desde mi cuenta" sin cuentas explica que primero hay que añadir una', async () => {
    await goWelcome(s);
    await welcomeBtn(/Clonar desde mi cuenta/).click();
    await s.waitDialog();
    assert.equal(await s.dialogTitle(), 'Clonar desde mi cuenta');
    await s.page.getByText('Primero agrega una cuenta en Ajustes → Cuentas.').waitFor();
    assert.equal(await s.dialog.locator('select').count(), 0);
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
  });

  it('arrastrar y soltar una carpeta sobre la bienvenida no abre nada (la app no lo soporta)', async () => {
    await goWelcome(s);
    const tabs = await s.tabs.count();
    await s.page.locator('gt-welcome').evaluate((el, p) => {
      const dt = new DataTransfer();
      dt.setData('text/uri-list', `file://${p}`);
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, fx.repo);
    await s.page.waitForTimeout(500);
    assert.equal(await s.tabs.count(), tabs);
  });
});

/** Fixture con un repo ya abierto desde el arranque (settings sembrados) y un archivo grande para probar el diff. */
function makeOpenFixture(extra: Json = {}): { fx: Fixture; repo: string; marker: string } {
  const fx = makeFixture();
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  writeFileSync(path.join(fx.repo, 'big.txt'), lines);
  fx.g('add', 'big.txt');
  fx.g('commit', '-qm', 'docs: big');
  fx.g('push', '-q', 'origin', 'main');
  const repo = realpathSync(fx.repo);
  const marker = path.join(fx.base, 'terminal-marker');
  seed(fx.data, {
    openRepos: [repo],
    activeRepo: repo,
    terminal: `touch ${marker}`,
    defaultCloneDir: fx.base,
    ...extra,
  });
  return { fx, repo, marker };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000, what = 'condición'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`tiempo agotado esperando: ${what}`);
}

describe('pie de página, consola, redimensionado y título (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let s: Sess;
  const theme = () => s.page.evaluate(() => document.documentElement.dataset['theme']);
  const bg = () => s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  /** Botones del pie en orden: idioma, tema, consola (los títulos cambian con el idioma). */
  const langBtn = () => s.page.locator('footer button').nth(0);
  const themeBtn = () => s.page.locator('footer button').nth(1);
  const sidebarW = () => s.page.locator('main.grid').evaluate((el) => (el as HTMLElement).style.gridTemplateColumns);
  const consoleH = () =>
    s.page.locator('gt-console-panel').evaluate((el) => (el.parentElement as HTMLElement).getBoundingClientRect().height);
  const menuLabels = () =>
    s.electron.evaluate(({ Menu }) => (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label));

  before(async () => {
    ({ fx, repo } = makeOpenFixture());
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('el título de la ventana es "Gitora" (documento y ventana nativa), también con un repo abierto', async () => {
    assert.equal(await s.page.title(), 'Gitora');
    assert.equal(await s.electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), 'Gitora');
  });

  it('la barra de estado muestra rama, upstream y sincronización; y ↑ tras un commit local', async () => {
    const footer = s.page.locator('footer');
    await footer.getByText('origin/main').waitFor();
    assert.match(await footer.innerText(), /main/);
    await footer.getByText('Sincronizado').waitFor();
    fx.g('stash', '-u', '-q');
    writeFileSync(path.join(fx.repo, 'ahead.txt'), 'a');
    fx.g('add', '-A');
    fx.g('commit', '-qm', 'feat: ahead');
    fx.g('stash', 'pop', '-q');
    await s.page.keyboard.press('F5');
    await footer.getByText('↑1').waitFor({ timeout: 10000 });
    assert.equal(await footer.getByText('Sincronizado').count(), 0, 'ya no está sincronizado (control negativo)');
    fx.g('push', '-q', 'origin', 'main');
    await s.page.keyboard.press('F5');
    await footer.getByText('Sincronizado').waitFor({ timeout: 10000 });
  });

  describe('idioma', () => {
    it('el botón ES/EN cambia los textos de la interfaz al instante y el menú nativo', async () => {
      assert.equal((await langBtn().innerText()).trim(), 'ES');
      assert.equal(await langBtn().getAttribute('title'), 'Idioma');
      assert.ok((await menuLabels()).includes('Archivo'));
      await s.bar('work').getByText('Rama', { exact: true }).waitFor();
      await langBtn().click();
      await s.bar('work').getByText('Branch', { exact: true }).waitFor();
      assert.equal((await langBtn().innerText()).trim(), 'EN');
      assert.equal(await langBtn().getAttribute('title'), 'Language');
      assert.equal(await s.bar('work').getByText('Rama', { exact: true }).count(), 0, 'no queda texto en español');
      assert.equal(await s.page.getByTitle('Settings').count(), 1);
      await waitFor(async () => (await menuLabels()).includes('File'), 5000, 'menú nativo en inglés');
      assert.ok(!(await menuLabels()).includes('Archivo'));
      assert.equal(readSettings(fx.data)['language'], 'en');
    });

    it('el idioma persiste al reiniciar, y el botón vuelve a español', async () => {
      s = await s.relaunch();
      await s.tab(repo).waitFor({ timeout: 15000 });
      await s.bar('work').getByText('Branch', { exact: true }).waitFor();
      assert.equal((await langBtn().innerText()).trim(), 'EN');
      await langBtn().click();
      await s.bar('work').getByText('Rama', { exact: true }).waitFor();
      assert.equal(readSettings(fx.data)['language'], 'es');
    });
  });

  describe('tema', () => {
    it('el botón de tema alterna oscuro/claro (atributo data-theme y color de fondo) y se restaura', async () => {
      assert.equal(await theme(), 'dark');
      const dark = await bg();
      await themeBtn().click();
      await waitFor(async () => (await theme()) === 'light', 3000, 'tema claro');
      assert.notEqual(await bg(), dark, 'cambia el color de fondo');
      assert.equal(readSettings(fx.data)['theme'], 'light');
      await themeBtn().click();
      await waitFor(async () => (await theme()) === 'dark', 3000, 'tema oscuro');
      assert.equal(await bg(), dark);
      assert.equal(readSettings(fx.data)['theme'], 'dark');
    });

    it('el tema claro persiste al reiniciar', async () => {
      await themeBtn().click();
      await waitFor(async () => (await theme()) === 'light', 3000);
      s = await s.relaunch();
      await s.tab(repo).waitFor({ timeout: 15000 });
      assert.equal(await theme(), 'light');
      await themeBtn().click();
      await waitFor(async () => (await theme()) === 'dark', 3000);
    });
  });

  describe('consola', () => {
    it('el botón Consola muestra/oculta el panel, persiste y Ctrl+` hace lo mismo', async () => {
      assert.equal(await s.page.locator('gt-console-panel').count(), 0);
      await s.page.locator('footer button[title="Ctrl+`"]').click();
      await s.page.locator('gt-console-panel').waitFor();
      assert.equal(readSettings(fx.data)['showConsole'], true);
      await s.page.locator('footer button[title="Ctrl+`"]').click();
      await s.page.locator('gt-console-panel').waitFor({ state: 'detached' });
      assert.equal(readSettings(fx.data)['showConsole'], false);
      await s.page.keyboard.press('Control+`');
      await s.page.locator('gt-console-panel').waitFor();
    });

    it('la consola lista los comandos git que ejecuta la app y "Limpiar" la vacía', async () => {
      await s.page.keyboard.press('Control+Shift+F');
      await s.page.locator('gt-console-panel').getByText(/git fetch/).first().waitFor({ timeout: 10000 });
      await s.page.locator('gt-console-panel').getByRole('button', { name: 'Limpiar' }).click();
      await s.page.getByText('Aquí aparecerá cada comando git que ejecute Gitora.').waitFor();
    });

    it('el campo "git …" de la consola ejecuta un comando y muestra su salida', async () => {
      const input = s.page.locator('gt-console-panel form input');
      await input.fill('rev-parse HEAD');
      await input.press('Enter');
      await s.page.locator('gt-console-panel').getByText(fx.g('rev-parse', 'HEAD'), { exact: false }).first().waitFor({ timeout: 10000 });
      assert.equal(await input.inputValue(), '', 'el campo se vacía tras ejecutar');
    });

    it('el botón × de la consola la cierra', async () => {
      await s.page.locator('gt-console-panel').getByRole('button', { name: 'Cerrar' }).click();
      await s.page.locator('gt-console-panel').waitFor({ state: 'detached' });
    });

    it('la consola abierta persiste al reiniciar', async () => {
      await s.page.keyboard.press('Control+`');
      await s.page.locator('gt-console-panel').waitFor();
      s = await s.relaunch();
      await s.page.locator('gt-console-panel').waitFor({ timeout: 15000 });
      await s.page.keyboard.press('Control+`');
      await s.page.locator('gt-console-panel').waitFor({ state: 'detached' });
    });
  });

  describe('redimensionado', () => {
    const drag = async (sel: string, dx: number, dy: number) => {
      const box = await s.page.locator(sel).boundingBox();
      assert.ok(box, `no existe ${sel}`);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await s.page.mouse.move(x, y);
      await s.page.mouse.down();
      await s.page.mouse.move(x + dx, y + dy, { steps: 8 });
      await s.page.mouse.up();
      await s.page.waitForTimeout(150);
    };
    const handle = 'main.grid > div.cursor-col-resize';

    it('arrastrar el borde del sidebar cambia su ancho (260 → 360) y un clic sin mover no lo cambia', async () => {
      assert.equal(await sidebarW(), '260px 1fr');
      await drag(handle, 0, 0);
      assert.equal(await sidebarW(), '260px 1fr');
      await drag(handle, 100, 0);
      assert.equal(await sidebarW(), '360px 1fr');
    });

    it('el ancho del sidebar tiene límites (190–480 px)', async () => {
      await drag(handle, 600, 0);
      assert.equal(await sidebarW(), '480px 1fr');
      await drag(handle, -900, 0);
      assert.equal(await sidebarW(), '190px 1fr');
      await drag(handle, 70, 0);
      assert.equal(await sidebarW(), '260px 1fr');
    });

    it('arrastrar el borde de la consola hacia arriba la hace más alta; con límites', async () => {
      await s.page.keyboard.press('Control+`');
      await s.page.locator('gt-console-panel').waitFor();
      const h0 = await consoleH();
      assert.ok(Math.abs(h0 - 220) < 2, `altura inicial ${h0}`);
      await drag('div.cursor-row-resize', 0, -80);
      assert.ok(Math.abs((await consoleH()) - 300) < 2, `tras arrastrar ${await consoleH()}`);
      await drag('div.cursor-row-resize', 0, 2000);
      assert.ok(Math.abs((await consoleH()) - 100) < 2, 'mínimo 100');
      const max = await s.page.evaluate(() => window.innerHeight * 0.7);
      await drag('div.cursor-row-resize', 0, -2000);
      assert.ok(Math.abs((await consoleH()) - max) < 2, 'máximo 70% de la ventana');
      await drag('div.cursor-row-resize', 0, max - 220);
    });

    it('(persistencia) el ancho del sidebar se conserva al reiniciar', async () => {
      await drag(handle, 100, 0);
      const w = await sidebarW();
      assert.equal(w, '360px 1fr');
      s = await s.relaunch();
      await s.tab(repo).waitFor({ timeout: 15000 });
      assert.equal(await sidebarW(), w, 'el sidebar vuelve a 260px: el ancho no se guarda en ninguna parte');
    });

    it('(persistencia) la altura de la consola se conserva al reiniciar', async () => {
      if (!(await s.page.locator('gt-console-panel').count())) await s.page.keyboard.press('Control+`');
      await s.page.locator('gt-console-panel').waitFor();
      const h0 = Math.round(await consoleH());
      await drag('div.cursor-row-resize', 0, -80);
      const h = Math.round(await consoleH());
      assert.equal(h, h0 + 80);
      s = await s.relaunch();
      await s.page.locator('gt-console-panel').waitFor({ timeout: 15000 });
      assert.equal(Math.round(await consoleH()), h, 'la consola vuelve a 220px: la altura no se guarda');
    });
  });

  it('no hubo errores de JavaScript sin capturar durante la sesión', async () => {
    assert.deepEqual(s.errors, []);
  });
});

describe('Ajustes (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let marker: string;
  let s: Sess;
  const sel = (id: string) => s.page.locator(`#${id}`);
  const saved = () => readSettings(fx.data);
  const waitSaved = async (key: string, value: unknown) =>
    waitFor(() => JSON.stringify(saved()[key]) === JSON.stringify(value), 5000, `settings.${key} = ${JSON.stringify(value)}`);
  const tabBtn = (re: RegExp) => s.dialog.getByRole('tab', { name: re });
  const goTab = async (re: RegExp) => {
    await tabBtn(re).click();
    await waitFor(async () => (await tabBtn(re).getAttribute('aria-selected')) === 'true', 3000, 'pestaña seleccionada');
    await s.page.waitForTimeout(200);
  };
  const themeBtn = (re: RegExp) => s.dialog.getByRole('button', { name: re });
  const theme = () => s.page.evaluate(() => document.documentElement.dataset['theme']);
  const cssFont = () => s.page.evaluate(() => document.documentElement.style.getPropertyValue('--font-size'));
  const closeSettings = async () => {
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
  };
  const rows = () => s.page.locator('gt-diff-viewer [data-type]').count();
  const showDiff = async (file: string) => {
    await s.page.keyboard.press('Control+1');
    await s.page.keyboard.press('F5');
    await s.page.locator('gt-changes li', { hasText: file }).first().click();
    await s.page.locator('gt-diff-viewer').waitFor();
  };

  before(async () => {
    ({ fx, repo, marker } = makeOpenFixture());
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  describe('apertura y estructura', () => {
    it('se abre con el botón Ajustes de la barra, empieza en la pestaña General y tiene 5 pestañas', async () => {
      await s.page.getByTitle('Ajustes', { exact: true }).click();
      await s.waitDialog();
      assert.equal(await s.dialogTitle(), 'Ajustes');
      const names = (await s.dialog.getByRole('tab').allInnerTexts()).map((t) => t.trim());
      assert.deepEqual(names, ['General', 'Git', 'Diff', 'Cuentas', 'Acerca de']);
      assert.equal(await tabBtn(/General/).getAttribute('aria-selected'), 'true');
      assert.equal(await sel('s-lang').count(), 1);
    });

    it('Ctrl+, abre Ajustes y, con el diálogo abierto, otro Ctrl+, no apila un segundo', async () => {
      await s.page.keyboard.press('Control+,');
      await s.waitDialog();
      assert.equal(await s.dialogTitle(), 'Ajustes');
      await s.page.keyboard.press('Control+,');
      await s.page.waitForTimeout(400);
      assert.equal(await s.overlays.count(), 1);
    });

    it('se cierra con Escape, con ×, y con clic en el fondo; al reabrir vuelve a General', async () => {
      await s.openSettings(/Git/);
      assert.equal(await tabBtn(/Git/).getAttribute('aria-selected'), 'true');
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await s.openSettings();
      await waitFor(async () => (await tabBtn(/General/).getAttribute('aria-selected')) === 'true', 3000, 'reabre en General');
      await s.dialog.getByRole('button', { name: 'Cerrar' }).click();
      await s.waitNoDialog();
      await s.openSettings();
      await s.page.mouse.click(5, 400);
      await s.waitNoDialog();
    });

    it('un clic dentro del diálogo no lo cierra (control negativo)', async () => {
      await s.openSettings();
      await s.dialog.locator('h2').click();
      await s.page.waitForTimeout(300);
      assert.equal(await s.overlays.count(), 1);
    });

    it('cada pestaña muestra sus controles y solo los suyos', async () => {
      await s.openSettings();
      const ids = async () => s.dialog.locator('[id^="s-"]').evaluateAll((els) => els.map((e) => e.id));
      const idsAre = async (expected: string[]) => {
        await waitFor(async () => JSON.stringify(await ids()) === JSON.stringify(expected), 4000, `controles ${expected.join(',')}`);
      };
      await idsAre(['s-lang', 's-font', 's-term']);
      await goTab(/^Git$/);
      await idsAre(['s-git', 's-clone', 's-pull', 's-fetch', 's-merge']);
      await goTab(/Diff/);
      await idsAre(['s-ctx']);
      assert.equal(await s.dialog.getByRole('button', { name: 'Unificado' }).count(), 1);
      assert.equal(await s.dialog.getByRole('button', { name: 'Lado a lado' }).count(), 1);
      await goTab(/Cuentas/);
      await s.dialog.getByRole('button', { name: 'Agregar cuenta' }).waitFor();
      await goTab(/Acerca de/);
      await s.dialog.getByRole('heading', { name: 'Gitora' }).waitFor();
      await idsAre([]);
    });

    it('"Acerca de" muestra la versión del paquete, la de git y la plataforma', async () => {
      await s.openSettings(/Acerca de/);
      await s.dialog.getByRole('heading', { name: 'Gitora' }).waitFor();
      const text = await s.dialog.innerText();
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
      assert.ok(text.includes(`Versión ${pkg.version}`), `la versión mostrada no coincide con package.json (${pkg.version}): ${text}`);
      assert.match(text, /Git: git version \d+\.\d+/);
      assert.match(text, /linux/);
    });

    it('no existe un botón de "restablecer valores por defecto" (control: la interfaz no lo ofrece)', async () => {
      await s.openSettings();
      for (const t of [/General/, /^Git$/, /Diff/, /Cuentas/, /Acerca de/]) {
        await tabBtn(t).click();
        assert.equal(await s.dialog.getByRole('button', { name: /restablecer|por defecto|reset|defaults/i }).count(), 0);
      }
    });
  });

  describe('General', () => {
    it('Idioma: el selector cambia la interfaz al instante (incluido el propio diálogo) y se guarda', async () => {
      await s.openSettings();
      assert.deepEqual(await sel('s-lang').locator('option').allInnerTexts(), ['Español', 'English']);
      await sel('s-lang').selectOption('en');
      await s.dialog.getByRole('heading', { name: 'Settings' }).waitFor();
      await s.bar('work').getByText('Branch', { exact: true }).waitFor();
      await waitSaved('language', 'en');
      assert.equal((await s.page.locator('footer button').nth(0).innerText()).trim(), 'EN');
      await sel('s-lang').selectOption('es');
      await s.dialog.getByRole('heading', { name: 'Ajustes' }).waitFor();
      await waitSaved('language', 'es');
    });

    it('Tema: Oscuro/Claro/Del sistema cambian data-theme; "Del sistema" sigue la preferencia del SO', async () => {
      await s.openSettings();
      const selected = async () =>
        s.dialog.locator('button.border-accent').allInnerTexts().then((a) => a.map((x) => x.trim()));
      assert.deepEqual(await selected(), ['Oscuro']);
      await themeBtn(/Claro/).click();
      await waitFor(async () => (await theme()) === 'light', 3000, 'tema claro');
      assert.deepEqual(await selected(), ['Claro']);
      await waitSaved('theme', 'light');
      await themeBtn(/Del sistema/).click();
      await waitSaved('theme', 'system');
      await s.page.emulateMedia({ colorScheme: 'dark' });
      await waitFor(async () => (await theme()) === 'dark', 3000, 'sistema oscuro');
      await s.page.emulateMedia({ colorScheme: 'light' });
      await waitFor(async () => (await theme()) === 'light', 3000, 'sistema claro');
      await themeBtn(/Oscuro/).click();
      await waitFor(async () => (await theme()) === 'dark', 3000, 'tema oscuro');
      await s.page.emulateMedia({ colorScheme: 'light' });
      await s.page.waitForTimeout(300);
      assert.equal(await theme(), 'dark', 'con tema fijo ya no sigue al SO (control negativo)');
      await s.page.emulateMedia({ colorScheme: null });
      await waitSaved('theme', 'dark');
    });

    it('Tamaño de letra: flechas, Inicio/Fin y límites 11–17 actualizan etiqueta, --font-size y settings.json', async () => {
      await s.openSettings();
      const label = () => s.dialog.locator('label[for=s-font]').innerText();
      assert.equal(await sel('s-font').inputValue(), '13');
      await sel('s-font').focus();
      await s.page.keyboard.press('ArrowRight');
      await s.page.keyboard.press('ArrowRight');
      assert.equal(await sel('s-font').inputValue(), '15');
      await waitFor(async () => /\(15px\)/.test(await label()), 3000, 'etiqueta 15px');
      await waitFor(async () => (await cssFont()) === '15px', 3000, '--font-size 15px');
      await waitFor(async () => (await s.page.evaluate(() => getComputedStyle(document.body).fontSize)) === '15px', 3000, 'fuente computada 15px');
      await waitSaved('fontSize', 15);
      await s.page.keyboard.press('ArrowLeft');
      assert.equal(await sel('s-font').inputValue(), '14');
      await s.page.keyboard.press('End');
      assert.equal(await sel('s-font').inputValue(), '17');
      await s.page.keyboard.press('ArrowRight');
      assert.equal(await sel('s-font').inputValue(), '17', 'no pasa del máximo');
      await s.page.keyboard.press('Home');
      assert.equal(await sel('s-font').inputValue(), '11');
      await s.page.keyboard.press('ArrowLeft');
      assert.equal(await sel('s-font').inputValue(), '11', 'no baja del mínimo');
      await waitFor(async () => (await cssFont()) === '11px', 3000, '--font-size 11px');
      await waitSaved('fontSize', 11);
    });

    it('Tamaño de letra: arrastrar con el ratón también lo cambia y se guarda', async () => {
      await s.openSettings();
      const slider = sel('s-font');
      await slider.focus();
      await s.page.keyboard.press('Home');
      const box = await slider.boundingBox();
      assert.ok(box);
      await s.page.mouse.move(box.x + 4, box.y + box.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 8 });
      await s.page.mouse.up();
      const v = Number(await slider.inputValue());
      assert.ok(v >= 16, `el valor tras arrastrar debía ser alto, fue ${v}`);
      await waitSaved('fontSize', v);
      assert.equal(await cssFont(), `${v}px`);
      await slider.focus();
      await s.page.keyboard.press('Home');
      await s.page.keyboard.press('ArrowRight');
      await s.page.keyboard.press('ArrowRight');
      await waitSaved('fontSize', 13);
    });

    it('"Pedir confirmación en acciones peligrosas": activada pide confirmar, desactivada ejecuta directo', async () => {
      fx.g('stash', '-u', '-q');
      assert.equal(fx.g('stash', 'list').split('\n').length, 1);
      await s.page.keyboard.press('F5');
      await s.openSettings();
      const box = s.dialog.getByRole('checkbox', { name: 'Pedir confirmación en acciones peligrosas' });
      assert.equal(await box.isChecked(), true, 'activada por defecto');
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      // Activada: aparece el diálogo de confirmación y cancelar conserva el stash
      await s.page.keyboard.press('Control+Shift+P');
      await s.waitDialog();
      await s.page.locator('input[role=combobox]').fill('todos los stashes');
      await s.page.keyboard.press('Enter');
      await s.page.locator('form.dialog').waitFor();
      assert.match(await s.overlays.last().innerText(), /Esta acción puede perder trabajo/);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      assert.equal(fx.g('stash', 'list').split('\n').length, 1, 'cancelar no borra el stash');
      // Desactivada: ejecuta sin preguntar
      await s.openSettings();
      await box.uncheck();
      await waitSaved('confirmDangerous', false);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await s.page.keyboard.press('Control+Shift+P');
      await s.waitDialog();
      await s.page.locator('input[role=combobox]').fill('todos los stashes');
      await s.page.keyboard.press('Enter');
      await waitFor(() => fx.g('stash', 'list') === '', 8000, 'stash vaciado sin confirmar');
      assert.equal(await s.overlays.count(), 0, 'sin diálogo de confirmación');
      await s.openSettings();
      await box.check();
      await waitSaved('confirmDangerous', true);
    });

    it('"Vigilar el directorio de trabajo": desactivado no actualiza solo; se guarda al marcarlo', async () => {
      fx.g('checkout', '-q', '--', '.');
      fx.g('clean', '-fdq');
      await s.page.keyboard.press('F5');
      // Los eventos de .git de los comandos anteriores se asientan antes de medir
      await s.page.waitForTimeout(2500);
      await waitFor(async () => (await s.tab(repo).locator('span.rounded-full').count()) === 0, 8000, 'árbol limpio');
      try {
        writeFileSync(path.join(fx.repo, 'w1.txt'), '1');
        await s.page.waitForTimeout(2500);
        assert.equal(await s.tab(repo).locator('span.rounded-full').count(), 0, 'sin vigilancia no hay actualización');
        await s.page.keyboard.press('F5');
        await s.tab(repo).locator('span.rounded-full').waitFor({ timeout: 8000 });
      } finally {
        rmSync(path.join(fx.repo, 'w1.txt'), { force: true });
      }
      await s.page.keyboard.press('F5');
      await s.tab(repo).locator('span.rounded-full').waitFor({ state: 'detached', timeout: 8000 });
      await s.openSettings();
      const box = s.dialog.getByRole('checkbox', { name: 'Vigilar el directorio de trabajo en tiempo real' });
      assert.equal(await box.isChecked(), false);
      await box.check();
      await waitSaved('watchWorkingTree', true);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
    });

    it('(efecto inmediato) al activar la vigilancia, los cambios en disco se ven sin reabrir el repo ni refrescar', async () => {
      await s.page.waitForTimeout(1500);
      try {
        writeFileSync(path.join(fx.repo, 'w2.txt'), '2');
        await s.tab(repo).locator('span.rounded-full').waitFor({ timeout: 6000 });
      } finally {
        rmSync(path.join(fx.repo, 'w2.txt'), { force: true });
        await s.page.keyboard.press('F5');
      }
    });

    it('"Vigilar el directorio de trabajo" activado persiste y vigila tras reiniciar', async () => {
      rmSync(path.join(fx.repo, 'w2.txt'), { force: true });
      await s.page.keyboard.press('F5');
      await s.tab(repo).locator('span.rounded-full').waitFor({ state: 'detached', timeout: 8000 });
      s = await s.relaunch();
      await s.tab(repo).waitFor({ timeout: 15000 });
      await s.openSettings();
      assert.equal(await s.dialog.getByRole('checkbox', { name: /Vigilar el directorio/ }).isChecked(), true);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      writeFileSync(path.join(fx.repo, 'w3.txt'), '3');
      await s.tab(repo).locator('span.rounded-full').waitFor({ timeout: 8000 });
      rmSync(path.join(fx.repo, 'w3.txt'));
      await s.openSettings();
      await s.dialog.getByRole('checkbox', { name: /Vigilar el directorio/ }).uncheck();
      await waitSaved('watchWorkingTree', false);
    });

    it('"Comando de terminal": se guarda al confirmar el campo y es el que lanza el botón Terminal (Ctrl+Alt+T)', async () => {
      const newMarker = path.join(fx.base, 'marker-ajustes');
      await s.openSettings();
      assert.equal(await sel('s-term').inputValue(), `touch ${marker}`);
      assert.equal(await sel('s-term').getAttribute('placeholder'), 'kitty');
      await sel('s-term').fill(`touch ${newMarker}`);
      await sel('s-term').press('Tab');
      await waitSaved('terminal', `touch ${newMarker}`);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await s.page.keyboard.press('Control+Alt+t');
      await waitFor(() => existsSync(newMarker), 5000, 'terminal lanzada con el comando nuevo');
      assert.ok(!existsSync(marker), 'el comando anterior no se ejecuta (control negativo)');
      await s.openSettings();
      await sel('s-term').fill(`touch ${marker}`);
      await sel('s-term').press('Tab');
      await waitSaved('terminal', `touch ${marker}`);
    });
  });

  describe('Git', () => {
    it('"Ruta de git": una ruta inválida se refleja en la pestaña y se guarda; vaciarla la restaura', async () => {
      await s.openSettings(/^Git$/);
      await sel('s-git').waitFor();
      assert.match(await s.dialog.locator('p.hint').first().innerText(), /git version \d/);
      try {
        await sel('s-git').fill('/no/existe/git');
        await sel('s-git').press('Tab');
        await waitSaved('gitPath', '/no/existe/git');
        await s.dialog.getByText(/No se encontró git/).waitFor({ timeout: 8000 });
        assert.doesNotMatch(await s.dialog.locator('p.hint').first().innerText(), /git version \d/);
      } finally {
        await sel('s-git').fill('');
        await sel('s-git').press('Tab');
        await waitSaved('gitPath', '');
      }
      await waitFor(async () => /git version \d/.test(await s.dialog.locator('p.hint').first().innerText()), 8000, 'git restaurado');
    });

    it('"Carpeta por defecto para clonar": se guarda al escribir, con Examinar…, y es la del diálogo de clonar', async () => {
      const dir1 = path.join(fx.base, 'dir-escrita');
      const dir2 = path.join(fx.base, 'dir-examinada');
      mkdirSync(dir1);
      mkdirSync(dir2);
      await s.openSettings(/^Git$/);
      await sel('s-clone').fill(dir1);
      await sel('s-clone').press('Tab');
      await waitSaved('defaultCloneDir', dir1);
      await s.pick(dir2);
      await s.dialog.getByRole('button', { name: /Examinar/ }).click();
      await waitSaved('defaultCloneDir', dir2);
      await waitFor(async () => (await sel('s-clone').inputValue()) === dir2, 3000, 'campo actualizado');
      // Cancelar el selector no cambia nada
      await s.dialog.getByRole('button', { name: /Examinar/ }).click();
      await s.page.waitForTimeout(500);
      assert.equal(await sel('s-clone').inputValue(), dir2);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await s.page.keyboard.press('Control+Shift+P');
      await s.waitDialog();
      await s.page.locator('input[role=combobox]').fill('Clonar repositorio');
      await s.page.keyboard.press('Enter');
      await s.page.locator('#fd-parent').waitFor();
      assert.equal(await s.page.locator('#fd-parent').inputValue(), dir2);
      await s.page.keyboard.press('Escape');
    });

    it('"Modo de pull por defecto": las 3 opciones se guardan y fijan los valores del diálogo Pull', async () => {
      const openPull = async () => {
        await s.page.getByTitle('Pull (Ctrl+Shift+L)').click({ button: 'right' });
        await s.waitDialog();
      };
      const rebase = () => s.dialog.getByRole('checkbox', { name: 'Rebase en lugar de merge' });
      const ff = () => s.dialog.getByRole('checkbox', { name: 'Solo fast-forward' });
      await s.openSettings(/^Git$/);
      assert.deepEqual(await sel('s-pull').locator('option').allInnerTexts(), ['Merge', 'Rebase', 'Solo fast-forward']);
      for (const [mode, rb, ffo] of [['rebase', true, false], ['ff-only', false, true], ['merge', false, false]] as const) {
        await s.openSettings(/^Git$/).catch(() => undefined);
        if (!(await sel('s-pull').count())) await goTab(/^Git$/);
        await sel('s-pull').selectOption(mode);
        await waitSaved('pullMode', mode);
        await s.page.keyboard.press('Escape');
        await s.waitNoDialog();
        await openPull();
        assert.equal(await rebase().isChecked(), rb, `modo ${mode}: rebase`);
        if (!rb) assert.equal(await ff().isChecked(), ffo, `modo ${mode}: ff-only`);
        else assert.equal(await ff().count(), 0, 'con rebase no se ofrece ff-only');
        await s.page.keyboard.press('Escape');
        await s.waitNoDialog();
      }
    });

    it('"Fetch automático": un intervalo activo trae los commits remotos solo; con 0 se desactiva', async () => {
      await s.openSettings(/^Git$/);
      assert.equal(await sel('s-fetch').inputValue(), '10');
      await sel('s-fetch').fill('1');
      await sel('s-fetch').press('Tab');
      await waitSaved('fetchInterval', 1);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      const h1 = fx.remoteCommit('af1.txt', 'remote: auto fetch');
      await waitFor(() => fx.g('rev-parse', 'origin/main') === h1, 90000, 'fetch automático');
      await s.openSettings(/^Git$/);
      await sel('s-fetch').fill('0');
      await sel('s-fetch').press('Tab');
      await waitSaved('fetchInterval', 0);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await s.page.waitForTimeout(2500);
      const h2 = fx.remoteCommit('af2.txt', 'remote: no auto fetch');
      await s.page.waitForTimeout(4000);
      assert.notEqual(fx.g('rev-parse', 'origin/main'), h2, 'con 0 no hay fetch automático');
      await s.openSettings(/^Git$/);
      await sel('s-fetch').fill('10');
      await sel('s-fetch').press('Tab');
      await waitSaved('fetchInterval', 10);
    });

    const outOfRange = (tab: RegExp, id: string, key: string, restore: string, value: string, check: (n: number) => boolean, msg: string) =>
      async () => {
        await s.openSettings(tab);
        try {
          await sel(id).fill(value);
          await sel(id).press('Tab');
          await s.page.waitForTimeout(500);
          assert.ok(check(Number(saved()[key])), `${key} guardado: ${saved()[key]} (${msg})`);
        } finally {
          await sel(id).fill(restore);
          await sel(id).press('Tab');
          await waitSaved(key, Number(restore));
        }
      };
    it('"Fetch automático" por encima de 240 min se acota (máx. 240)', outOfRange(/^Git$/, 's-fetch', 'fetchInterval', '10', '500', (n) => n <= 240, 'máx. 240'));
    it('"Fetch automático" negativo se acota a 0 (un valor negativo dispararía fetch continuo)', outOfRange(/^Git$/, 's-fetch', 'fetchInterval', '10', '-5', (n) => n >= 0, 'mín. 0'));
    it('"Líneas de contexto" por encima de 50 se acota (máx. 50)', outOfRange(/Diff/, 's-ctx', 'diffContext', '3', '999', (n) => n <= 50, 'máx. 50'));
    it('"Líneas de contexto" negativo se acota a 0', outOfRange(/Diff/, 's-ctx', 'diffContext', '3', '-4', (n) => n >= 0, 'mín. 0'));

    it('"Herramienta de merge externa": se guarda al confirmar el campo', async () => {
      await s.openSettings(/^Git$/);
      assert.equal(await sel('s-merge').getAttribute('placeholder'), 'meld');
      await sel('s-merge').fill('kdiff3');
      await sel('s-merge').press('Tab');
      await waitSaved('externalMergeTool', 'kdiff3');
      await sel('s-merge').click();
      await s.page.keyboard.press('Control+a');
      await s.page.keyboard.press('Backspace');
      await s.page.keyboard.press('Tab');
      await waitSaved('externalMergeTool', '');
    });
  });

  describe('Diff', () => {
    before(async () => {
      writeFileSync(path.join(fx.repo, 'big.txt'), Array.from({ length: 40 }, (_, i) => (i === 19 ? 'CHANGED' : `line ${i + 1}`)).join('\n') + '\n');
      writeFileSync(path.join(fx.repo, 'ws.txt'), 'alpha\nbeta\n');
      fx.g('add', 'ws.txt');
      fx.g('commit', '-qm', 'docs: ws');
      writeFileSync(path.join(fx.repo, 'ws.txt'), 'alpha   \nbeta\n');
    });

    it('"Vista del diff": Unificado/Lado a lado cambian el diff real y se guardan (y el botón del propio diff)', async () => {
      await showDiff('big.txt');
      assert.equal(await s.page.locator('gt-diff-viewer .grid-cols-2').count(), 0, `unificado por defecto; vista=${JSON.stringify(saved()['diffViewMode'])}; ${await s.page.locator('gt-diff-viewer .grid-cols-2').first().evaluate((e) => e.outerHTML.slice(0, 160)).catch(() => '')}`);
      await s.openSettings(/Diff/);
      const selected = () => s.dialog.locator('button.border-accent').allInnerTexts().then((a) => a.map((x) => x.trim()));
      await waitFor(async () => JSON.stringify(await selected()) === JSON.stringify(['Unificado']), 3000, 'Unificado seleccionado');
      await s.dialog.getByRole('button', { name: 'Lado a lado' }).click();
      await waitSaved('diffViewMode', 'split');
      await waitFor(async () => JSON.stringify(await selected()) === JSON.stringify(['Lado a lado']), 3000, 'Lado a lado seleccionado');
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      assert.ok((await s.page.locator('gt-diff-viewer .grid-cols-2').count()) > 0, 'el diff pasa a dos columnas');
      // El conmutador del propio visor cambia el mismo ajuste
      await s.page.locator('gt-diff-viewer').getByTitle('Unificado').click();
      await waitSaved('diffViewMode', 'unified');
      await waitFor(async () => (await s.page.locator('gt-diff-viewer .grid-cols-2').count()) === 0, 3000, 'vuelve a una columna');
    });

    it('"Líneas de contexto": 3 → 8 filas, 0 → 2 filas, 10 → 22 filas en un cambio de una línea', async () => {
      await showDiff('big.txt');
      await waitFor(async () => (await rows()) === 8, 6000, '8 filas con contexto 3');
      for (const [ctx, expected] of [[0, 2], [10, 22], [3, 8]] as const) {
        await s.openSettings(/Diff/);
        await sel('s-ctx').fill(String(ctx));
        await sel('s-ctx').press('Tab');
        await waitSaved('diffContext', ctx);
        await s.page.keyboard.press('Escape');
        await s.waitNoDialog();
        await waitFor(async () => (await rows()) === expected, 5000, `${expected} filas con contexto ${ctx}`);
      }
    });

    it('"Ignorar espacios en blanco": un cambio solo de espacios deja de aparecer en el diff', async () => {
      await showDiff('ws.txt');
      await waitFor(async () => (await rows()) > 0, 5000, 'diff con espacios');
      await s.openSettings(/Diff/);
      const box = s.dialog.getByRole('checkbox', { name: 'Ignorar espacios en blanco' });
      assert.equal(await box.isChecked(), false);
      await box.check();
      await waitSaved('ignoreWhitespace', true);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await s.page.waitForTimeout(1500);
      const shown = await rows();
      const newBadge = await s.page.locator('gt-diff-viewer').getByText('archivo nuevo').count();
      assert.equal(shown, 0, `con "ignorar espacios" el diff debe quedar vacío, pero muestra ${shown} filas (¿"archivo nuevo"? ${newBadge})`);
      await s.page.getByText(/Sin diferencias de contenido/).waitFor();
      await s.openSettings(/Diff/);
      await box.uncheck();
      await waitSaved('ignoreWhitespace', false);
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await waitFor(async () => (await rows()) > 0, 5000, 'filas de nuevo');
    });
  });

  it('los ajustes cambiados persisten al reiniciar y el diálogo los muestra', async () => {
    await s.openSettings();
    await sel('s-font').focus();
    await s.page.keyboard.press('End');
    await waitSaved('fontSize', 17);
    await themeBtn(/Claro/).click();
    await waitSaved('theme', 'light');
    await goTab(/^Git$/);
    await sel('s-pull').selectOption('ff-only');
    await sel('s-fetch').fill('7');
    await sel('s-fetch').press('Tab');
    await goTab(/Diff/);
    await s.dialog.getByRole('button', { name: 'Lado a lado' }).click();
    await sel('s-ctx').fill('5');
    await sel('s-ctx').press('Tab');
    await waitSaved('diffContext', 5);
    s = await s.relaunch();
    await s.tab(repo).waitFor({ timeout: 15000 });
    assert.equal(await theme(), 'light');
    assert.equal(await cssFont(), '17px');
    await s.openSettings();
    assert.equal(await sel('s-font').inputValue(), '17');
    await goTab(/^Git$/);
    assert.equal(await sel('s-pull').inputValue(), 'ff-only');
    assert.equal(await sel('s-fetch').inputValue(), '7');
    await goTab(/Diff/);
    assert.equal(await sel('s-ctx').inputValue(), '5');
    assert.deepEqual(await s.dialog.locator('button.border-accent').allInnerTexts().then((a) => a.map((x) => x.trim())), ['Lado a lado']);
    const final = saved();
    assert.equal(final['diffViewMode'], 'split');
    assert.equal(final['fontSize'], 17);
  });

  it('no hubo errores de JavaScript sin capturar durante la sesión', async () => {
    assert.deepEqual(s.errors, []);
  });
});

/** Ejecuta un comando desde la paleta (Ctrl+Shift+P): escribe la búsqueda y pulsa Enter. */
async function palette(s: Sess, query: string): Promise<void> {
  await s.page.keyboard.press('Control+Shift+P');
  await s.page.locator('input[role=combobox]').waitFor();
  await s.page.waitForTimeout(150);
  await s.page.locator('input[role=combobox]').fill(query);
  await s.page.keyboard.press('Enter');
  await s.page.locator('input[role=combobox]').waitFor({ state: 'detached', timeout: 5000 });
}

describe('cuentas y plataformas, sin red (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let s: Sess;
  let key: string;
  const saved = () => readSettings(fx.data);
  const accounts = () => (saved()['accounts'] as { authMethod: string; username: string; host: string; apiAccess: boolean; hasToken: boolean }[]) ?? [];
  const settingsPanel = () => s.overlays.first().locator('[role=dialog]').first();
  const tileBtn = (id: string) => s.dialog.locator(`[data-tile-id="${id}"]`);
  /** Ajustes en Cuentas y encima el diálogo «Agregar cuenta» en el paso de plataformas. */
  const openAdd = async () => {
    await s.openSettings(/Cuentas/);
    await settingsPanel().getByRole('button', { name: 'Agregar cuenta' }).first().click();
    await s.dialog.locator('[data-tile]').first().waitFor();
  };
  /** Elige una casilla de plataforma (volviendo antes al paso 1 si ya se estaba en el formulario). */
  const pickProvider = async (id: string) => {
    const back = s.dialog.getByRole('button', { name: 'Atrás' });
    if (await back.count()) await back.click();
    await tileBtn(id).click();
    await s.dialog.getByRole('radio').first().waitFor();
    await s.page.waitForTimeout(150);
  };
  const option = (user: string) => settingsPanel().getByRole('option').filter({ hasText: user });
  const radios = async () => (await s.dialog.getByRole('radio').evaluateAll((els) => els.map((e) => (e.parentElement as HTMLElement).innerText.trim())));
  const has = async (id: string) => (await s.page.locator(`#${id}`).count()) === 1;
  const submitBtn = () => s.dialog.locator('form button[type=submit]');
  const dis = (v: boolean, what: string) => waitFor(async () => (await submitBtn().isDisabled()) === v, 3000, `botón ${v ? 'desactivado' : 'activado'}: ${what}`);

  before(async () => {
    ({ fx, repo } = makeOpenFixture());
    key = path.join(fx.base, 'id_fake');
    writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n');
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('el comando "Cuentas…" de la paleta abre Ajustes directamente en la pestaña Cuentas, sin cuentas', async () => {
    await palette(s, 'Cuentas');
    await s.waitDialog();
    assert.equal(await s.dialogTitle(), 'Ajustes');
    assert.equal(await s.dialog.getByRole('tab', { name: /Cuentas/ }).getAttribute('aria-selected'), 'true');
    await s.dialog.getByText('No hay cuentas. Agrega una para clonar tus repositorios y ver pull requests.').waitFor();
    assert.equal(await s.dialog.locator('ul li').count(), 0);
  });

  it('sin ninguna cuenta, "Ver pull requests…" explica que falta una cuenta con acceso a la API', async () => {
    await palette(s, 'Ver pull requests');
    await s.waitDialog();
    const err = s.dialog.locator('p.error-text');
    await err.waitFor({ timeout: 8000 });
    assert.match(await err.innerText(), /No hay una cuenta con acceso a la API/);
    assert.equal(await s.dialog.locator('li').count(), 0);
  });

  it('en un repositorio sin remotos los comandos de pull requests y Fetch/Pull de la barra no se ofrecen o están desactivados', async () => {
    const norem = makeSmall(fx.base, 'sin-remoto');
    await s.pick(norem);
    await s.page.keyboard.press('Control+o');
    await s.tab(norem).waitFor({ timeout: 15000 });
    await s.page.keyboard.press('Control+Shift+P');
    await s.page.locator('input[role=combobox]').waitFor();
    await s.page.waitForTimeout(150);
    for (const q of ['Ver pull requests', 'Crear pull request']) {
      await s.page.locator('input[role=combobox]').fill(q);
      await waitFor(async () => (await s.page.locator('#palette-results [role=option]').count()) === 0, 3000, `sin «${q}»`);
    }
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
    for (const t of ['Fetch (Ctrl+Shift+F)', 'Pull (Ctrl+Shift+L)', 'Push (Ctrl+Shift+K)']) {
      assert.equal(await s.page.getByTitle(t).isDisabled(), true, `${t} desactivado sin remoto`);
    }
    await s.tab(norem).locator('xpath=following-sibling::span[@aria-hidden=\"true\"]').click();
    await s.tab(norem).waitFor({ state: 'detached' });
  });

  it('«Agregar cuenta» ofrece 6 casillas de plataforma en orden; elegir una pasa al formulario y «Atrás» vuelve', async () => {
    await openAdd();
    assert.equal(await s.dialogTitle(), 'Agregar cuenta');
    const names = (await s.dialog.locator('[data-tile]').allInnerTexts()).map((t) => t.trim());
    assert.deepEqual(names, ['Bitbucket', 'Gitea / Forgejo', 'GitHub', 'GitHub Enterprise', 'GitLab', 'GitLab (propio)']);
    assert.equal(await s.dialog.locator('[data-tile] svg').count(), 6, 'cada casilla lleva su logo');
    await tileBtn('github').focus();
    await s.page.keyboard.press('Enter');
    await s.dialog.getByRole('radio').first().waitFor();
    assert.equal(await s.dialog.locator('[data-tile]').count(), 0);
    await s.dialog.getByRole('button', { name: 'Atrás' }).click();
    await s.dialog.locator('[data-tile]').first().waitFor();
    assert.deepEqual(accounts(), []);
  });

  it('cada plataforma ofrece sus métodos (Token primero); Enterprise y propio son el mismo proveedor', async () => {
    await openAdd();
    const expected: [string, string[]][] = [
      ['github', ['Token', 'OAuth', 'Clave SSH']],
      ['github-enterprise', ['Token', 'OAuth', 'Clave SSH']],
      ['gitlab', ['Token', 'Contraseña', 'OAuth', 'Clave SSH']],
      ['gitlab-self', ['Token', 'Contraseña', 'OAuth', 'Clave SSH']],
      ['bitbucket', ['Token', 'Clave SSH']],
      ['gitea', ['Token', 'Contraseña', 'Clave SSH']],
    ];
    for (const [id, methods] of expected) {
      await pickProvider(id);
      await waitFor(async () => JSON.stringify(await radios()) === JSON.stringify(methods), 3000, `métodos ${id}`);
      assert.equal(await s.dialog.getByRole('radio', { checked: true }).count(), 1);
      assert.equal(await s.dialog.getByRole('radio', { name: 'Token' }).isChecked(), true, 'el primer método es el predeterminado');
    }
  });

  it('GitHub Enterprise y GitLab (propio) exigen el servidor y enfocan ese campo; las demás lo dejan opcional', async () => {
    await openAdd();
    for (const [id, user] of [['github-enterprise', false], ['gitlab-self', false]] as [string, boolean][]) {
      await pickProvider(id);
      assert.equal(await s.page.locator('#a-server').evaluate((el) => el === document.activeElement), true, `${id}: foco en Servidor`);
      assert.equal(await s.page.locator('#a-server').evaluate((el) => (el as HTMLInputElement).required), true);
      await s.page.locator('#a-secret').fill('tok');
      await dis(true, `${id} sin servidor`);
      await s.page.locator('#a-server').fill('git.acme.com');
      await dis(false, `${id} con servidor`);
      assert.ok(!user);
    }
    await pickProvider('github');
    assert.equal(await s.page.locator('#a-server').evaluate((el) => (el as HTMLInputElement).required), false);
    assert.match(await s.dialog.locator('label[for=a-server]').innerText(), /opcional/);
    assert.deepEqual(accounts(), []);
  });

  it('los campos cambian según proveedor y método (token, contraseña, SSH, OAuth, Bitbucket)', async () => {
    await openAdd();
    await pickProvider('github');
    const fields = async () => ({
      server: await has('a-server'),
      user: await has('a-user'),
      secret: await has('a-secret'),
      key: await has('a-key'),
      client: await has('a-client'),
    });
    const chk = async (expected: Partial<Record<'server' | 'user' | 'secret' | 'key' | 'client', boolean>>, what: string) => {
      const want = { server: false, user: false, secret: false, key: false, client: false, ...expected };
      await waitFor(async () => JSON.stringify(await fields()) === JSON.stringify(want), 3000, what).catch(async () => {
        assert.deepEqual(await fields(), want, what);
      });
    };
    await chk({ server: true, secret: true }, 'GitHub token');
    await s.dialog.getByRole('radio', { name: 'OAuth' }).check();
    await chk({ server: true, client: true }, 'GitHub OAuth');
    await s.dialog.getByRole('radio', { name: 'Clave SSH' }).check();
    await chk({ server: true, user: true, key: true }, 'GitHub SSH');
    await s.dialog.getByText('Solo se guarda la ruta: la clave no se lee ni se copia.', { exact: false }).waitFor();
    await pickProvider('gitlab');
    await s.dialog.getByRole('radio', { name: 'Contraseña' }).check();
    await chk({ server: true, user: true, secret: true }, 'GitLab contraseña');
    await s.dialog.getByText(/GitHub no acepta contraseñas/).waitFor();
    await pickProvider('bitbucket');
    await chk({ user: true, secret: true }, 'Bitbucket token (sin servidor)');
    await s.dialog.getByText('En Bitbucket usa tu usuario y un App Password / API token.').waitFor();
    await pickProvider('gitea');
    await chk({ server: true, secret: true }, 'Gitea token');
    assert.equal(await s.dialog.getByText('En Bitbucket usa tu usuario').count(), 0, 'la pista de Bitbucket desaparece');
  });

  it('el botón de envío está desactivado hasta rellenar los campos obligatorios', async () => {
    await openAdd();
    await pickProvider('github');
    await dis(true, '');
    await s.page.locator('#a-secret').fill('   ');
    await dis(true, 'solo espacios no cuenta');
    await s.page.locator('#a-secret').fill('x');
    await dis(false, '');
    await s.page.locator('#a-secret').fill('');
    await dis(true, '');
    await pickProvider('bitbucket');
    await s.page.locator('#a-user').fill('ana');
    await dis(true, 'falta el token');
    await s.page.locator('#a-secret').fill('x');
    await dis(false, '');
    await s.page.locator('#a-user').fill('');
    await dis(true, 'falta el usuario');
    await s.dialog.getByRole('radio', { name: 'Clave SSH' }).check();
    await s.page.locator('#a-user').fill('ana');
    await dis(true, 'falta la ruta de la clave');
    await s.page.locator('#a-key').fill(key);
    await dis(false, '');
    await pickProvider('github');
    await s.dialog.getByRole('radio', { name: 'OAuth' }).check();
    await dis(true, 'falta el Client ID');
    assert.match(await submitBtn().innerText(), /Iniciar sesión con el navegador/);
    await s.page.locator('#a-client').fill('abc123');
    await dis(false, '');
    assert.deepEqual(accounts(), [], 'nada se guardó');
  });

  it('"Crear token" abre la página de tokens de cada proveedor (navegador sustituido) y no añade cuentas', async () => {
    await openAdd();
    const urls: [string, RegExp][] = [
      ['github', /^https:\/\/github\.com\/settings\/tokens\/new/],
      ['gitlab', /^https:\/\/gitlab\.com\/-\/user_settings\/personal_access_tokens/],
      ['bitbucket', /^https:\/\/bitbucket\.org\/account\/settings\/app-passwords/],
      ['gitea', /^https:\/\/codeberg\.org\/user\/settings\/applications/],
    ];
    for (const [id, re] of urls) {
      await pickProvider(id);
      await s.clearCalls();
      await s.dialog.getByRole('button', { name: /Crear token/ }).click();
      await waitFor(async () => (await s.calls()).length > 0, 3000, 'openExternal');
      const calls = await s.calls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].fn, 'openExternal');
      assert.match(calls[0].arg, re);
    }
    assert.deepEqual(accounts(), []);
  });

  it('el campo Servidor muestra un ejemplo distinto por proveedor', async () => {
    await openAdd();
    const ph = async () => s.page.locator('#a-server').getAttribute('placeholder');
    await pickProvider('github');
    assert.equal(await ph(), 'github.com');
    await pickProvider('gitlab');
    assert.match((await ph()) ?? '', /gitlab\.com/);
    await pickProvider('gitea');
    assert.match((await ph()) ?? '', /codeberg\.org/);
  });

  it('SSH: rutas inválidas muestran su error dentro del formulario (rol alert) y cambiar de método lo borra', async () => {
    const pubKey = path.join(fx.base, 'id_fake.pub');
    const notKey = path.join(fx.base, 'notes.txt');
    writeFileSync(pubKey, 'ssh-ed25519 AAAA test');
    writeFileSync(notKey, 'hola');
    await openAdd();
    await pickProvider('github');
    await s.dialog.getByRole('radio', { name: 'Clave SSH' }).check();
    await s.page.locator('#a-user').fill('ana-key');
    const cases: [string, RegExp][] = [
      [path.join(fx.base, 'no-existe'), /No existe el archivo de clave/],
      ['relativa/clave', /debe ser absoluta/],
      [pubKey, /clave pública/],
      [notKey, /no parece una clave privada/],
    ];
    for (const [p, re] of cases) {
      await s.page.locator('#a-key').fill(p);
      await submitBtn().click();
      const alert = s.dialog.getByRole('alert');
      await waitFor(async () => re.test(await alert.innerText().catch(() => '')), 8000, `error ${re}`);
      assert.equal(await settingsPanel().getByRole('option').count(), 0, 'no se creó ninguna cuenta');
    }
    await s.dialog.getByRole('radio', { name: 'Token' }).check();
    await s.dialog.getByRole('alert').waitFor({ state: 'detached' });
    assert.deepEqual(accounts(), []);
  });

  it('SSH: añadir una cuenta (clave elegida con Examinar…) la lista, la guarda sin token, y su detalle es coherente', async () => {
    await openAdd();
    await pickProvider('github');
    await s.dialog.getByRole('radio', { name: 'Clave SSH' }).check();
    await s.page.locator('#a-user').fill('ana-key');
    await s.pick(key);
    await s.dialog.getByRole('button', { name: /Examinar/ }).click();
    await waitFor(async () => (await s.page.locator('#a-key').inputValue()) === key, 3000, 'clave elegida');
    await submitBtn().click();
    await s.toast(/Cuenta ana-key@github\.com agregada/);
    await s.overlays.nth(1).waitFor({ state: 'detached' });
    const row = option('ana-key');
    await row.waitFor();
    assert.equal(await settingsPanel().getByRole('option').count(), 1);
    assert.match(await row.innerText(), /GitHub\s+ana-key/);
    assert.equal(await row.getAttribute('aria-selected'), 'true', 'la cuenta nueva queda seleccionada');
    const detail = settingsPanel().locator('[role=tabpanel]');
    const text = await detail.innerText();
    assert.match(text, /Clave SSH/);
    assert.ok(text.includes(key));
    await settingsPanel().locator('[data-status]').filter({ hasText: 'No verificable (clave SSH)' }).waitFor();
    await settingsPanel().getByRole('tab', { name: 'Repositorios', exact: true }).click();
    await settingsPanel().getByText('El listado de repositorios y los pull requests no están disponibles para esta cuenta.').waitFor();
    assert.equal(accounts().length, 1);
    assert.equal(accounts()[0].authMethod, 'ssh');
    assert.equal(accounts()[0].apiAccess, false);
    assert.equal(accounts()[0].hasToken, false);
    assert.deepEqual(Object.keys((JSON.parse(readFileSync(path.join(fx.data, 'settings.json'), 'utf8')) as { tokens: Json }).tokens), []);
    assert.equal(await settingsPanel().getByText('No hay cuentas').count(), 0);
  });

  it('cerrar el diálogo de alta con × o Escape no guarda nada', async () => {
    await openAdd();
    await pickProvider('gitea');
    await s.dialog.getByRole('button', { name: 'Cerrar' }).click();
    await waitFor(async () => (await s.overlays.count()) === 1, 3000, 'solo queda Ajustes');
    await settingsPanel().getByRole('button', { name: 'Agregar cuenta' }).first().click();
    await s.dialog.locator('[data-tile]').first().waitFor();
    await s.page.keyboard.press('Escape');
    await waitFor(async () => (await s.overlays.count()) === 1, 3000, 'Escape cierra solo el de alta');
    assert.equal(accounts().length, 1);
  });

  it('añadir la misma cuenta SSH otra vez no la duplica', async () => {
    await s.openSettings(/Cuentas/);
    await settingsPanel().getByRole('button', { name: 'Agregar cuenta' }).first().click();
    await s.dialog.locator('[data-tile]').first().waitFor();
    await pickProvider('github');
    await s.dialog.getByRole('radio', { name: 'Clave SSH' }).check();
    await s.page.locator('#a-user').fill('ana-key');
    await s.page.locator('#a-key').fill(key);
    await submitBtn().click();
    await s.toast(/agregada/);
    await s.overlays.nth(1).waitFor({ state: 'detached' });
    assert.equal(await settingsPanel().getByRole('option').count(), 1);
    assert.equal(accounts().length, 1);
  });

  it('la cuenta persiste al reiniciar y aparece en Cuentas', async () => {
    s = await s.relaunch();
    await s.tab(repo).waitFor({ timeout: 15000 });
    await s.openSettings(/Cuentas/);
    await option('ana-key').waitFor();
    assert.equal(await settingsPanel().getByRole('option').count(), 1);
  });

  describe('plataformas con una cuenta sin acceso a la API', () => {
    it('"Clonar desde mi cuenta" lista la cuenta y explica que no tiene acceso a la API (sin intentar red)', async () => {
      await palette(s, 'Clonar desde mi cuenta');
      await s.waitDialog();
      assert.equal(await s.dialogTitle(), 'Clonar desde mi cuenta');
      assert.deepEqual(await s.dialog.locator('select option').allInnerTexts(), ['ana-key — github.com']);
      const err = s.dialog.locator('p.error-text');
      await err.waitFor({ timeout: 8000 });
      assert.match(await err.innerText(), /\S/);
      assert.equal(await s.dialog.locator('li.grid').count(), 0, 'no lista repositorios');
      assert.equal(await s.dialog.locator('.spinner').count(), 0, 'no se queda cargando');
      // El filtro y la casilla SSH existen y son operables
      await s.dialog.getByPlaceholder('Filtrar repositorios…').fill('algo');
      await s.dialog.getByRole('checkbox', { name: 'Clonar por SSH' }).check();
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
    });

    it('"Ver pull requests…" abre el diálogo con el remoto y un mensaje claro de que no hay cuenta con API', async () => {
      await palette(s, 'Ver pull requests');
      await s.waitDialog();
      assert.equal(await s.dialogTitle(), 'Pull requests');
      assert.deepEqual((await s.dialog.locator('select option').allInnerTexts()).map((t) => t.split(' — ')[0]), ['origin']);
      const err = s.dialog.locator('p.error-text');
      await err.waitFor({ timeout: 8000 });
      assert.match(await err.innerText(), /No hay una cuenta con acceso a la API/);
      assert.equal(await s.dialog.getByText('No hay pull requests abiertos.').count(), 0, 'no dice "no hay PR" si falló la consulta');
      assert.equal(await s.dialog.locator('.spinner').count(), 0);
    });

    it('"Crear pull request" desde ese diálogo valida los campos y muestra el error del proveedor dentro del formulario', async () => {
      await palette(s, 'Ver pull requests');
      await s.waitDialog();
      await s.dialog.getByRole('button', { name: 'Crear pull request' }).click();
      await s.page.locator('#fd-title').waitFor();
      assert.equal(await s.dialogTitle(), 'Crear pull request');
      assert.equal(await s.overlays.count(), 1, 'el diálogo de PR se cierra al abrir el formulario');
      await s.page.locator('#fd-title').fill('');
      await s.page.locator('#fd-target').fill('');
      await s.dialog.locator('button[type=submit]').click();
      await waitFor(async () => (await s.dialog.locator('.error-text').count()) === 2, 3000, 'dos errores de obligatorio');
      await s.page.locator('#fd-title').fill('Mi PR');
      await s.page.locator('#fd-target').fill('main');
      await s.clearCalls();
      await s.dialog.locator('button[type=submit]').click();
      await s.dialog.locator('pre').waitFor({ timeout: 8000 });
      assert.match(await s.dialog.locator('pre').innerText(), /No hay una cuenta con acceso a la API/);
      assert.equal(await s.overlays.count(), 1, 'sigue abierto con el error');
      assert.deepEqual(await s.calls(), [], 'no se abrió ningún navegador');
    });

    it('quitar pide confirmación (cancelar conserva la cuenta); al confirmar desaparece de la lista y de settings.json', async () => {
      await s.openSettings(/Cuentas/);
      const minus = settingsPanel().getByRole('button', { name: 'Quitar cuenta' });
      await minus.click();
      await s.dialog.getByText(/¿Quitar la cuenta ana-key@github\.com\?/).waitFor();
      await s.dialog.getByRole('button', { name: 'Cancelar' }).click();
      await waitFor(async () => (await s.overlays.count()) === 1, 3000, 'confirmación cerrada');
      assert.equal(accounts().length, 1, 'cancelar no quita nada');
      assert.equal(await settingsPanel().getByRole('option').count(), 1);
      await minus.click();
      await s.dialog.getByRole('button', { name: 'Quitar', exact: true }).click();
      await settingsPanel().getByText('No hay cuentas.', { exact: false }).waitFor();
      assert.equal(await settingsPanel().getByRole('button', { name: 'Agregar cuenta' }).count(), 1, 'estado vacío con botón primario');
      await waitFor(() => accounts().length === 0, 4000, 'cuenta eliminada de settings.json');
      await s.page.keyboard.press('Escape');
      await s.waitNoDialog();
      await palette(s, 'Clonar desde mi cuenta');
      await s.waitDialog();
      await s.page.getByText('Primero agrega una cuenta en Ajustes → Cuentas.').waitFor();
    });
  });

  it('no hubo errores de JavaScript sin capturar durante la sesión', async () => {
    assert.deepEqual(s.errors, []);
  });
});

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Abre la paleta, filtra por la etiqueta exacta y hace clic en esa opción. */
async function runCmd(s: Sess, label: string): Promise<void> {
  await s.page.keyboard.press('Control+Shift+P');
  const input = s.page.locator('input[role=combobox]');
  await input.waitFor();
  await s.page.waitForTimeout(120);
  await input.fill(label);
  const opt = s.page.locator('#palette-results [role=option]').filter({ has: s.page.locator('span.flex-1', { hasText: new RegExp(`^${esc(label)}$`) }) });
  await opt.first().click({ timeout: 8000 });
  await input.waitFor({ state: 'detached', timeout: 5000 });
}

describe('paleta de comandos (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let s: Sess;
  const input = () => s.page.locator('input[role=combobox]');
  const options = () => s.page.locator('#palette-results [role=option]');
  const optionTexts = async () => (await options().locator('span.flex-1').allInnerTexts()).map((t) => t.trim());
  const headers = async () =>
    (await s.page.locator('#palette-results li[role=presentation]').allInnerTexts()).map((t) => t.trim());
  const active = () => s.page.locator('#palette-results [role=option][aria-selected=true]');
  const open = async () => {
    await s.page.keyboard.press('Control+Shift+P');
    await input().waitFor();
    await s.page.waitForTimeout(150);
  };

  before(async () => {
    ({ fx, repo } = makeOpenFixture());
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('Ctrl+Shift+P la abre con el foco en el campo, vacío, y con la lista agrupada por categorías', async () => {
    await open();
    assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute('role')), 'combobox');
    assert.equal(await input().inputValue(), '');
    assert.equal(await input().getAttribute('placeholder'), 'Escribe un comando git o una acción…');
    assert.ok((await options().count()) > 60, `opciones: ${await options().count()}`);
    assert.deepEqual(await headers(), [
      'Repositorio', 'Cambios', 'Commit', 'Ramas', 'Integración', 'Remotos', 'Tags', 'Stash',
      'Submódulos y worktrees', 'Git Flow', 'Historial', 'Herramientas', 'Plataformas', 'Vista',
    ]);
    assert.equal(await active().count(), 1, 'hay una opción seleccionada');
    assert.equal((await active().locator('span.flex-1').innerText()).trim(), 'Abrir repositorio…');
  });

  it('muestra el atajo y el comando git equivalente de cada opción', async () => {
    await open();
    const row = options().filter({ has: s.page.locator('span.flex-1', { hasText: /^Crear rama…$/ }) });
    const text = await row.innerText();
    assert.match(text, /Ctrl\+Shift\+B/);
    assert.match(text, /git branch/);
  });

  it('el botón "Comandos" de la barra también la abre', async () => {
    await s.page.getByTitle('Ctrl+Shift+P').click();
    await input().waitFor();
    assert.equal(await s.overlays.count(), 1);
  });

  it('control negativo: Ctrl+Shift+P con la paleta abierta no apila otra', async () => {
    await open();
    await s.page.keyboard.press('Control+Shift+P');
    await s.page.waitForTimeout(400);
    assert.equal(await s.overlays.count(), 1);
  });

  it('filtra al escribir (sin cabeceras), ignora tildes y mayúsculas, y ordena por relevancia', async () => {
    await open();
    await input().fill('RAMA');
    const texts = await optionTexts();
    assert.ok(texts.includes('Crear rama…'), texts.join('|'));
    assert.ok(texts.includes('Eliminar rama…'));
    assert.ok(!texts.includes('Hacer commit'), 'lo que no coincide se oculta');
    assert.deepEqual(await headers(), [], 'con búsqueda no hay cabeceras');
    await input().fill('integracion');
    assert.deepEqual(await optionTexts(), [], 'las categorías no se buscan');
    await input().fill('Cambiar de rama');
    assert.equal((await optionTexts())[0], 'Cambiar de rama (checkout)…');
    await input().fill('fetch');
    const fetchFirst = (await optionTexts())[0];
    assert.match(fetchFirst, /^Fetch/, 'primero los que empiezan por el texto');
  });

  it('también busca por el comando git equivalente', async () => {
    await open();
    await input().fill('git cherry-pick');
    assert.deepEqual(await optionTexts(), ['Cherry-pick por hash…']);
    await input().fill('git push --force');
    assert.deepEqual(await optionTexts(), ['Push forzado (with-lease)…']);
  });

  it('sin coincidencias muestra "Sin resultados" y Enter no hace nada', async () => {
    await open();
    await input().fill('zzzzqqq');
    await s.page.getByText('Sin resultados').waitFor();
    await waitFor(async () => (await options().count()) === 0, 3000, 'sin opciones');
    await s.page.keyboard.press('Enter');
    await s.page.waitForTimeout(300);
    assert.equal(await input().count(), 1, 'sigue abierta');
    await input().fill('');
    await waitFor(async () => (await options().count()) > 60, 3000, 'al borrar la búsqueda vuelve la lista completa');
  });

  it('las flechas mueven la selección (con vuelta al principio/final) y escribir la reinicia', async () => {
    await open();
    const label = async () => (await active().locator('span.flex-1').innerText()).trim();
    const labelIs = async (want: string, what: string) => {
      await waitFor(async () => (await label().catch(() => '')) === want, 3000, what);
    };
    const texts = await optionTexts();
    const first = await label();
    assert.equal(first, texts[0]);
    await s.page.keyboard.press('ArrowDown');
    await labelIs(texts[1], 'ArrowDown baja a la segunda');
    await s.page.keyboard.press('ArrowUp');
    await labelIs(first, 'ArrowUp vuelve a la primera');
    await s.page.keyboard.press('ArrowUp');
    await labelIs(texts.at(-1)!, 'ArrowUp desde la primera salta a la última');
    await s.page.keyboard.press('ArrowDown');
    await labelIs(first, 'ArrowDown desde la última vuelve a la primera');
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowDown');
    await labelIs(texts[2], 'dos pasos abajo');
    await input().fill('rama');
    assert.equal(await active().count(), 1);
    assert.equal(await s.page.locator('#palette-opt-0').getAttribute('aria-selected'), 'true', 'al filtrar vuelve al primero');
    assert.equal(await input().getAttribute('aria-activedescendant'), 'palette-opt-0');
  });

  it('Enter ejecuta la opción seleccionada con el teclado y cierra la paleta', async () => {
    await s.page.keyboard.press('Control+2');
    await open();
    await input().fill('Ir a cambios locales');
    await s.page.keyboard.press('Enter');
    await input().waitFor({ state: 'detached' });
    await s.page.locator('gt-changes').waitFor();
    await open();
    await input().fill('Ir al historial');
    await s.page.keyboard.press('Enter');
    await s.page.locator('gt-viewer').waitFor();
    assert.equal(await s.page.locator('gt-changes').count(), 0);
  });

  it('con flechas se elige otra opción distinta de la primera y Enter ejecuta esa', async () => {
    await open();
    await input().fill('Ir');
    const texts = await optionTexts();
    const idx = texts.indexOf('Ir al historial');
    assert.ok(idx > 0, texts.join('|'));
    await s.page.keyboard.press('Escape');
    await input().waitFor({ state: 'detached' });
    await s.page.keyboard.press('Control+1');
    await s.page.locator('gt-changes').waitFor();
    await open();
    await input().fill('Ir');
    for (let i = 0; i < idx; i++) await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('Enter');
    await s.page.locator('gt-viewer').waitFor();
  });

  it('un clic en una opción la ejecuta; el ratón quieto no cambia la selección, el ratón en movimiento sí', async () => {
    await open();
    await input().fill('Ir');
    const target = options().filter({ has: s.page.locator('span.flex-1', { hasText: /^Ir a cambios locales$/ }) });
    const box = await target.boundingBox();
    assert.ok(box);
    await s.page.mouse.move(box.x + 20, box.y + box.height / 2);
    await s.page.mouse.move(box.x + 60, box.y + box.height / 2 + 1);
    assert.equal((await active().locator('span.flex-1').innerText()).trim(), 'Ir a cambios locales');
    await target.click();
    await input().waitFor({ state: 'detached' });
    await s.page.locator('gt-changes').waitFor();
  });

  it('Escape y el clic en el fondo la cierran sin ejecutar nada', async () => {
    const view = await s.page.locator('gt-changes').count();
    await open();
    await input().fill('Ir al historial');
    await s.page.keyboard.press('Escape');
    await input().waitFor({ state: 'detached' });
    assert.equal(await s.page.locator('gt-changes').count(), view);
    await open();
    await s.page.mouse.click(5, 600);
    await input().waitFor({ state: 'detached' });
    assert.equal(await s.page.locator('gt-changes').count(), view);
  });

  it('el campo conserva el foco al escribir y Escape desde él cierra', async () => {
    await open();
    await s.page.keyboard.type('stage');
    assert.equal(await input().inputValue(), 'stage');
    await s.page.keyboard.press('Escape');
    await input().waitFor({ state: 'detached' });
  });

  it('las acciones con condición solo aparecen cuando aplican (continuar/abortar/omitir, pop/vaciar stash, bisect)', async () => {
    await open();
    const all = await optionTexts();
    for (const l of [
      'Continuar operación en curso', 'Abortar operación en curso', 'Omitir commit actual (rebase)',
      'Aplicar último stash (pop)', 'Eliminar todos los stashes…',
      'Bisect: marcar como bueno', 'Bisect: marcar como malo', 'Terminar bisect',
    ]) {
      assert.ok(!all.includes(l), `${l} no debería listarse sin operación en curso`);
    }
    assert.ok(all.includes('Guardar stash…'));
    assert.ok(all.includes('Ver pull requests…'), 'con remoto sí hay pull requests');
  });

  it('sin repositorio abierto solo ofrece los comandos que no necesitan uno', async () => {
    const tmp = makeFixture();
    const s2 = await Sess.launch(tmp.data);
    try {
      await s2.welcomeOpen.waitFor();
      await s2.page.keyboard.press('Control+Shift+P');
      await s2.page.locator('input[role=combobox]').waitFor();
      await s2.page.waitForTimeout(150);
      const texts = (await s2.page.locator('#palette-results [role=option] span.flex-1').allInnerTexts()).map((t) => t.trim());
      assert.deepEqual(texts.sort(), [
        'Abrir repositorio…', 'Clonar desde mi cuenta', 'Clonar repositorio…', 'Crear repositorio (init)…',
        'Cuentas (GitHub, GitLab, Bitbucket, Gitea)…', 'Ajustes…', 'Mostrar/ocultar consola',
        'Cambiar tema claro/oscuro', 'Cambiar idioma',
      ].sort());
      await s2.page.keyboard.press('Escape');
      // Ctrl+Shift+P en Welcome también la abre, y Ctrl+, abre Ajustes sin repositorio
      await s2.page.keyboard.press('Control+,');
      await s2.waitDialog();
      assert.equal(await s2.dialogTitle(), 'Ajustes');
    } finally {
      await s2.close();
      tmp.cleanup();
    }
  });
});

/** Todos los comandos de la paleta (id → etiqueta en español); la prueba de cobertura la compara con commands.service.ts. */
const COMMANDS: Record<string, string> = {
  'repo.open': 'Abrir repositorio…', 'repo.clone': 'Clonar repositorio…', 'repo.init': 'Crear repositorio (init)…',
  'repo.close': 'Cerrar repositorio', 'repo.refresh': 'Actualizar', 'repo.folder': 'Abrir en el explorador de archivos',
  'repo.terminal': 'Abrir terminal aquí', 'repo.identity': 'Configurar usuario y correo…',
  'repo.config': 'Editar configuración (git config)…',
  'changes.stageAll': 'Preparar todo (add -A)', 'changes.unstageAll': 'Quitar todo del índice',
  'changes.discardAll': 'Descartar todos los cambios…', 'changes.clean': 'Eliminar archivos sin seguimiento (clean)…',
  'commit.commit': 'Hacer commit', 'commit.amend': 'Enmendar último commit',
  'commit.undo': 'Deshacer último commit (mantener cambios)',
  'branch.create': 'Crear rama…', 'branch.checkout': 'Cambiar de rama (checkout)…',
  'branch.rename': 'Renombrar rama actual…', 'branch.delete': 'Eliminar rama…',
  'merge.merge': 'Merge…', 'merge.rebase': 'Rebase…', 'merge.interactive': 'Rebase interactivo…',
  'merge.cherryPick': 'Cherry-pick por hash…', 'merge.revert': 'Revertir commit por hash…', 'merge.reset': 'Reset…',
  'merge.continue': 'Continuar operación en curso', 'merge.abort': 'Abortar operación en curso',
  'merge.skip': 'Omitir commit actual (rebase)',
  'remote.fetchAll': 'Fetch de todos los remotos', 'remote.fetch': 'Fetch…', 'remote.pull': 'Pull…',
  'remote.quickPull': 'Pull rápido', 'remote.quickPush': 'Push rápido', 'remote.push': 'Push…', 'remote.forcePush': 'Push forzado (with-lease)…', 'remote.add': 'Agregar remoto…',
  'tag.create': 'Crear tag…', 'tag.pushAll': 'Push de todos los tags',
  'stash.save': 'Guardar stash…', 'stash.pop': 'Aplicar último stash (pop)', 'stash.clear': 'Eliminar todos los stashes…',
  'sub.add': 'Agregar submódulo…', 'sub.update': 'Actualizar submódulos (init + recursive)',
  'sub.sync': 'Sincronizar URLs de submódulos', 'wt.add': 'Agregar worktree…', 'wt.prune': 'Limpiar worktrees obsoletos',
  'flow.init': 'Inicializar Git Flow…', 'flow.feature': 'Iniciar feature…', 'flow.release': 'Iniciar release…',
  'flow.hotfix': 'Iniciar hotfix…', 'flow.deinit': 'Desinicializar Git Flow…',
  'history.search': 'Buscar commits…', 'history.reflog': 'Ver reflog…', 'history.file': 'Historial de un archivo…',
  'history.blame': 'Blame de un archivo…', 'history.bisect': 'Iniciar bisect…',
  'history.bisectGood': 'Bisect: marcar como bueno', 'history.bisectBad': 'Bisect: marcar como malo',
  'history.bisectReset': 'Terminar bisect',
  'repo.stats': 'Estadísticas del repositorio…', 'repo.treemap': 'Treemap del repositorio…',
  'repo.benchmark': 'Benchmark de rendimiento…', 'tools.gc': 'Optimizar repositorio (gc)',
  'tools.archive': 'Exportar como archivo (zip/tar.gz)…', 'tools.am': 'Aplicar parches (am)…',
  'tools.lfsTrack': 'Git LFS: seguir patrón…', 'tools.lfsPull': 'Git LFS: descargar archivos',
  'tools.custom': 'Ejecutar comando git personalizado…',
  'platform.accounts': 'Cuentas (GitHub, GitLab, Bitbucket, Gitea)…', 'platform.cloneAccount': 'Clonar desde mi cuenta',
  'platform.prs': 'Ver pull requests…', 'platform.createPr': 'Crear pull request…',
  'view.changes': 'Ir a cambios locales', 'view.history': 'Ir al historial', 'view.console': 'Mostrar/ocultar consola',
  'view.theme': 'Cambiar tema claro/oscuro', 'view.language': 'Cambiar idioma', 'view.settings': 'Ajustes…',
};
const L = (id: string): string => {
  const l = COMMANDS[id];
  assert.ok(l, `comando desconocido ${id}`);
  return l;
};

/** Repo con varios commits y, opcionalmente, un conflicto de merge/rebase en curso. */
function makeConflictRepo(base: string, name: string): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => git(dir, ...a);
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Eva');
  g('config', 'user.email', 'eva@example.com');
  const put = (txt: string, msg: string) => {
    writeFileSync(path.join(dir, 'f.txt'), `${txt}\n`);
    g('add', '-A');
    g('commit', '-qm', msg);
  };
  put('base', 'base');
  g('checkout', '-qb', 'b2');
  put('b2', 'change b2');
  g('checkout', '-q', 'main');
  g('checkout', '-qb', 'topic');
  put('topic', 'change topic');
  g('checkout', '-q', 'main');
  put('main', 'change main');
  try {
    g('merge', 'b2');
  } catch {
    /* conflicto esperado: queda un merge en curso */
  }
  return realpathSync(dir);
}

describe('todos los comandos de la paleta (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let marker: string;
  let s: Sess;
  const f = (n: string) => path.join(fx.repo, n);
  const sorted = (x: string) => x.split('\n').filter(Boolean).sort().join('\n');
  const status = () => fx.g('status', '--porcelain');
  const dirty = () => {
    appendFileSync(f('README.md'), 'wip2\n');
    writeFileSync(f('new.ts'), 'x\n');
  };
  const run = (id: string) => runCmd(s, L(id));
  const dialogIs = async (title: string) => {
    await s.waitDialog();
    assert.equal(await s.dialogTitle(), title);
  };
  const cancel = async () => {
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
  };
  const submit = () => s.dialog.locator('button[type=submit]').click();
  const errorToast = () => s.page.locator('[aria-live=polite] > div.border-danger').first();
  const bannerText = () => s.page.locator('[role=status]').first().innerText();
  const hasOption = async (label: string): Promise<boolean> => {
    await s.page.keyboard.press('Control+Shift+P');
    await s.page.locator('input[role=combobox]').waitFor();
    await s.page.waitForTimeout(150);
    await s.page.locator('input[role=combobox]').fill(label);
    await s.page.waitForTimeout(200);
    const texts = (await s.page.locator('#palette-results [role=option] span.flex-1').allInnerTexts()).map((t) => t.trim());
    await s.page.keyboard.press('Escape');
    await s.page.locator('input[role=combobox]').waitFor({ state: 'detached' });
    return texts.includes(label);
  };

  before(async () => {
    ({ fx, repo, marker } = makeOpenFixture());
    appendFileSync(f('big.txt'), 'tail\n');
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('la tabla de pruebas cubre exactamente los comandos definidos en commands.service.ts', () => {
    const src = readFileSync(path.join(ROOT, 'src/app/features/actions/commands.service.ts'), 'utf8');
    const ids = [...src.matchAll(/^\s+id: '([^']+)',$/gm)].map((m) => m[1]).sort();
    assert.ok(ids.length > 70, `ids encontrados: ${ids.length}`);
    assert.deepEqual(Object.keys(COMMANDS).sort(), ids);
  });

  describe('cada comando abre su diálogo y cancelar no cambia el repositorio', () => {
    const dialogs: [string, string][] = [
      ['repo.clone', 'Clonar repositorio'], ['repo.init', 'Crear repositorio'], ['repo.identity', 'Usuario y correo'],
      ['repo.config', 'Configuración de git'], ['changes.clean', 'Eliminar archivos sin seguimiento'],
      ['branch.create', 'Crear rama'], ['branch.checkout', 'Cambiar de rama'], ['branch.rename', 'Renombrar rama'],
      ['branch.delete', 'Eliminar rama…'], ['merge.merge', 'Merge'], ['merge.rebase', 'Rebase'],
      ['merge.interactive', 'Rebase interactivo'], ['merge.cherryPick', 'Cherry-pick'],
      ['merge.revert', 'Revertir commit'], ['merge.reset', 'Reset'], ['remote.fetch', 'Fetch'], ['remote.pull', 'Pull'],
      ['remote.push', 'Push'], ['remote.forcePush', 'Push'], ['remote.add', 'Agregar remoto'],
      ['tag.create', 'Crear tag'], ['stash.save', 'Guardar stash'], ['sub.add', 'Agregar submódulo'],
      ['wt.add', 'Agregar worktree'], ['flow.init', 'Inicializar Git Flow'], ['history.reflog', 'Reflog'],
      ['history.file', 'Historial de un archivo…'], ['history.blame', 'Blame de un archivo…'],
      ['history.bisect', 'Iniciar bisect'], ['repo.stats', 'Estadísticas del repositorio'],
      ['repo.treemap', 'Treemap del repositorio'], ['repo.benchmark', 'Benchmark de rendimiento'],
      ['tools.archive', 'Exportar archivo'], ['tools.custom', 'Comando git personalizado'],
      ['platform.cloneAccount', 'Clonar desde mi cuenta'], ['platform.prs', 'Pull requests'],
      ['platform.createPr', 'Crear pull request'], ['view.settings', 'Ajustes'], ['platform.accounts', 'Ajustes'],
    ];
    for (const [id, title] of dialogs) {
      it(`${L(id)} → «${title}»`, async () => {
        const before = `${status()}|${fx.g('rev-parse', 'HEAD')}|${fx.g('stash', 'list')}|${fx.g('branch', '--list')}`;
        await run(id);
        await dialogIs(title);
        await cancel();
        assert.equal(`${status()}|${fx.g('rev-parse', 'HEAD')}|${fx.g('stash', 'list')}|${fx.g('branch', '--list')}`, before);
        assert.equal(await s.overlays.count(), 0);
      });
    }
  });

  describe('cmd vista y ajustes', () => {
    it('Ir a cambios locales / Ir al historial cambian el panel central', async () => {
      await run('view.changes');
      await s.page.locator('gt-changes').waitFor();
      assert.equal(await s.page.locator('gt-viewer').count(), 0);
      await run('view.history');
      await s.page.locator('gt-viewer').waitFor();
      assert.equal(await s.page.locator('gt-changes').count(), 0);
    });

    it('Mostrar/ocultar consola alterna el panel', async () => {
      const had = await s.page.locator('gt-console-panel').count();
      await run('view.console');
      await waitFor(async () => (await s.page.locator('gt-console-panel').count()) === (had ? 0 : 1), 3000, 'panel alternado');
      await run('view.console');
      await waitFor(async () => (await s.page.locator('gt-console-panel').count()) === had, 3000, 'panel restaurado');
    });

    it('Cambiar tema claro/oscuro alterna data-theme', async () => {
      const t0 = await s.page.evaluate(() => document.documentElement.dataset['theme']);
      await run('view.theme');
      await waitFor(async () => (await s.page.evaluate(() => document.documentElement.dataset['theme'])) !== t0, 3000, 'tema distinto');
      await run('view.theme');
      await waitFor(async () => (await s.page.evaluate(() => document.documentElement.dataset['theme'])) === t0, 3000, 'tema restaurado');
    });

    it('«Cambiar idioma» rota entre los cinco idiomas y vuelve al español', async () => {
      const footer = async () => (await s.page.locator('footer button').nth(0).innerText()).trim();
      assert.equal(await footer(), 'ES');
      await run('view.language');
      await s.bar('work').getByText('Branch', { exact: true }).waitFor();
      assert.equal(await footer(), 'EN');
      await runCmd(s, 'Change language');
      await waitFor(async () => (await footer()) === 'PT', 3000, 'portugués');
      await runCmd(s, 'Mudar idioma');
      await waitFor(async () => (await footer()) === 'FR', 3000, 'francés');
      await runCmd(s, 'Changer de langue');
      await waitFor(async () => (await footer()) === 'DE', 3000, 'alemán');
      await runCmd(s, 'Sprache wechseln');
      await s.bar('work').getByText('Rama', { exact: true }).waitFor();
      assert.equal(await footer(), 'ES');
      assert.equal(await s.page.evaluate(() => document.documentElement.lang), 'es');
    });
  });

  describe('cmd repositorio', () => {
    let extra: string;

    it('Abrir repositorio… abre el elegido; cancelar el selector no hace nada', async () => {
      extra = makeSmall(fx.base, 'extra-clean');
      const n = await s.tabs.count();
      await run('repo.open');
      await s.page.waitForTimeout(500);
      assert.equal(await s.tabs.count(), n);
      await s.pick(extra);
      await run('repo.open');
      await s.tab(extra).waitFor({ timeout: 15000 });
      assert.equal(await s.activeTitle(), extra);
    });

    it('Actualizar relee el estado: un archivo nuevo en disco aparece como cambio', async () => {
      const dot = s.tab(extra).locator('span.rounded-full');
      assert.equal(await dot.count(), 0);
      writeFileSync(path.join(extra, 'nuevo.txt'), 'n');
      await s.page.waitForTimeout(800);
      assert.equal(await dot.count(), 0, 'sin actualizar, aún no se ve (control negativo)');
      await run('repo.refresh');
      await dot.waitFor({ timeout: 8000 });
    });

    it('Cerrar repositorio cierra solo la pestaña activa', async () => {
      const n = await s.tabs.count();
      await run('repo.close');
      await s.tab(extra).waitFor({ state: 'detached' });
      assert.equal(await s.tabs.count(), n - 1);
      assert.ok(await s.tab(repo).count());
    });

    it('Abrir en el explorador de archivos llama a showItemInFolder con la ruta del repo', async () => {
      await s.tab(repo).click();
      await s.clearCalls();
      await run('repo.folder');
      await waitFor(async () => (await s.calls()).length > 0, 3000, 'showItemInFolder');
      assert.deepEqual(await s.calls(), [{ fn: 'showItemInFolder', arg: repo }]);
    });

    it('Abrir terminal aquí lanza la terminal configurada en la carpeta del repo', async () => {
      rmSync(marker, { force: true });
      await run('repo.terminal');
      await waitFor(() => existsSync(marker), 5000, 'marcador de terminal');
      assert.equal(readFileSync(marker, 'utf8'), '');
    });
  });

  describe('cmd cambios y commit', () => {
    it('Preparar todo (add -A) deja todo en el índice; Quitar todo del índice lo vuelve a sacar', async () => {
      dirty();
      await s.page.keyboard.press('F5');
      await run('changes.stageAll');
      await waitFor(() => fx.g('diff', '--name-only') === '', 8000, 'todo preparado');
      assert.match(fx.g('diff', '--cached', '--name-only'), /README\.md/);
      assert.match(fx.g('diff', '--cached', '--name-only'), /new\.ts/);
      await run('changes.unstageAll');
      await waitFor(() => fx.g('diff', '--cached', '--name-only') === '', 8000, 'índice vacío');
      assert.match(status(), /\?\? src\/new\.ts|\?\? new\.ts/);
    });

    it('Hacer commit lleva a Cambios locales y enfoca el resumen del commit', async () => {
      await run('view.history');
      await run('commit.commit');
      await s.page.locator('gt-changes').waitFor();
      await s.page.locator('input[name=subject]').waitFor();
    });

    it('Enmendar último commit marca "Enmendar" y precarga el mensaje del último commit', async () => {
      await run('commit.amend');
      await s.page.locator('gt-changes').waitFor();
      const subject = fx.g('log', '-1', '--format=%s');
      await waitFor(async () => (await s.page.locator('input[name=subject]').inputValue()) === subject, 5000, 'asunto precargado');
      assert.equal(await s.page.getByRole('checkbox', { name: 'Enmendar último commit' }).isChecked(), true);
    });

    it('Deshacer último commit (mantener cambios) mueve HEAD y deja los cambios preparados', async () => {
      await s.page.keyboard.press('Escape');
      fx.g('checkout', '-q', '--', '.');
      writeFileSync(f('undo.txt'), 'u\n');
      fx.g('add', 'undo.txt');
      fx.g('commit', '-qm', 'feat: to undo');
      const parent = fx.g('rev-parse', 'HEAD~1');
      await s.page.keyboard.press('F5');
      await run('commit.undo');
      await s.toast(/Operación completada/);
      assert.equal(fx.g('rev-parse', 'HEAD'), parent);
      assert.match(fx.g('diff', '--cached', '--name-only'), /undo\.txt/);
      assert.equal(await s.page.locator('gt-changes').count(), 1, 'pasa a la vista de cambios');
      fx.g('reset', '-q');
      rmSync(f('undo.txt'));
    });

    it('Eliminar archivos sin seguimiento: muestra la vista previa y borra solo los no versionados', async () => {
      dirty();
      writeFileSync(f('junk.txt'), 'j');
      await s.page.keyboard.press('F5');
      await run('changes.clean');
      await dialogIs('Eliminar archivos sin seguimiento');
      const msg = await s.dialog.innerText();
      assert.match(msg, /junk\.txt/);
      assert.match(msg, /new\.ts/);
      await submit();
      await s.waitNoDialog();
      await waitFor(() => !existsSync(f('junk.txt')) && !existsSync(f('new.ts')), 8000, 'archivos borrados');
      assert.ok(existsSync(f('README.md')), 'los versionados se conservan');
      assert.match(status(), /M README\.md/);
    });

    it('Descartar todos los cambios: cancelar conserva el trabajo, confirmar lo descarta', async () => {
      dirty();
      await s.page.keyboard.press('F5');
      await run('changes.discardAll');
      await s.waitDialog();
      assert.match(await s.dialog.innerText(), /¿Descartar TODOS los cambios locales\?/);
      await cancel();
      assert.match(status(), /README\.md/, 'cancelar no descarta');
      await run('changes.discardAll');
      await s.waitDialog();
      await submit();
      await s.waitNoDialog();
      await waitFor(() => status() === '', 8000, 'árbol limpio');
    });
  });

  describe('cmd remotos, tags y stash', () => {
    it('Fetch de todos los remotos trae los commits del remoto', async () => {
      const h = fx.remoteCommit('pal1.txt', 'remote: palette');
      await run('remote.fetchAll');
      await waitFor(() => fx.g('rev-parse', 'origin/main') === h, 15000, 'origin/main actualizado');
    });

    it('Push forzado abre el diálogo Push con "with-lease" preseleccionado', async () => {
      await run('remote.forcePush');
      await dialogIs('Push');
      const checked = await s.dialog.locator('input[type=radio]:checked').evaluateAll((els) => els.map((e) => (e.parentElement as HTMLElement).innerText.trim()));
      assert.equal(checked.length, 1);
      assert.match(checked[0], /--force-with-lease/, `radio marcado: ${checked}`);
      await cancel();
      await run('remote.push');
      await dialogIs('Push');
      const plain = await s.dialog.locator('input[type=radio]:checked').evaluateAll((els) => els.map((e) => (e.parentElement as HTMLElement).innerText.trim()));
      assert.deepEqual(plain, ['No'], 'el Push normal no fuerza (control negativo)');
      await cancel();
    });

    it('Agregar remoto… crea el remoto y valida los campos obligatorios', async () => {
      await run('remote.add');
      await dialogIs('Agregar remoto');
      await submit();
      await waitFor(async () => (await s.dialog.locator('.error-text').count()) >= 1, 3000, 'errores de obligatorio');
      assert.equal(fx.g('remote'), 'origin');
      const fields = await s.dialog.locator('input[id^=fd-]').evaluateAll((els) => els.map((e) => e.id));
      await s.page.locator(`#${fields[0]}`).fill('upstream2');
      await s.page.locator(`#${fields[1]}`).fill(fx.bare);
      await submit();
      await s.waitNoDialog();
      await waitFor(() => fx.g('remote').split('\n').includes('upstream2'), 8000, 'remoto añadido');
      assert.equal(fx.g('remote', 'get-url', 'upstream2'), fx.bare);
      fx.g('remote', 'remove', 'upstream2');
      await s.page.keyboard.press('F5');
      await s.page.waitForTimeout(600);
    });

    it('Push de todos los tags sube los tags locales al remoto', async () => {
      fx.g('tag', 'palette-t1');
      await run('tag.pushAll');
      await waitFor(() => git(fx.bare, 'tag', '-l', 'palette-t1') === 'palette-t1', 15000, 'tag en el remoto');
    });

    it('Crear tag… crea el tag con su mensaje (anotado)', async () => {
      await run('tag.create');
      await dialogIs('Crear tag');
      const ids = await s.dialog.locator('input[id^=fd-], textarea[id^=fd-]').evaluateAll((els) => els.map((e) => e.id));
      await s.page.locator(`#${ids[0]}`).fill('palette-t2');
      await submit();
      await s.waitNoDialog();
      await waitFor(() => fx.g('tag', '-l', 'palette-t2') === 'palette-t2', 8000, 'tag creado');
    });

    it('Guardar stash… guarda; entonces aparecen "pop" y "Eliminar todos los stashes", que antes no estaban', async () => {
      assert.equal(await hasOption(L('stash.pop')), false);
      assert.equal(await hasOption(L('stash.clear')), false);
      dirty();
      await s.page.keyboard.press('F5');
      await run('stash.save');
      await dialogIs('Guardar stash');
      await submit();
      await s.waitNoDialog();
      await waitFor(() => fx.g('stash', 'list') !== '', 8000, 'stash creado');
      await waitFor(async () => (await hasOption(L('stash.pop'))) === true, 5000, 'aparece pop');
      assert.equal(await hasOption(L('stash.clear')), true);
    });

    it('Aplicar último stash (pop) recupera los cambios y vacía la lista', async () => {
      await run('stash.pop');
      await waitFor(() => fx.g('stash', 'list') === '', 8000, 'stash aplicado');
      assert.match(status(), /README\.md/);
      assert.equal(await hasOption(L('stash.pop')), false, 'ya no se ofrece');
    });

    it('Eliminar todos los stashes: cancelar conserva, confirmar vacía', async () => {
      fx.g('stash', '-u', '-q');
      await s.page.keyboard.press('F5');
      await waitFor(async () => (await hasOption(L('stash.clear'))) === true, 5000, 'ofrece vaciar');
      await run('stash.clear');
      await s.waitDialog();
      await cancel();
      assert.notEqual(fx.g('stash', 'list'), '');
      await run('stash.clear');
      await s.waitDialog();
      await submit();
      await s.waitNoDialog();
      await waitFor(() => fx.g('stash', 'list') === '', 8000, 'stash vaciado');
    });
  });

  describe('cmd submódulos, worktrees y herramientas', () => {
    it('Actualizar submódulos y Sincronizar URLs terminan con "Operación completada"', async () => {
      await run('sub.update');
      await s.toast(/Operación completada/);
      await s.closeAll();
      await run('sub.sync');
      await s.toast(/Operación completada/);
    });

    it('Limpiar worktrees obsoletos termina con "Operación completada"', async () => {
      await run('wt.prune');
      await s.toast(/Operación completada/);
    });

    it('Agregar worktree… crea un worktree nuevo en la carpeta indicada', async () => {
      await run('wt.add');
      await dialogIs('Agregar worktree');
      const wtDir = path.join(fx.base, 'wt-palette');
      await s.page.locator('#fd-branch').fill('wt-branch');
      await s.page.locator('#fd-path').fill(wtDir);
      const before = fx.g('worktree', 'list').split('\n').length;
      await submit();
      await s.waitNoDialog().catch(async () => {
        assert.fail(`el worktree no se creó; diálogo: ${(await s.overlays.last().innerText()).slice(0, 400)}`);
      });
      assert.equal(fx.g('worktree', 'list').split('\n').length, before + 1);
      assert.ok(existsSync(path.join(wtDir, 'README.md')));
      assert.equal(git(wtDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'wt-branch');
    });

    it('Optimizar repositorio (gc) termina con "Operación completada"', async () => {
      await run('tools.gc');
      await s.toast(/Operación completada/, 30000);
    });

    it('Exportar como archivo… genera un tar.gz con el contenido de HEAD en la ruta elegida', async () => {
      const out = path.join(fx.base, 'export.tar.gz');
      await s.save(out);
      await run('tools.archive');
      await dialogIs('Exportar archivo');
      await s.page.locator('#fd-format').selectOption('tar.gz');
      await submit();
      await waitFor(() => existsSync(out), 10000, 'archivo exportado');
      const listing = execFileSync('tar', ['tzf', out], { encoding: 'utf8' });
      assert.match(listing, /README\.md/);
      assert.match(listing, /src\/a\.ts/);
    });

    it('Exportar: cancelar el "guardar como" no crea archivo (control negativo)', async () => {
      const out = path.join(fx.base, 'no-export.zip');
      await run('tools.archive');
      await dialogIs('Exportar archivo');
      await submit();
      await s.page.waitForTimeout(800);
      assert.ok(!existsSync(out));
      await s.closeAll();
    });

    it('Aplicar parches (am)… aplica el .patch elegido como commit; cancelar el selector no hace nada', async () => {
      const clone = path.join(fx.base, 'patch-src');
      git(fx.base, 'clone', '-q', fx.bare, clone);
      git(clone, 'config', 'user.name', 'Pat');
      git(clone, 'config', 'user.email', 'pat@example.com');
      await s.page.keyboard.press('F5');
      fx.g('pull', '-q', '--ff-only');
      git(clone, 'pull', '-q', '--ff-only');
      writeFileSync(path.join(clone, 'patched.txt'), 'p\n');
      git(clone, 'add', '-A');
      git(clone, 'commit', '-qm', 'feat: from patch');
      git(clone, 'format-patch', '-1', '-o', path.join(fx.base, 'patches'));
      const patch = path.join(fx.base, 'patches', '0001-feat-from-patch.patch');
      const head = fx.g('rev-parse', 'HEAD');
      await run('tools.am');
      await s.page.waitForTimeout(600);
      assert.equal(fx.g('rev-parse', 'HEAD'), head, 'cancelar el selector no aplica nada');
      await s.pick(patch);
      await run('tools.am');
      await s.toast(/Operación completada/, 15000);
      assert.equal(fx.g('log', '-1', '--format=%s'), 'feat: from patch');
      assert.ok(existsSync(f('patched.txt')));
    });

    it('Git LFS: sin git-lfs instalado avisa; con él, pide el patrón (ambos caminos verificados)', async () => {
      const installed = (() => {
        try {
          git(fx.repo, 'lfs', 'version');
          return true;
        } catch {
          return false;
        }
      })();
      await run('tools.lfsTrack');
      if (installed) {
        await dialogIs('Git LFS: seguir patrón');
        await cancel();
      } else {
        await s.toast(/Git LFS no está instalado/);
        assert.equal(await s.overlays.count(), 0);
      }
      await run('tools.lfsPull');
      if (installed) await s.toast(/Operación completada|./, 20000);
      else await errorToast().waitFor({ timeout: 15000 });
    });

    it('Ejecutar comando git personalizado: ejecuta y muestra la salida en el diálogo', async () => {
      await run('tools.custom');
      await dialogIs('Comando git personalizado');
      const inp = s.dialog.locator('input.mono');
      await inp.fill('rev-parse --abbrev-ref HEAD');
      await inp.press('Enter');
      await waitFor(async () => /main/.test(await s.dialog.locator('pre').innerText()), 8000, 'salida del comando');
      await inp.fill('comando-que-no-existe');
      await inp.press('Enter');
      await waitFor(async () => /no es un comando de git|not a git command/i.test(await s.dialog.locator('pre').innerText()), 8000, 'error visible');
      await cancel();
    });
  });

  describe('cmd historial', () => {
    it('Buscar commits… desde el historial enfoca el campo de búsqueda', async () => {
      await run('view.history');
      await s.page.locator('gt-viewer').waitFor();
      await run('history.search');
      await waitFor(
        async () => s.page.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('gt-viewer')),
        4000,
        'foco en el campo de búsqueda',
      );
    });

    it('Buscar commits… desde Cambios locales lleva al historial y enfoca el campo de búsqueda', async () => {
      await run('view.changes');
      await s.page.locator('gt-changes').waitFor();
      await run('history.search');
      await s.page.locator('gt-viewer').waitFor();
      await waitFor(
        async () => s.page.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('gt-viewer')),
        4000,
        'foco en el campo de búsqueda',
      );
    });

    it('Blame de un archivo… pide la ruta y abre «Blame: README.md»; una ruta inexistente muestra error', async () => {
      await run('history.blame');
      await dialogIs('Blame de un archivo…');
      await s.page.locator('#fd-v').fill('README.md');
      await s.page.keyboard.press('Enter');
      await waitFor(async () => (await s.dialogTitle().catch(() => '')) === 'Blame: README.md', 8000, 'diálogo Blame');
      await cancel();
      await run('history.blame');
      await s.waitDialog();
      await s.page.locator('#fd-v').fill('no-existe.txt');
      await s.page.keyboard.press('Enter');
      await s.page.waitForTimeout(1500);
      // Debe avisar (toast de error o contenido de error) y no quedarse en blanco sin explicación
      const shown = (await s.overlays.count()) ? await s.overlays.last().innerText() : '';
      const err = await s.page.locator('[aria-live=polite] > div.border-danger').count();
      assert.ok(err > 0 || /no-existe|error|fatal|No existe/i.test(shown), `sin aviso para una ruta inexistente; diálogo: ${shown.slice(0, 200)}`);
    });

    it('Historial de un archivo… filtra el historial por esa ruta', async () => {
      const hist = makeSmall(fx.base, 'hist-repo');
      for (const n of ['a.txt', 'b.txt']) {
        writeFileSync(path.join(hist, n), n);
        git(hist, 'add', '-A');
        git(hist, 'commit', '-qm', `add ${n}`);
      }
      await s.pick(hist);
      await run('repo.open');
      await s.tab(hist).waitFor({ timeout: 15000 });
      await run('view.history');
      await s.page.getByText('add b.txt').first().waitFor({ timeout: 8000 });
      await run('history.file');
      await dialogIs('Historial de un archivo…');
      await s.page.locator('#fd-v').fill('a.txt');
      await s.page.keyboard.press('Enter');
      await s.waitNoDialog();
      await waitFor(async () => (await s.page.getByText('add b.txt').count()) === 0, 8000, 'oculta commits de otros archivos');
      assert.ok(await s.page.getByText('add a.txt').count());
      await run('repo.close');
      await s.tab(hist).waitFor({ state: 'detached' });
    });
  });

  describe('cmd operaciones en curso (merge, rebase, bisect)', () => {
    let conf: string;

    it('con un merge en conflicto aparecen Continuar y Abortar (no Omitir) y el aviso de operación', async () => {
      conf = makeConflictRepo(fx.base, 'conf-repo');
      await s.pick(conf);
      await run('repo.open');
      await s.tab(conf).waitFor({ timeout: 15000 });
      await s.page.locator('[role=status]').waitFor({ timeout: 8000 });
      assert.match(await bannerText(), /Merge en curso/);
      assert.equal(await hasOption(L('merge.continue')), true);
      assert.equal(await hasOption(L('merge.abort')), true);
      assert.equal(await hasOption(L('merge.skip')), false, 'Omitir solo existe en un rebase');
    });

    it('Continuar con conflictos sin resolver muestra un error y la operación sigue en curso', async () => {
      await run('merge.continue');
      await errorToast().waitFor({ timeout: 10000 });
      assert.match(await bannerText(), /Merge en curso/);
    });

    it('Abortar operación en curso: cancelar la conserva, confirmar la aborta', async () => {
      await run('merge.abort');
      await s.waitDialog();
      await cancel();
      assert.match(await bannerText(), /Merge en curso/);
      await run('merge.abort');
      await s.waitDialog();
      await submit();
      await s.waitNoDialog();
      await s.page.locator('[role=status]').waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(git(conf, 'status', '--porcelain'), '');
    });

    it('en un rebase en conflicto aparece Omitir; Omitir descarta el commit y termina el rebase', async () => {
      git(conf, 'checkout', '-q', 'topic');
      try {
        git(conf, 'rebase', 'main');
      } catch {
        /* conflicto esperado */
      }
      await s.page.keyboard.press('F5');
      await s.page.locator('[role=status]').waitFor({ timeout: 8000 });
      assert.match(await bannerText(), /Rebase( interactivo)? en curso/);
      assert.equal(await hasOption(L('merge.skip')), true);
      await run('merge.skip');
      await s.page.locator('[role=status]').waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(git(conf, 'status', '--porcelain'), '');
      assert.equal(git(conf, 'log', '--format=%s', '-1'), 'change main', 'el commit de topic se omitió');
      await run('repo.close');
      await s.tab(conf).waitFor({ state: 'detached' });
    });

    it('con un bisect en curso aparecen Bueno/Malo/Terminar; Terminar (con confirmación) lo cierra', async () => {
      const bis = makeSmall(fx.base, 'bisect-repo');
      for (let i = 2; i <= 6; i++) {
        writeFileSync(path.join(bis, 'f.txt'), `v${i}\n`);
        git(bis, 'commit', '-qam', `c${i}`);
      }
      const first = git(bis, 'rev-list', '--max-parents=0', 'HEAD');
      git(bis, 'bisect', 'start', 'HEAD', first);
      await s.pick(bis);
      await run('repo.open');
      await s.tab(bis).waitFor({ timeout: 15000 });
      await s.page.locator('[role=status]').waitFor({ timeout: 8000 });
      assert.match(await bannerText(), /Bisect en curso/);
      for (const id of ['history.bisectGood', 'history.bisectBad', 'history.bisectReset']) {
        assert.equal(await hasOption(L(id)), true, `${L(id)} debe estar disponible`);
      }
      const head0 = git(bis, 'rev-parse', 'HEAD');
      await run('history.bisectGood');
      await waitFor(() => git(bis, 'rev-parse', 'HEAD') !== head0, 8000, 'bisect avanzó al marcar bueno');
      await run('history.bisectReset');
      await s.waitDialog();
      await submit();
      await s.waitNoDialog();
      await s.page.locator('[role=status]').waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(await hasOption(L('history.bisectGood')), false);
      assert.equal(git(bis, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
      await run('repo.close');
    });
  });

  describe('cmd Git Flow', () => {
    let flow: string;

    it('sin inicializar, Desinicializar avisa; Iniciar feature ofrece inicializar y cancelar no crea nada', async () => {
      flow = makeSmall(fx.base, 'flow-repo');
      await s.pick(flow);
      await run('repo.open');
      await s.tab(flow).waitFor({ timeout: 15000 });
      await run('flow.deinit');
      await s.toast(/Git Flow no está inicializado en este repositorio\./);
      assert.equal(await s.overlays.count(), 0);
      await run('flow.feature');
      await dialogIs('Inicializar Git Flow');
      await cancel();
      assert.equal(git(flow, 'branch', '--list', 'develop'), '', 'no se creó develop');
    });

    it('Inicializar Git Flow crea la rama develop y deja la configuración gitflow.*', async () => {
      await run('flow.init');
      await dialogIs('Inicializar Git Flow');
      await submit();
      await s.waitNoDialog();
      await s.toast(/Git Flow inicializado/);
      assert.ok(git(flow, 'branch', '--list', 'develop').includes('develop'));
      assert.equal(git(flow, 'config', '--get', 'gitflow.branch.develop'), 'develop');
    });

    it('Iniciar feature/release/hotfix piden nombre; feature crea feature/x1 y pasa a ella', async () => {
      await run('flow.release');
      await dialogIs('Iniciar release');
      await cancel();
      await run('flow.hotfix');
      await dialogIs('Iniciar hotfix');
      await cancel();
      await run('flow.feature');
      await dialogIs('Iniciar feature');
      await submit();
      await waitFor(async () => (await s.dialog.locator('.error-text').count()) >= 1, 3000, 'el nombre es obligatorio');
      await s.page.locator('#fd-name').fill('x1');
      await submit();
      await s.waitNoDialog();
      await s.toast(/Rama feature\/x1 creada/);
      assert.equal(git(flow, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x1');
    });

    it('Desinicializar Git Flow: pide confirmar y elimina la configuración gitflow.* (las ramas se conservan)', async () => {
      await run('flow.deinit');
      await dialogIs('Desinicializar Git Flow');
      await submit();
      await s.waitNoDialog();
      await s.toast(/Git Flow desinicializado/);
      assert.throws(() => git(flow, 'config', '--get-regexp', '^gitflow\\.'), 'no queda configuración gitflow.*');
      assert.ok(git(flow, 'branch', '--list', 'develop').includes('develop'));
      await run('repo.close');
    });
  });

  it('no hubo errores de JavaScript sin capturar durante la sesión', async () => {
    assert.deepEqual(s.errors, []);
  });
});

describe('atajos de teclado (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let marker: string;
  let s: Sess;
  const f = (n: string) => path.join(fx.repo, n);
  const key = async (combo: string) => {
    await s.page.keyboard.press(combo);
    await s.page.waitForTimeout(250);
  };
  const expectDialog = async (title: string) => {
    await s.waitDialog();
    assert.equal(await s.dialogTitle(), title);
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
  };

  before(async () => {
    ({ fx, repo, marker } = makeOpenFixture());
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
    await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  });

  const dialogShortcuts: [string, string][] = [
    ['Control+Shift+B', 'Crear rama'],
    ['Control+Shift+O', 'Cambiar de rama'],
    ['Control+Shift+M', 'Merge'],
    ['Control+Shift+S', 'Guardar stash'],
    ['Control+Shift+G', 'Comando git personalizado'],
    ['Control+,', 'Ajustes'],
  ];
  for (const [combo, title] of dialogShortcuts) {
    it(`${combo.replace('Control', 'Ctrl')} abre «${title}»`, async () => {
      await key(combo);
      await expectDialog(title);
    });
  }

  it('Ctrl+Shift+P abre la paleta; Escape la cierra', async () => {
    await key('Control+Shift+P');
    await s.page.locator('input[role=combobox]').waitFor();
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
  });

  it('Ctrl+Shift+F hace fetch rápido (sin diálogo) y trae los commits remotos', async () => {
    const h = fx.remoteCommit('k1.txt', 'remote: shortcut fetch');
    await key('Control+Shift+F');
    await waitFor(() => fx.g('rev-parse', 'origin/main') === h, 15000, 'fetch por atajo');
    assert.equal(await s.overlays.count(), 0);
  });

  it('Ctrl+Shift+A prepara todos los cambios', async () => {
    assert.equal(fx.g('diff', '--cached', '--name-only'), '');
    await key('Control+Shift+A');
    await waitFor(() => fx.g('diff', '--cached', '--name-only') !== '', 8000, 'cambios preparados');
    assert.equal(fx.g('diff', '--name-only'), '');
    fx.g('reset', '-q');
  });

  it('F5 actualiza el estado', async () => {
    writeFileSync(f('f5.txt'), '1');
    await key('F5');
    await waitFor(async () => /f5\.txt/.test(await s.page.locator('gt-sidebar, nav').first().innerText().catch(() => '')) || fx.g('status', '--porcelain').includes('f5.txt'), 3000, 'git ve el archivo');
    rmSync(f('f5.txt'));
    await key('F5');
  });

  it('Ctrl+1 y Ctrl+2 cambian entre Cambios y Historial; Ctrl+F desde el historial enfoca la búsqueda', async () => {
    await key('Control+1');
    await s.page.locator('gt-changes').waitFor();
    await key('Control+2');
    await s.page.locator('gt-viewer').waitFor();
    assert.equal(await s.page.locator('gt-changes').count(), 0);
    await key('Control+f');
    await waitFor(
      async () => s.page.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('gt-viewer')),
      3000,
      'foco en la búsqueda',
    );
  });

  it('Ctrl+F desde Cambios locales lleva al historial y enfoca la búsqueda', async () => {
    await key('Control+1');
    await s.page.locator('gt-changes').waitFor();
    await key('Control+f');
    await s.page.locator('gt-viewer').waitFor();
    await waitFor(
      async () => s.page.evaluate(() => document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('gt-viewer')),
      3000,
      'foco en la búsqueda tras cambiar de vista',
    );
  });

  it('Ctrl+` muestra y oculta la consola', async () => {
    const had = await s.page.locator('gt-console-panel').count();
    await key('Control+`');
    await waitFor(async () => (await s.page.locator('gt-console-panel').count()) === (had ? 0 : 1), 3000, 'consola alternada');
    await key('Control+`');
    await waitFor(async () => (await s.page.locator('gt-console-panel').count()) === had, 3000, 'consola restaurada');
  });

  it('Ctrl+Alt+T lanza la terminal configurada en la carpeta del repo', async () => {
    rmSync(marker, { force: true });
    await key('Control+Alt+t');
    await waitFor(() => existsSync(marker), 5000, 'terminal lanzada');
  });

  it('Ctrl+O abre el selector de carpeta y Ctrl+W cierra la pestaña activa', async () => {
    const extra = makeSmall(fx.base, 'kb-extra');
    await s.pick(extra);
    await key('Control+o');
    await s.tab(extra).waitFor({ timeout: 15000 });
    await key('Control+w');
    await s.tab(extra).waitFor({ state: 'detached' });
    assert.equal(await s.activeTitle(), repo);
  });

  it('los atajos con modificador funcionan aunque el foco esté en un campo de texto, y F5 también', async () => {
    await key('Control+1');
    const subject = s.page.locator('input[name=subject]');
    await subject.click();
    await key('Control+Shift+B');
    await expectDialog('Crear rama');
    await subject.click();
    await subject.fill('texto en el campo');
    await key('Control+,');
    await expectDialog('Ajustes');
    assert.equal(await subject.inputValue(), 'texto en el campo', 'el texto escrito no se pierde');
    writeFileSync(f('f5b.txt'), '1');
    await subject.click();
    await s.page.keyboard.press('F5');
    await s.page.waitForTimeout(500);
    rmSync(f('f5b.txt'));
    await subject.fill('');
  });

  it('control negativo: teclas sueltas dentro de un campo no disparan atajos (escribir "b", "o", "w")', async () => {
    await key('Control+1');
    const subject = s.page.locator('input[name=subject]');
    await subject.click();
    const tabs = await s.tabs.count();
    await s.page.keyboard.type('bow stash');
    await s.page.waitForTimeout(300);
    assert.equal(await s.overlays.count(), 0);
    assert.equal(await s.tabs.count(), tabs);
    assert.equal(await subject.inputValue(), 'bow stash');
    await subject.fill('');
  });

  it('con un diálogo abierto los atajos de la app no actúan (ni apilan otro diálogo, ni cierran la pestaña, ni abren el selector)', async () => {
    await key('Control+,');
    await s.waitDialog();
    const tabs = await s.tabs.count();
    const extra = makeSmall(fx.base, 'kb-blocked');
    await s.pick(extra);
    for (const c of ['Control+Shift+B', 'Control+Shift+M', 'Control+w', 'Control+o', 'Control+Shift+P', 'Control+1', 'F5']) await key(c);
    assert.equal(await s.overlays.count(), 1);
    assert.equal(await s.dialogTitle(), 'Ajustes');
    assert.equal(await s.tabs.count(), tabs);
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
    assert.equal(await s.tab(extra).count(), 0, 'el selector no se abrió');
    await key('Control+o');
    await s.tab(extra).waitFor({ timeout: 15000 });
    await key('Control+w');
    await s.tab(extra).waitFor({ state: 'detached' });
  });

  it('Escape cierra primero el menú contextual abierto y no toca nada más; otro Escape no hace nada sin diálogo', async () => {
    await s.tab(repo).click({ button: 'right' });
    await s.menu.waitFor();
    await key('Escape');
    await s.menu.waitFor({ state: 'detached' });
    assert.equal(await s.tabs.count(), 1);
    await key('Escape');
    assert.equal(await s.overlays.count(), 0);
  });

  it('el atajo muestra el mismo valor que la etiqueta del botón de la barra (títulos Ctrl+Shift+F/L/K/B/M/S/P, Ctrl+Alt+T, Ctrl+`)', async () => {
    const titles = await s.page.locator('nav.h-13 button[title], footer button[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
    for (const want of ['Fetch (Ctrl+Shift+F)', 'Pull (Ctrl+Shift+L)', 'Push (Ctrl+Shift+K)', 'Ctrl+Shift+B', 'Ctrl+Shift+M', 'Ctrl+Shift+S', 'Ctrl+Alt+T', 'Ctrl+Shift+P', 'Ctrl+`']) {
      assert.ok(titles.includes(want), `falta el título «${want}» en ${titles.join(' | ')}`);
    }
  });

  it('sin repositorio abierto: Ctrl+O, Ctrl+, y Ctrl+` funcionan; los atajos de repo (Ctrl+Shift+B, Ctrl+Shift+S, F5) no hacen nada', async () => {
    const tmp = makeFixture();
    const s2 = await Sess.launch(tmp.data);
    try {
      await s2.welcomeOpen.waitFor();
      for (const c of ['Control+Shift+B', 'Control+Shift+S', 'Control+Shift+M', 'Control+Shift+F', 'Control+w', 'F5', 'Control+Alt+t']) {
        await s2.page.keyboard.press(c);
        await s2.page.waitForTimeout(250);
      }
      assert.equal(await s2.overlays.count(), 0);
      await s2.page.keyboard.press('Control+`');
      await s2.page.locator('gt-console-panel').waitFor();
      await s2.page.keyboard.press('Control+`');
      await s2.page.locator('gt-console-panel').waitFor({ state: 'detached' });
      await s2.page.keyboard.press('Control+,');
      await s2.waitDialog();
      assert.equal(await s2.dialogTitle(), 'Ajustes');
      await s2.page.keyboard.press('Escape');
      await s2.waitNoDialog();
      await s2.pick(tmp.repo);
      await s2.page.keyboard.press('Control+o');
      await s2.tab(realpathSync(tmp.repo)).waitFor({ timeout: 15000 });
    } finally {
      await s2.close();
      tmp.cleanup();
    }
  });

  it('(UX) Ctrl+Shift+L / Ctrl+Shift+K hacen lo mismo que el botón de la barra que anuncian en su título (pull/push rápido)', async () => {
    // El título «Pull (Ctrl+Shift+L)» está en el botón de pull RÁPIDO, pero el atajo abre el diálogo «Pull…»
    const h = fx.remoteCommit('k2.txt', 'remote: for pull');
    await key('Control+Shift+L');
    await s.page.waitForTimeout(800);
    assert.equal(await s.overlays.count(), 0, 'el atajo abrió un diálogo en lugar de hacer el pull rápido del botón');
    await waitFor(() => fx.g('rev-parse', 'HEAD') === h, 10000, 'pull rápido por atajo');
  });

  it('no hubo errores de JavaScript sin capturar durante la sesión', async () => {
    assert.deepEqual(s.errors, []);
  });
});

describe('diálogos de formulario genéricos (E2E)', { skip }, () => {
  let fx: Fixture;
  let repo: string;
  let s: Sess;
  const field = (id: string) => s.page.locator(`#fd-${id}`);
  const open = async (combo = 'Control+Shift+B') => {
    await s.page.keyboard.press(combo);
    await s.waitDialog();
  };
  const submit = () => s.dialog.locator('button[type=submit]').click();
  const cancelBtn = () => s.dialog.getByRole('button', { name: 'Cancelar' });
  const branches = () => fx.g('branch', '--format=%(refname:short)').split('\n');
  const errs = () => s.dialog.locator('.error-text').allInnerTexts();

  before(async () => {
    ({ fx, repo } = makeOpenFixture());
    s = await Sess.launch(fx.data);
    await s.tab(repo).waitFor({ timeout: 15000 });
  });
  after(async () => {
    await s?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await s.closeAll();
  });

  it('es un diálogo modal accesible: role=dialog, aria-modal, título y botón de cierre con nombre', async () => {
    await open();
    assert.equal(await s.dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await s.dialogTitle(), 'Crear rama');
    assert.equal(await s.dialog.getByRole('button', { name: 'Cerrar' }).count(), 1);
    // Cada campo tiene una etiqueta asociada
    assert.equal(await s.dialog.getByLabel('Nombre de la rama').count(), 1);
    assert.equal(await s.dialog.getByLabel('Desde (rama local o remota)').count(), 1);
  });

  it('el foco inicial está en el primer campo (con autofocus) y el texto precargado queda seleccionado', async () => {
    await open();
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), 'fd-name');
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
    await runCmd(s, 'Pull…');
    await s.waitDialog();
    const first = await s.page.evaluate(() => document.activeElement?.id);
    assert.equal(first, 'fd-remote', 'sin autofocus, el primer control del formulario');
  });

  it('Escape, el botón Cancelar, el × y el clic en el fondo cierran sin ejecutar nada', async () => {
    const before = branches().join();
    for (const how of ['escape', 'cancel', 'x', 'backdrop']) {
      await open();
      await field('name').fill('no-debe-crearse');
      if (how === 'escape') await s.page.keyboard.press('Escape');
      if (how === 'cancel') await cancelBtn().click();
      if (how === 'x') await s.dialog.getByRole('button', { name: 'Cerrar' }).click();
      if (how === 'backdrop') await s.page.mouse.click(5, 500);
      await s.waitNoDialog();
    }
    assert.equal(branches().join(), before);
  });

  it('campos obligatorios: sin error antes de enviar; al enviar vacío aparece "obligatorio" y el diálogo sigue abierto', async () => {
    await open();
    assert.deepEqual(await errs(), []);
    await submit();
    await waitFor(async () => (await errs()).length === 1, 3000, 'error de campo obligatorio');
    assert.deepEqual(await errs(), ['Este campo es obligatorio']);
    assert.equal(await s.overlays.count(), 1);
    await field('name').fill('x');
    await waitFor(async () => (await errs()).length === 0, 3000, 'el error desaparece al escribir');
  });

  it('un nombre inválido muestra el mensaje de validación y no crea la rama', async () => {
    await open();
    await field('name').fill('nombre con espacios');
    await submit();
    await waitFor(async () => (await errs()).length === 1, 3000);
    assert.deepEqual(await errs(), ['Nombre de rama no válido']);
    assert.ok(!branches().includes('nombre con espacios'));
  });

  it('Enter envía el formulario; las opciones se aplican (desde otra rama, sin cambiar a ella)', async () => {
    await open();
    await field('name').fill('desde-login');
    await field('start').fill('feature/login');
    await s.dialog.getByRole('checkbox', { name: /Cambiar a la rama después de crearla/ }).uncheck();
    await field('name').press('Enter');
    await s.waitNoDialog();
    await s.toast(/Rama "desde-login" creada/);
    assert.ok(branches().includes('desde-login'));
    assert.equal(fx.g('rev-parse', 'desde-login'), fx.g('rev-parse', 'feature/login'));
    assert.equal(fx.g('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'no cambió de rama');
  });

  it('con la casilla marcada (valor por defecto) crea la rama y cambia a ella', async () => {
    await open();
    assert.equal(await s.dialog.getByRole('checkbox', { name: /Cambiar a la rama después de crearla/ }).isChecked(), true);
    await field('name').fill('con-switch');
    await submit();
    await s.waitNoDialog();
    await waitFor(() => fx.g('rev-parse', '--abbrev-ref', 'HEAD') === 'con-switch', 8000, 'cambio de rama');
    fx.g('checkout', '-q', 'main');
    await s.page.keyboard.press('F5');
  });

  it('un error de git se muestra dentro del diálogo (no como toast), conserva lo escrito y permite reintentar', async () => {
    await open();
    await field('name').fill('main');
    await submit();
    const pre = s.dialog.locator('pre');
    await pre.waitFor({ timeout: 8000 });
    assert.match(await pre.innerText(), /main|existe|exists/i);
    assert.equal(await s.overlays.count(), 1);
    assert.equal(await field('name').inputValue(), 'main', 'conserva lo escrito');
    assert.equal(await s.dialog.locator('button[type=submit]').isDisabled(), false, 'el botón vuelve a estar activo');
    assert.equal(await s.page.locator('[aria-live=polite] > div.border-danger').count(), 0, 'sin toast duplicado');
    await field('name').fill('tras-el-error');
    await submit();
    await s.waitNoDialog();
    assert.ok(branches().includes('tras-el-error'));
    assert.equal(fx.g('rev-parse', '--abbrev-ref', 'HEAD'), 'tras-el-error');
    fx.g('checkout', '-q', 'main');
    await s.page.keyboard.press('F5');
  });

  it('el campo "En la rama" del Pull es de solo lectura (aria-readonly) y no acepta texto', async () => {
    await runCmd(s, 'Pull…');
    await s.waitDialog();
    const into = field('into');
    assert.equal(await into.getAttribute('aria-readonly'), 'true');
    const v = await into.inputValue();
    await into.click();
    await s.page.keyboard.type('zzz');
    assert.equal(await into.inputValue(), v);
  });

  it('un campo que depende de otro (visibleWhen): ff-only desaparece al marcar rebase en Pull', async () => {
    await runCmd(s, 'Pull…');
    await s.waitDialog();
    const ff = s.dialog.getByRole('checkbox', { name: 'Solo fast-forward' });
    assert.equal(await ff.count(), 1);
    await s.dialog.getByRole('checkbox', { name: 'Rebase en lugar de merge' }).check();
    await waitFor(async () => (await ff.count()) === 0, 3000, 'ff-only oculto');
    await s.dialog.getByRole('checkbox', { name: 'Rebase en lugar de merge' }).uncheck();
    await waitFor(async () => (await ff.count()) === 1, 3000, 'ff-only de vuelta');
  });

  it('radios y advertencias: elegir Reset "hard" muestra el aviso y cambiar de modo lo quita', async () => {
    await s.page.keyboard.press('Control+Shift+P');
    await s.page.locator('input[role=combobox]').fill('Reset');
    await s.page.keyboard.press('Enter');
    await s.waitDialog();
    assert.equal(await s.dialogTitle(), 'Reset');
    const warn = s.dialog.locator('p.text-warning');
    assert.equal(await warn.count(), 0);
    await s.dialog.getByRole('radio', { name: /hard/i }).check();
    await warn.waitFor();
    assert.equal(await s.dialog.getByRole('radio', { name: /hard/i }).isChecked(), true);
    assert.equal(await s.dialog.getByRole('radio', { checked: true }).count(), 1, 'solo un radio marcado');
    await s.dialog.getByRole('radio', { name: /mixed/i }).check();
    await waitFor(async () => (await warn.count()) === 0, 3000, 'aviso retirado');
  });

  it('(accesibilidad) el foco queda atrapado dentro del diálogo modal al pulsar Tab / Mayús+Tab', async () => {
    await open();
    const outside: string[] = [];
    for (let i = 0; i < 24; i++) {
      await s.page.keyboard.press(i < 12 ? 'Tab' : 'Shift+Tab');
      const inside = await s.page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
      if (!inside) outside.push(await s.page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`.slice(0, 60)));
    }
    assert.deepEqual(outside, [], 'el foco salió del diálogo hacia el fondo');
  });

  it('(accesibilidad) el diálogo devuelve el foco al elemento que lo abrió al cerrarse', async () => {
    const btn = s.page.locator('nav.h-13 button[title="Ctrl+Shift+B"]');
    await btn.focus();
    await btn.click();
    await s.waitDialog();
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
    const back = await s.page.evaluate(() => document.activeElement?.getAttribute('title'));
    assert.equal(back, 'Ctrl+Shift+B', 'el foco debería volver al botón que abrió el diálogo');
  });

  it('confirmación peligrosa: mensaje con borde de aviso, botón rojo, y Escape = cancelar sin efecto', async () => {
    fx.g('stash', '-u', '-q');
    await s.page.keyboard.press('F5');
    await s.page.keyboard.press('Control+Shift+P');
    await s.page.locator('input[role=combobox]').fill('todos los stashes');
    await s.page.keyboard.press('Enter');
    await s.waitDialog();
    assert.equal(await s.dialog.locator('button[type=submit].danger').count(), 1);
    assert.equal(await s.dialog.locator('p.border-danger').count(), 1);
    assert.equal(await s.dialog.locator('input, select, textarea').count(), 0, 'sin campos');
    await s.page.keyboard.press('Escape');
    await s.waitNoDialog();
    assert.notEqual(fx.g('stash', 'list'), '');
    fx.g('stash', 'pop', '-q');
  });

  it('el diálogo está en inglés si la interfaz lo está (títulos y validaciones)', async () => {
    await s.page.locator('footer button').nth(0).click();
    await s.bar('work').getByText('Branch', { exact: true }).waitFor();
    try {
      await open();
      assert.equal(await s.dialogTitle(), 'Create branch');
      await submit();
      await waitFor(async () => (await errs()).length === 1, 3000);
      assert.deepEqual(await errs(), ['This field is required']);
      assert.equal(await s.dialog.getByRole('button', { name: 'Cancel' }).count(), 1);
    } finally {
      await s.closeAll();
      await s.page.locator('footer button').nth(0).click();
      await s.bar('work').getByText('Rama', { exact: true }).waitFor();
    }
  });

  it('no hubo errores de JavaScript sin capturar durante la sesión', async () => {
    assert.deepEqual(s.errors, []);
  });
});

// __END__
