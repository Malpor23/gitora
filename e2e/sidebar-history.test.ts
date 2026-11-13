import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Locator } from 'playwright-core';
import { App, Fixture, git, makeFixture } from './helpers';

/**
 * Auditoría E2E de la barra lateral y del visor de historial: Electron real sobre repositorios
 * desechables; cada control se ejerce y su efecto se comprueba con git. Requiere pantalla
 * (`xvfb-run -a ...`) y el build previo.
 *
 * Los casos marcados con `todo` documentan funciones que la interfaz anuncia (o que se esperan de un
 * cliente git) pero que hoy no existen o fallan: si empiezan a pasar, basta quitar el `todo`.
 */
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');
const skip = hasDisplay ? false : 'sin pantalla (usa xvfb-run)';

// git bloquea el transporte `file` en submódulos por defecto; se habilita solo para este proceso y sus hijos
process.env['GIT_CONFIG_COUNT'] = '1';
process.env['GIT_CONFIG_KEY_0'] = 'protocol.file.allow';
process.env['GIT_CONFIG_VALUE_0'] = 'always';

// la configuración global de git se aísla en un archivo temporal: ni se lee ni se escribe la del usuario
const GLOBAL_CFG_DIR = mkdtempSync(path.join(os.tmpdir(), 'gitora-e2e-gcfg-'));
const GLOBAL_CFG = path.join(GLOBAL_CFG_DIR, 'gitconfig');
writeFileSync(GLOBAL_CFG, '[user]\n\tname = Global User\n\temail = global@example.com\n');
process.env['GIT_CONFIG_GLOBAL'] = GLOBAL_CFG;
process.env['GIT_CONFIG_NOSYSTEM'] = '1';
process.on('exit', () => rmSync(GLOBAL_CFG_DIR, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (s: string) => new RegExp(`^\\s*${esc(s)}\\s*$`);

/** Espera (con sondeo) a que se cumpla una condición; falla con `msg` si no llega a tiempo. */
async function until(fn: () => boolean | Promise<boolean>, msg: string, timeout = 12000): Promise<void> {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) assert.fail(`tiempo agotado: ${msg}`);
    await sleep(150);
  }
}

/** git sin lanzar: devuelve cadena vacía si falla. */
function gitSoft(cwd: string, ...args: string[]): string {
  try {
    return git(cwd, ...args);
  } catch {
    return '';
  }
}

type SectionName = 'branches' | 'remotes' | 'tags' | 'stashes' | 'submodules' | 'worktrees';
const SECTION_TITLE: Record<SectionName, RegExp> = {
  branches: /Ramas/,
  remotes: /Remotos/,
  tags: /Tags/,
  stashes: /Stashes/,
  submodules: /Submódulos/,
  worktrees: /Worktrees/,
};

interface RowInfo {
  subject: string;
  author: string;
  date: string;
  hash: string;
  refs: string[];
  selected: boolean;
  hasGraph: boolean;
}

interface ShellCalls {
  external: string[];
  folder: string[];
  opened: string[];
}

class Ui {
  constructor(
    readonly app: App,
    readonly fx: Fixture,
  ) {}

  get page() {
    return this.app.page;
  }
  get g() {
    return this.fx.g;
  }

  /* ───────── barra lateral ───────── */
  sec(name: SectionName): Locator {
    return this.page.locator('gt-sidebar section').filter({ has: this.page.locator('header', { hasText: SECTION_TITLE[name] }) });
  }
  head(name: SectionName): Locator {
    return this.sec(name).locator('header');
  }
  async badge(name: SectionName): Promise<number> {
    return Number(await this.head(name).locator(':scope > span').nth(1).innerText());
  }
  async isOpen(name: SectionName): Promise<boolean> {
    return (await this.sec(name).locator('ul').count()) > 0;
  }
  async ensureOpen(name: SectionName): Promise<void> {
    if (!(await this.isOpen(name))) await this.head(name).click();
    await this.sec(name).locator('ul').waitFor();
  }
  /** Fila de una sección cuya etiqueta es exactamente `label`. */
  row(name: SectionName, label: string): Locator {
    return this.sec(name)
      .locator('li')
      .filter({ has: this.page.locator('span.truncate', { hasText: exact(label) }) });
  }
  async labels(name: SectionName): Promise<string[]> {
    if (!(await this.isOpen(name))) return [];
    const t = await this.sec(name).locator('li span.truncate').allInnerTexts();
    return t.map((s) => s.trim());
  }
  get filterInput(): Locator {
    return this.page.locator('gt-sidebar input[type=search]');
  }
  navRow(re: RegExp): Locator {
    return this.page.locator('gt-sidebar nav > div > ul > li').filter({ hasText: re });
  }

  /* ───────── menús contextuales ───────── */
  get menu(): Locator {
    return this.page.locator('[role=menu]');
  }
  async items(loc: Locator, button: 'right' | 'left' = 'right'): Promise<string[]> {
    await loc.first().click({ button });
    await this.menu.waitFor();
    const t = await this.page.locator('[role=menuitem]').allInnerTexts();
    await this.page.keyboard.press('Escape');
    await this.menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => this.page.mouse.click(2, 2));
    return t.map((s) => s.split('\n')[0].trim());
  }
  /** Clic derecho sobre `loc` y elección del ítem que cumple `re`. */
  async ctx(loc: Locator, re: RegExp): Promise<void> {
    await loc.first().click({ button: 'right' });
    await this.menu.waitFor();
    const item = this.page.locator('[role=menuitem]').filter({ hasText: re }).first();
    await item.waitFor({ timeout: 3000 });
    await item.click();
    await this.menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined);
    await sleep(250);
  }

  /* ───────── diálogos ───────── */
  get dialog(): Locator {
    return this.app.dialog;
  }
  async fill(id: string, v: string) {
    await this.app.fill(id, v);
  }
  async confirm() {
    await this.app.confirm();
  }
  async cancel() {
    await this.dialog.last().locator('.btn.ghost, button[aria-label]').first().click();
    await this.dialog.waitFor({ state: 'detached', timeout: 4000 });
  }
  async dialogOpen(): Promise<boolean> {
    return (await this.dialog.count()) > 0;
  }
  async dialogTitle(): Promise<string> {
    return (await this.dialog.last().locator('h2').first().innerText()).trim();
  }
  async waitDialog(title?: RegExp): Promise<void> {
    await this.dialog.last().waitFor({ timeout: 8000 });
    if (!title) return;
    // el diálogo anterior puede estar cerrándose: se espera a que el título coincida
    await until(async () => (await this.dialog.count()) > 0 && title.test(await this.dialogTitle().catch(() => '')), `diálogo con título ${title}`, 8000);
  }
  async waitNoDialog(): Promise<void> {
    await this.dialog.waitFor({ state: 'detached', timeout: 20000 }).catch(() => undefined);
    assert.equal(await this.dialog.count(), 0, 'el diálogo debía cerrarse');
  }
  async closeAll() {
    await this.app.closeAll();
  }

  /* ───────── historial ───────── */
  get options(): Locator {
    return this.page.locator('[role=option]');
  }
  get scroller(): Locator {
    return this.page.locator('div[role=listbox]');
  }
  async rows(): Promise<RowInfo[]> {
    return this.options.evaluateAll((els) =>
      els.map((el) => {
        const k = Array.from(el.children);
        const msg = Array.from(k[1].children);
        return {
          subject: (msg[msg.length - 1].textContent ?? '').trim(),
          refs: msg.slice(0, -1).map((s) => (s.textContent ?? '').trim()),
          author: (k[2].textContent ?? '').trim(),
          date: (k[3].textContent ?? '').trim(),
          hash: (k[4].textContent ?? '').trim(),
          selected: el.getAttribute('aria-selected') === 'true',
          hasGraph: !!k[0].querySelector('svg, canvas, gt-graph-cell'),
        };
      }),
    );
  }
  async subjects(): Promise<string[]> {
    return (await this.rows()).map((r) => r.subject);
  }
  rowOf(subject: string | RegExp): Locator {
    return this.options.filter({ hasText: subject }).first();
  }
  async selectedSubjects(): Promise<string[]> {
    return (await this.rows()).filter((r) => r.selected).map((r) => r.subject);
  }
  /** Asunto del commit mostrado en el panel de detalles. */
  async detailSubject(): Promise<string> {
    return (await this.page.locator('section h3').first().innerText()).trim();
  }
  async showHistory() {
    await this.navRow(/Todos los commits/).click();
    await this.scroller.waitFor();
  }
  get search(): Locator {
    return this.page.locator('input[type=search][placeholder*="Buscar"]');
  }
  get scopeSelect(): Locator {
    return this.page.locator('select[aria-label="Todas las ramas"]');
  }
  get firstParent(): Locator {
    return this.page.locator('#firstParent');
  }
  get chip(): Locator {
    return this.page.locator('span.rounded-full').filter({ has: this.page.locator('button[title="Quitar filtro"]') });
  }
  async expectSelected(subjects: string[]): Promise<void> {
    await until(async () => (await this.selectedSubjects()).sort().join('|') === [...subjects].sort().join('|'), `selección esperada: ${subjects.join(', ')}`, 6000);
  }
  async waitRows(pred: (s: string[]) => boolean, msg: string, timeout = 12000) {
    await until(async () => pred(await this.subjects()), msg, timeout);
  }

  /* ───────── simulaciones del entorno ───────── */
  async stubShell(): Promise<void> {
    await this.app.electron.evaluate(({ shell }) => {
      const calls = { external: [] as string[], folder: [] as string[], opened: [] as string[] };
      (globalThis as unknown as { __e2e: typeof calls }).__e2e = calls;
      const s = shell as unknown as Record<string, unknown>;
      s['openExternal'] = async (u: string) => void calls.external.push(u);
      s['showItemInFolder'] = (p: string) => void calls.folder.push(p);
      s['openPath'] = async (p: string) => {
        calls.opened.push(p);
        return '';
      };
    });
  }
  async shellCalls(): Promise<ShellCalls> {
    return this.app.electron.evaluate(() => (globalThis as unknown as { __e2e: ShellCalls }).__e2e);
  }
  async stubClipboard(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as unknown as { __clip: string[] };
      w.__clip = [];
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (t: string) => void w.__clip.push(t),
      });
    });
  }
  async clip(): Promise<string[]> {
    return this.page.evaluate(() => (window as unknown as { __clip: string[] }).__clip);
  }
  /** Siguiente diálogo nativo de carpeta devolverá `dir`. */
  async pickDirectory(dir: string): Promise<void> {
    await this.app.electron.evaluate(({ dialog }, d) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] });
    }, dir);
  }
  tabs(): Locator {
    return this.page.getByRole('tab');
  }
}

async function boot(fx: Fixture): Promise<Ui> {
  let app: App;
  try {
    app = await App.launch(fx);
  } catch (e) {
    console.error('boot: no se pudo lanzar la app', e);
    throw e;
  }
  const ui = new Ui(app, fx);
  ui.page.setDefaultTimeout(8000);
  await ui.stubShell();
  await ui.page.locator('gt-sidebar nav').waitFor();
  await ui.stubClipboard();
  // espera a que el primer refresco termine (el sidebar ya conoce las ramas)
  await until(async () => (await ui.badge('branches')) > 0, 'sidebar cargado');
  return ui;
}

async function shutdown(ui: Ui | undefined, fx: Fixture | undefined): Promise<void> {
  await ui?.app.close().catch(() => undefined);
  fx?.cleanup();
}

/** Devuelve el repo a un estado conocido para el siguiente caso. */
function resetTo(fx: Fixture, branch: string, hash: string): void {
  for (const op of [['rebase', '--abort'], ['merge', '--abort'], ['cherry-pick', '--abort'], ['revert', '--abort']]) gitSoft(fx.repo, ...op);
  fx.g('checkout', '-qf', branch);
  fx.g('reset', '-q', '--hard', hash);
  fx.g('clean', '-qfd');
}

function wip(fx: Fixture): void {
  appendFileSync(path.join(fx.repo, 'README.md'), 'wip\n');
  writeFileSync(path.join(fx.repo, 'src', 'new.ts'), 'x\n');
}

function commitFile(fx: Fixture, file: string, content: string, msg: string, env: Record<string, string> = {}): string {
  const full = path.join(fx.repo, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  execFileSync('git', ['add', '-A'], { cwd: fx.repo });
  execFileSync('git', ['commit', '-qm', msg], { cwd: fx.repo, env: { ...process.env, ...env } });
  return fx.g('rev-parse', 'HEAD');
}

/* ════════════════════════════ Fixtures ════════════════════════════ */

/** Repo para la barra lateral: ramas anidadas, ahead/behind, upstream desaparecido, tags y un stash. */
function sidebarRepo(): Fixture {
  const fx = makeFixture();
  const g = fx.g;
  g('stash', '-u', '-q', '-m', 'mi stash');
  g('tag', '-a', 'v1.0', '-m', 'release one', 'HEAD~1');
  g('tag', 'light', 'HEAD');
  for (const b of ['feature/x', 'feature/y', 'bugfix/z', 'topic']) g('branch', b);
  // feature/y y bugfix/z con commit propio (no fusionados en main)
  g('checkout', '-q', 'feature/y');
  commitFile(fx, 'y.txt', 'y\n', 'feat: y only');
  g('checkout', '-q', 'bugfix/z');
  commitFile(fx, 'z.txt', 'z\n', 'fix: z only');
  g('checkout', '-q', 'main');
  // main: 1 por subir y 1 por bajar
  commitFile(fx, 'local-ahead.txt', 'l\n', 'feat: local ahead');
  fx.remoteCommit('r.txt', 'remote: r');
  g('fetch', '-q', 'origin');
  // rama remota que solo existe en origin
  g('push', '-q', 'origin', 'feature/login');
  g('push', '-q', 'origin', 'topic:remote-only');
  // upstream desaparecido
  g('branch', 'gonebr');
  g('push', '-q', 'origin', 'gonebr:gone');
  g('branch', '-q', '-u', 'origin/gone', 'gonebr');
  git(fx.bare, 'branch', '-q', '-D', 'gone');
  g('fetch', '-q', '--prune', 'origin');
  wip(fx);
  return fx;
}

/* ════════════════════════════ A. Barra lateral: filtro, vistas, secciones ════════════════════════════ */

describe('barra lateral: filtro, vistas y secciones (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  before(async () => {
    try {
      fx = sidebarRepo();
    } catch (e) {
      console.error('fixture:', (e as { stderr?: Buffer }).stderr?.toString() ?? e);
      throw e;
    }
    ui = await boot(fx);
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  it('los contadores de cada sección coinciden con git', async () => {
    const locals = fx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean);
    assert.equal(await ui.badge('branches'), locals.length);
    assert.equal(await ui.badge('remotes'), fx.g('remote').split('\n').filter(Boolean).length);
    assert.equal(await ui.badge('tags'), fx.g('tag', '-l').split('\n').filter(Boolean).length);
    assert.equal(await ui.badge('stashes'), fx.g('stash', 'list').split('\n').filter(Boolean).length);
  });

  it('el contador de "Cambios locales" refleja los archivos modificados', async () => {
    const n = fx.g('status', '--porcelain').split('\n').filter(Boolean).length;
    assert.equal((await ui.navRow(/Cambios locales/).innerText()).replace(/\D/g, ''), String(n));
  });

  it('"Cambios locales" abre la vista de cambios y "Todos los commits" vuelve al historial', async () => {
    await ui.navRow(/Cambios locales/).click();
    await ui.scroller.waitFor({ state: 'detached', timeout: 5000 });
    assert.ok((await ui.page.locator('main').innerText()).includes('new.ts'));
    await ui.navRow(/Todos los commits/).click();
    await ui.scroller.waitFor();
    assert.ok((await ui.subjects()).includes('feat: local ahead'));
  });

  it('la fila activa queda resaltada (y la otra no)', async () => {
    await ui.navRow(/Cambios locales/).click();
    await until(async () => /bg-selected/.test((await ui.navRow(/Cambios locales/).getAttribute('class')) ?? ''), 'resalta Cambios locales');
    assert.doesNotMatch((await ui.navRow(/Todos los commits/).getAttribute('class')) ?? '', /bg-selected/);
    await ui.navRow(/Todos los commits/).click();
    await until(async () => /bg-selected/.test((await ui.navRow(/Todos los commits/).getAttribute('class')) ?? ''), 'resalta Todos');
    assert.doesNotMatch((await ui.navRow(/Cambios locales/).getAttribute('class')) ?? '', /bg-selected/);
  });

  it('el filtro reduce las ramas y al vaciarlo se restauran', async () => {
    const before = await ui.labels('branches');
    await ui.filterInput.fill('login');
    await until(async () => (await ui.labels('branches')).length < before.length, 'filtra ramas');
    assert.deepEqual(await ui.labels('branches'), ['feature', 'login']);
    // el contador de la cabecera es el total, no el filtrado
    assert.equal(await ui.badge('branches'), fx.g('branch', '--format=%(refname:short)').split('\n').filter(Boolean).length);
    await ui.filterInput.fill('');
    await until(async () => (await ui.labels('branches')).length === before.length, 'restaura ramas');
    assert.deepEqual(await ui.labels('branches'), before);
  });

  it('el filtro no distingue mayúsculas y un texto sin coincidencias vacía todas las listas', async () => {
    await ui.ensureOpen('tags');
    await ui.filterInput.fill('FEATURE/X');
    await until(async () => (await ui.labels('branches')).includes('x'), 'mayúsculas');
    await ui.filterInput.fill('zzz-no-existe');
    await until(async () => (await ui.labels('branches')).length === 0, 'sin ramas');
    assert.equal((await ui.labels('tags')).length, 0);
    assert.equal((await ui.labels('stashes')).length, 0);
    assert.equal((await ui.labels('remotes')).length, 0 + (await ui.labels('remotes')).filter((l) => l === 'origin').length);
    await ui.filterInput.fill('');
  });

  it('el filtro también aplica a tags, stashes y ramas remotas', async () => {
    await ui.ensureOpen('tags');
    await ui.filterInput.fill('v1');
    await until(async () => (await ui.labels('tags')).length === 1, 'filtra tags');
    assert.deepEqual(await ui.labels('tags'), ['v1.0']);
    await ui.filterInput.fill('mi stash');
    await until(async () => (await ui.labels('tags')).length === 0, 'tags vacíos');
    assert.equal((await ui.labels('stashes')).length, 1);
    await ui.filterInput.fill('remote-only');
    await until(async () => (await ui.labels('stashes')).length === 0, 'stashes vacíos');
    assert.ok((await ui.labels('remotes')).includes('remote-only'));
    assert.ok(!(await ui.labels('remotes')).includes('login'));
    await ui.filterInput.fill('');
    await until(async () => (await ui.labels('tags')).length > 1, 'tags restaurados');
  });

  for (const name of ['branches', 'remotes', 'tags', 'stashes'] as const) {
    it(`la cabecera de ${name} pliega y despliega su lista`, async () => {
      await ui.ensureOpen(name);
      assert.ok((await ui.sec(name).locator('li').count()) > 0);
      await ui.head(name).click();
      await until(async () => !(await ui.isOpen(name)), `pliega ${name}`);
      assert.equal(await ui.sec(name).locator('li').count(), 0);
      // las otras secciones no se ven afectadas
      const other = name === 'branches' ? 'stashes' : 'branches';
      assert.ok(await ui.isOpen(other));
      await ui.head(name).click();
      await until(async () => ui.isOpen(name), `despliega ${name}`);
      assert.ok((await ui.sec(name).locator('li').count()) > 0);
    });
  }

  it('una sección con la lista plegada conserva su contador', async () => {
    const n = await ui.badge('tags');
    await ui.head('tags').click();
    await until(async () => !(await ui.isOpen('tags')), 'pliega tags');
    assert.equal(await ui.badge('tags'), n);
    await ui.head('tags').click();
  });

  it('las secciones sin elementos (submódulos, worktrees) no aparecen', async () => {
    assert.equal(await ui.sec('submodules').count(), 0);
    assert.equal(await ui.sec('worktrees').count(), 0);
  });

  describe('botón "+" de cada cabecera', () => {
    it('Ramas "+" crea y cambia a la rama', async () => {
      await ui.head('branches').locator('button').click();
      await ui.waitDialog(/Crear rama/);
      await ui.fill('fd-name', 'plus-branch');
      await ui.confirm();
      await until(() => fx.g('branch', '--show-current') === 'plus-branch', 'rama creada');
      assert.ok((await ui.labels('branches')).includes('plus-branch'));
      fx.g('checkout', '-q', 'main');
    });
    it('Ramas "+" con nombre inválido no crea nada y muestra el error', async () => {
      await ui.head('branches').locator('button').click();
      await ui.waitDialog(/Crear rama/);
      await ui.fill('fd-name', 'mala..rama');
      await ui.confirm();
      assert.ok(await ui.dialogOpen(), 'el diálogo debe seguir abierto');
      assert.equal(gitSoft(fx.repo, 'branch', '--list', 'mala..rama'), '');
      await ui.closeAll();
    });
    it('Remotos "+" agrega un remoto', async () => {
      await ui.head('remotes').locator('button').click();
      await ui.waitDialog(/remoto/i);
      await ui.fill('fd-name', 'second');
      await ui.fill('fd-url', fx.bare);
      await ui.confirm();
      await until(() => fx.g('remote').split('\n').includes('second'), 'remoto agregado');
      assert.equal(fx.g('remote', 'get-url', 'second'), fx.bare);
      await until(async () => (await ui.labels('remotes')).includes('second'), 'aparece en la barra');
      fx.g('remote', 'remove', 'second');
      await ui.page.keyboard.press('F5');
      await until(async () => !(await ui.labels('remotes')).includes('second'), 'ya no aparece');
    });
    it('Tags "+" crea un tag en HEAD', async () => {
      await ui.head('tags').locator('button').click();
      await ui.waitDialog(/Crear tag/);
      await ui.fill('fd-name', 'plus-tag');
      await ui.confirm();
      await until(() => fx.g('tag', '-l', 'plus-tag') === 'plus-tag', 'tag creado');
      assert.equal(fx.g('rev-list', '-n1', 'plus-tag'), fx.g('rev-parse', 'HEAD'));
    });
    it('Stashes "+" guarda un stash con el mensaje indicado', async () => {
      const n = fx.g('stash', 'list').split('\n').filter(Boolean).length;
      await ui.head('stashes').locator('button').click();
      await ui.waitDialog(/stash/i);
      await ui.fill('fd-message', 'plus stash');
      await ui.confirm();
      await until(() => fx.g('stash', 'list').includes('plus stash'), 'stash creado');
      assert.equal(fx.g('stash', 'list').split('\n').filter(Boolean).length, n + 1);
      // el árbol de trabajo queda limpio
      assert.equal(fx.g('diff', '--stat'), '');
      fx.g('stash', 'pop', '-q');
    });
    it('el botón "+" de una cabecera no pliega ni despliega la sección', async () => {
      assert.ok(await ui.isOpen('branches'));
      await ui.head('branches').locator('button').click();
      await ui.waitDialog();
      assert.ok(await ui.isOpen('branches'));
      await ui.closeAll();
    });
  });

  describe('menú contextual de cada cabecera', () => {
    it('Ramas: "Crear rama…"', async () => {
      assert.deepEqual(await ui.items(ui.head('branches')), ['Crear rama…']);
      await ui.ctx(ui.head('branches'), /Crear rama/);
      await ui.waitDialog(/Crear rama/);
      await ui.closeAll();
    });
    it('Remotos: "Agregar remoto…" y "Fetch de todos los remotos"', async () => {
      assert.deepEqual(await ui.items(ui.head('remotes')), ['Agregar remoto…', 'Fetch de todos los remotos']);
      await ui.ctx(ui.head('remotes'), /Agregar remoto/);
      await ui.waitDialog(/remoto/i);
      await ui.closeAll();
      const h = fx.remoteCommit('fa.txt', 'remote: via header menu');
      await ui.ctx(ui.head('remotes'), /Fetch de todos/);
      await until(() => gitSoft(fx.repo, 'rev-parse', 'origin/main') === h, 'fetch desde el menú de cabecera');
    });
    it('Tags: "Crear tag…" y "Push de todos los tags"', async () => {
      assert.deepEqual(await ui.items(ui.head('tags')), ['Crear tag…', 'Push de todos los tags']);
      await ui.ctx(ui.head('tags'), /Crear tag/);
      await ui.waitDialog(/Crear tag/);
      await ui.closeAll();
      assert.equal(gitSoft(fx.bare, 'tag', '-l', 'v1.0'), '');
      await ui.ctx(ui.head('tags'), /Push de todos/);
      await until(() => gitSoft(fx.bare, 'tag', '-l', 'v1.0') === 'v1.0', 'tags subidos');
      assert.equal(gitSoft(fx.bare, 'tag', '-l', 'light'), 'light');
    });
    it('Stashes: "Guardar stash…" y "Eliminar todos los stashes…" (con confirmación)', async () => {
      assert.deepEqual(await ui.items(ui.head('stashes')), ['Guardar stash…', 'Eliminar todos los stashes…']);
      await ui.ctx(ui.head('stashes'), /Guardar stash/);
      await ui.waitDialog(/stash/i);
      await ui.closeAll();
      assert.ok(fx.g('stash', 'list') !== '');
      await ui.ctx(ui.head('stashes'), /Eliminar todos/);
      await ui.waitDialog();
      await ui.cancel();
      assert.ok(fx.g('stash', 'list') !== '', 'cancelar no borra');
      await ui.ctx(ui.head('stashes'), /Eliminar todos/);
      await ui.confirm();
      await until(() => fx.g('stash', 'list') === '', 'stashes vaciados');
      await until(async () => (await ui.badge('stashes')) === 0, 'contador a 0');
    });
  });

  it('el contexto de una cabecera no se abre como el menú del navegador (se cierra con Escape)', async () => {
    await ui.head('branches').click({ button: 'right' });
    await ui.menu.waitFor();
    await ui.page.keyboard.press('Escape');
    await ui.menu.waitFor({ state: 'detached', timeout: 3000 });
  });
});

/** Refresca la interfaz (F5) y espera un instante a que el store se actualice. */
async function refresh(ui: Ui): Promise<void> {
  await ui.page.keyboard.press('F5');
  await sleep(700);
}

/** Árbol limpio: sin los cambios sin commit que deja `makeFixture`. */
function cleanTree(fx: Fixture): void {
  gitSoft(fx.repo, 'checkout', '--', '.');
  fx.g('clean', '-fdq');
}

/* ════════════════════════════ B. Barra lateral: ramas ════════════════════════════ */

describe('barra lateral: ramas (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  let baseMain = '';
  const g = (...a: string[]) => fx.g(...a);
  const current = () => g('branch', '--show-current');

  before(async () => {
    fx = sidebarRepo();
    cleanTree(fx);
    baseMain = g('rev-parse', 'main');
    ui = await boot(fx);
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  async function back(): Promise<void> {
    await ui.closeAll();
    resetTo(fx, 'main', baseMain);
    await refresh(ui);
  }

  describe('indicadores y estructura', () => {
    it('la rama actual va en negrita y sólo ella', async () => {
      const cls = await ui.row('branches', 'main').locator('span.truncate').getAttribute('class');
      assert.match(cls ?? '', /font-semibold/);
      assert.doesNotMatch((await ui.row('branches', 'topic').locator('span.truncate').getAttribute('class')) ?? '', /font-semibold/);
    });

    it('main muestra ↑1 ↓1 igual que git, y topic no muestra nada', async () => {
      assert.match(g('for-each-ref', '--format=%(upstream:track)', 'refs/heads/main'), /ahead 1, behind 1/);
      const t = await ui.row('branches', 'main').innerText();
      assert.match(t, /↑1/);
      assert.match(t, /↓1/);
      assert.equal(await ui.row('branches', 'main').locator('[title="1 por subir"]').count(), 1);
      assert.equal(await ui.row('branches', 'main').locator('[title="1 por bajar"]').count(), 1);
      assert.doesNotMatch(await ui.row('branches', 'topic').innerText(), /[↑↓⊘]/);
    });

    it('una rama cuyo upstream desapareció lleva ⊘ con su explicación (y git lo confirma)', async () => {
      assert.match(g('for-each-ref', '--format=%(upstream:track)', 'refs/heads/gonebr'), /gone/);
      const row = ui.row('branches', 'gonebr');
      assert.match(await row.innerText(), /⊘/);
      assert.equal(await row.locator('[title="El upstream ya no existe"]').count(), 1);
      assert.equal(await ui.row('branches', 'main').locator('[title="El upstream ya no existe"]').count(), 0);
    });

    it('las carpetas (feature/…) se pliegan y despliegan sin afectar a las demás', async () => {
      const all = await ui.labels('branches');
      for (const l of ['feature', 'login', 'x', 'y', 'bugfix', 'z']) assert.ok(all.includes(l), `falta ${l}`);
      await ui.row('branches', 'feature').click();
      await until(async () => !(await ui.labels('branches')).includes('login'), 'pliega feature');
      const folded = await ui.labels('branches');
      assert.ok(!folded.includes('x') && !folded.includes('y'));
      assert.ok(folded.includes('z'), 'bugfix/ sigue abierta');
      await ui.row('branches', 'feature').click();
      await until(async () => (await ui.labels('branches')).includes('login'), 'despliega feature');
    });

    it('las ramas remotas también se agrupan en carpetas por remoto', async () => {
      const remote = await ui.labels('remotes');
      assert.deepEqual(remote.slice(0, 1), ['origin']);
      for (const l of ['feature', 'login', 'main', 'remote-only']) assert.ok(remote.includes(l), `falta ${l}`);
      await ui.row('remotes', 'feature').click();
      await until(async () => !(await ui.labels('remotes')).includes('login'), 'pliega feature remoto');
      await ui.row('remotes', 'feature').click();
      await until(async () => (await ui.labels('remotes')).includes('login'), 'despliega feature remoto');
    });

    it('un HEAD separado se muestra como fila propia y desaparece al volver a una rama', async () => {
      g('checkout', '-q', '--detach', 'HEAD');
      await refresh(ui);
      await ui.sec('branches').getByText(/HEAD separado en/).waitFor({ timeout: 6000 });
      assert.match(await ui.sec('branches').getByText(/HEAD separado en/).innerText(), new RegExp(g('rev-parse', '--short', 'HEAD')));
      assert.equal(await ui.row('branches', 'main').locator('span.truncate.font-semibold').count(), 0, 'ninguna rama es la actual');
      g('checkout', '-q', 'main');
      await refresh(ui);
      await ui.sec('branches').getByText(/HEAD separado en/).waitFor({ state: 'detached', timeout: 6000 });
    });
  });

  describe('clic y doble clic', () => {
    it('un clic en una rama muestra el historial y selecciona su último commit', async () => {
      await ui.navRow(/Cambios locales/).click();
      await ui.row('branches', 'z').click();
      await ui.scroller.waitFor();
      await until(async () => (await ui.detailSubject()) === 'fix: z only', 'detalle de bugfix/z');
      assert.deepEqual(await ui.selectedSubjects(), ['fix: z only']);
      await ui.row('branches', 'login').click();
      await until(async () => (await ui.detailSubject()) === 'feat: login', 'detalle de feature/login');
      assert.deepEqual(await ui.selectedSubjects(), ['feat: login']);
    });

    it('un clic en una rama remota selecciona el commit de esa rama remota', async () => {
      await ui.row('remotes', 'login').click();
      await until(async () => (await ui.detailSubject()) === 'feat: login', 'commit de origin/feature/login');
    });

    it('el doble clic en una rama que no es la actual hace checkout', async () => {
      await ui.row('branches', 'topic').dblclick();
      await until(() => current() === 'topic', 'checkout de topic');
      await until(async () => (await ui.row('branches', 'topic').locator('span.truncate.font-semibold').count()) === 1, 'negrita en topic');
      await ui.row('branches', 'main').dblclick();
      await until(() => current() === 'main', 'vuelve a main');
    });

    it('el doble clic en la rama actual no hace nada (ni diálogo ni cambios en el reflog)', async () => {
      const n = g('reflog').split('\n').length;
      await ui.row('branches', 'main').dblclick();
      await sleep(900);
      assert.equal(current(), 'main');
      assert.equal(g('reflog').split('\n').length, n);
      assert.equal(await ui.dialogOpen(), false);
    });

    it('el doble clic en una rama remota crea la local con seguimiento y la activa', async () => {
      assert.equal(gitSoft(fx.repo, 'branch', '--list', 'remote-only'), '');
      await ui.row('remotes', 'remote-only').dblclick();
      await until(() => current() === 'remote-only', 'checkout con seguimiento');
      assert.equal(g('rev-parse', '--abbrev-ref', 'remote-only@{u}'), 'origin/remote-only');
      await back();
    });

    it('si el checkout falla (cambios locales en conflicto) la rama no cambia', async () => {
      // feature/login difiere de main en README: con un cambio sin commit en README el checkout se rechaza
      appendFileSync(path.join(fx.repo, 'README.md'), 'conflicto\n');
      await ui.row('branches', 'login').dblclick();
      await sleep(1200);
      assert.equal(current(), 'main');
      assert.ok(readFileSync(path.join(fx.repo, 'README.md'), 'utf8').includes('conflicto'), 'no se pierde el cambio local');
      await back();
    });
  });

  describe('contenido del menú contextual', () => {
    it('rama local que no es la actual', async () => {
      const items = await ui.items(ui.row('branches', 'y'));
      for (const re of [
        /^Checkout feature\/y$/,
        /^Merge en la rama actual: feature\/y → main$/,
        /Rebase main → feature\/y/,
        /^Crear rama aquí/,
        /^Crear tag aquí/,
        /^Push de la rama/,
        /^Configurar upstream/,
        /^Crear pull request/,
        /^Historial de la rama$/,
        /^Copiar nombre$/,
        /^Renombrar rama/,
        /^Eliminar rama…$/,
      ])
        assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
      assert.ok(!items.some((i) => /^Pull$/.test(i)), 'Pull sólo en la actual');
      assert.ok(!items.some((i) => /remota/.test(i)));
    });
    it('rama actual: sin checkout/merge/rebase/eliminar, con Pull', async () => {
      const items = await ui.items(ui.row('branches', 'main'));
      assert.ok(items.some((i) => i === 'Pull'));
      for (const re of [/^Checkout/, /^Merge/, /Rebase/, /^Eliminar rama/]) assert.ok(!items.some((i) => re.test(i)), `sobra ${re}: ${items.join(' | ')}`);
      for (const re of [/^Push de la rama/, /^Configurar upstream/, /^Renombrar rama/, /^Crear rama aquí/]) assert.ok(items.some((i) => re.test(i)), `falta ${re}`);
    });
    it('rama remota', async () => {
      const items = await ui.items(ui.row('remotes', 'remote-only'));
      for (const re of [/^Checkout \(crear rama local/, /^Merge/, /Rebase/, /^Crear rama aquí/, /^Crear tag aquí/, /^Historial/, /^Copiar nombre/, /^Eliminar rama remota/])
        assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
      for (const re of [/^Push de la rama/, /^Configurar upstream/, /^Renombrar rama/, /^Eliminar rama…$/, /^Pull$/]) assert.ok(!items.some((i) => re.test(i)), `sobra ${re}`);
    });
  });

  describe('acciones del menú contextual de una rama local', () => {
    it('Checkout', async () => {
      await ui.ctx(ui.row('branches', 'topic'), /^Checkout topic$/);
      await until(() => current() === 'topic', 'checkout desde el menú');
      await back();
    });

    it('Merge: cancelar no fusiona; aceptar integra la rama en la actual', async () => {
      await ui.ctx(ui.row('branches', 'y'), /^Merge en la rama actual/);
      await ui.waitDialog(/Merge/);
      assert.equal(await ui.page.locator('#fd-ref').inputValue(), 'feature/y');
      await ui.cancel();
      assert.equal(g('rev-parse', 'HEAD'), baseMain);
      await ui.ctx(ui.row('branches', 'y'), /^Merge en la rama actual/);
      await ui.waitDialog(/Merge/);
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'merge-base', '--is-ancestor', 'feature/y', 'HEAD') === '' && g('rev-parse', 'HEAD') !== baseMain, 'merge hecho');
      assert.ok(existsSync(path.join(fx.repo, 'y.txt')));
      await back();
    });

    it('Rebase de la rama actual sobre la elegida', async () => {
      await ui.row('branches', 'y').dblclick();
      await until(() => current() === 'feature/y', 'en feature/y');
      assert.notEqual(g('merge-base', 'feature/y', 'main'), baseMain);
      await ui.ctx(ui.row('branches', 'main'), /Rebase feature\/y → main/);
      await ui.waitDialog(/Rebase/);
      assert.equal(await ui.page.locator('#fd-onto').inputValue(), 'main');
      await ui.confirm();
      await until(() => g('merge-base', 'feature/y', 'main') === baseMain, 'rebase hecho');
      assert.deepEqual(g('log', '--format=%s', 'main..feature/y').split('\n'), ['feat: y only']);
      await back();
      g('branch', '-f', 'feature/y', baseMain + '~0'); // se recrea más abajo si hace falta
      commitFileOn(fx, 'feature/y', 'y.txt', 'y\n', 'feat: y only');
      await refresh(ui);
    });

    it('Crear rama aquí… parte de la rama elegida', async () => {
      await ui.ctx(ui.row('branches', 'z'), /^Crear rama aquí/);
      await ui.waitDialog(/Crear rama/);
      assert.equal(await ui.page.locator('#fd-start').inputValue(), 'bugfix/z');
      await ui.fill('fd-name', 'from-z');
      await ui.confirm();
      await until(() => current() === 'from-z', 'rama creada y activa');
      assert.equal(g('rev-parse', 'from-z'), g('rev-parse', 'bugfix/z'));
      await back();
    });

    it('Crear tag aquí… etiqueta el commit de la rama', async () => {
      await ui.ctx(ui.row('branches', 'y'), /^Crear tag aquí/);
      await ui.waitDialog(/Crear tag/);
      assert.equal(await ui.page.locator('#fd-ref').inputValue(), 'feature/y');
      await ui.fill('fd-name', 'tag-on-y');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'tag', '-l', 'tag-on-y') === 'tag-on-y', 'tag creado');
      assert.equal(g('rev-list', '-n1', 'tag-on-y'), g('rev-parse', 'feature/y'));
    });

    it('Push de la rama… sube la rama y fija el upstream', async () => {
      assert.equal(gitSoft(fx.bare, 'rev-parse', '--verify', '-q', 'refs/heads/bugfix/z'), '');
      await ui.ctx(ui.row('branches', 'z'), /^Push de la rama/);
      await ui.waitDialog(/Push/);
      assert.equal(await ui.page.locator('#fd-branch').inputValue(), 'bugfix/z');
      await ui.confirm();
      await until(() => gitSoft(fx.bare, 'rev-parse', 'refs/heads/bugfix/z') === g('rev-parse', 'bugfix/z'), 'rama subida');
      assert.equal(g('rev-parse', '--abbrev-ref', 'bugfix/z@{u}'), 'origin/bugfix/z');
    });

    it('Configurar upstream… cambia y quita el seguimiento', async () => {
      await ui.ctx(ui.row('branches', 'topic'), /^Configurar upstream/);
      await ui.waitDialog(/upstream/i);
      await ui.page.selectOption('#fd-up', 'origin/remote-only');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'rev-parse', '--abbrev-ref', 'topic@{u}') === 'origin/remote-only', 'upstream fijado');
      await ui.ctx(ui.row('branches', 'topic'), /^Configurar upstream/);
      await ui.waitDialog(/upstream/i);
      await ui.page.selectOption('#fd-up', '');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'config', '--get', 'branch.topic.remote') === '', 'upstream quitado');
    });

    it('Crear pull request… abre el formulario; sin cuenta falla sin abrir nada externo', async () => {
      await ui.ctx(ui.row('branches', 'z'), /^Crear pull request/);
      await ui.waitDialog(/pull request/i);
      assert.equal(await ui.page.locator('#fd-source').inputValue(), 'bugfix/z');
      await ui.fill('fd-title', 'PR de prueba');
      await ui.confirm();
      await ui.dialog.locator('pre').waitFor({ timeout: 8000 });
      assert.match(await ui.dialog.locator('pre').innerText(), /cuenta/i);
      assert.deepEqual((await ui.shellCalls()).external, []);
      await ui.closeAll();
    });

    it('"Historial" filtra el historial por esa rama y el chip lo quita', async () => {
      await ui.ctx(ui.row('branches', 'z'), /^Historial de la rama$/);
      await ui.chip.waitFor();
      assert.match(await ui.chip.innerText(), /bugfix\/z/);
      const want = g('log', '--format=%s', 'bugfix/z').split('\n');
      await ui.waitRows((s) => s.length === want.length, 'historial filtrado por rama');
      assert.deepEqual(await ui.subjects(), want);
      assert.ok(!(await ui.subjects()).includes('feat: y only'), 'no incluye otras ramas');
      await ui.chip.locator('button').click();
      await ui.chip.waitFor({ state: 'detached' });
      await ui.waitRows((s) => s.includes('feat: y only'), 'vuelve el historial completo');
    });

    it('Copiar nombre copia el nombre de la rama', async () => {
      await ui.ctx(ui.row('branches', 'z'), /^Copiar nombre$/);
      assert.equal((await ui.clip()).at(-1), 'bugfix/z');
    });

    it('Renombrar rama…', async () => {
      g('branch', 'to-rename');
      await refresh(ui);
      await ui.ctx(ui.row('branches', 'to-rename'), /^Renombrar rama/);
      await ui.waitDialog(/Renombrar rama/);
      assert.equal(await ui.page.locator('#fd-name').inputValue(), 'to-rename');
      await ui.fill('fd-name', 'renamed-it');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'branch', '--list', 'renamed-it') !== '' && gitSoft(fx.repo, 'branch', '--list', 'to-rename') === '', 'renombrada');
      await until(async () => (await ui.labels('branches')).includes('renamed-it'), 'la barra lo refleja');
    });

    it('Eliminar rama…: una rama sin fusionar se rechaza hasta marcar "Forzar"', async () => {
      g('branch', 'del-unmerged', 'feature/y');
      await refresh(ui);
      await ui.ctx(ui.row('branches', 'del-unmerged'), /^Eliminar rama…$/);
      await ui.waitDialog(/Eliminar rama/);
      await ui.confirm();
      await ui.dialog.locator('pre').waitFor({ timeout: 8000 });
      assert.match(await ui.dialog.locator('pre').innerText(), /not fully merged|no está fusionada|-D/i);
      assert.ok(gitSoft(fx.repo, 'branch', '--list', 'del-unmerged') !== '', 'sigue existiendo');
      await ui.dialog.getByLabel(/Forzar aunque no esté fusionada/).check();
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'branch', '--list', 'del-unmerged') === '', 'eliminada con fuerza');
    });

    it('Eliminar rama… (fusionada) y también en el remoto si se marca', async () => {
      g('branch', 'del-merged');
      g('push', '-q', '-u', 'origin', 'del-merged');
      await refresh(ui);
      await ui.ctx(ui.row('branches', 'del-merged'), /^Eliminar rama…$/);
      await ui.waitDialog(/Eliminar rama/);
      await ui.dialog.getByLabel(/Eliminar también en el remoto/).check();
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'branch', '--list', 'del-merged') === '', 'local eliminada');
      await until(() => gitSoft(fx.bare, 'rev-parse', '--verify', '-q', 'refs/heads/del-merged') === '', 'remota eliminada');
    });

    it('Eliminar rama… sin marcar el remoto lo deja intacto', async () => {
      g('branch', 'del-local-only');
      g('push', '-q', '-u', 'origin', 'del-local-only');
      await refresh(ui);
      await ui.ctx(ui.row('branches', 'del-local-only'), /^Eliminar rama…$/);
      await ui.waitDialog(/Eliminar rama/);
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'branch', '--list', 'del-local-only') === '', 'local eliminada');
      assert.ok(gitSoft(fx.bare, 'rev-parse', '--verify', '-q', 'refs/heads/del-local-only') !== '');
    });

    it('Pull (rama actual) integra lo que hay en el remoto', async () => {
      assert.equal(g('rev-list', '--count', 'HEAD..origin/main'), '1');
      await ui.ctx(ui.row('branches', 'main'), /^Pull$/);
      await until(() => g('rev-list', '--count', 'HEAD..origin/main') === '0', 'pull hecho', 20000);
      assert.ok(existsSync(path.join(fx.repo, 'r.txt')));
      await back();
    });
  });

  describe('acciones del menú contextual de una rama remota', () => {
    it('Checkout (crear rama local con seguimiento)', async () => {
      g('push', '-q', 'origin', 'topic:refs/heads/extra-remote');
      g('fetch', '-q', 'origin');
      await refresh(ui);
      await ui.ctx(ui.row('remotes', 'extra-remote'), /^Checkout \(crear rama local/);
      await until(() => current() === 'extra-remote', 'checkout remoto');
      assert.equal(g('rev-parse', '--abbrev-ref', '@{u}'), 'origin/extra-remote');
      await back();
    });
    it('Crear rama aquí…, Crear tag aquí… y Copiar nombre parten del nombre remoto', async () => {
      await ui.ctx(ui.row('remotes', 'extra-remote'), /^Crear rama aquí/);
      await ui.waitDialog(/Crear rama/);
      assert.equal(await ui.page.locator('#fd-start').inputValue(), 'origin/extra-remote');
      await ui.cancel();
      await ui.ctx(ui.row('remotes', 'extra-remote'), /^Copiar nombre$/);
      assert.equal((await ui.clip()).at(-1), 'origin/extra-remote');
    });
    it('Merge en la rama actual desde una remota abre el diálogo con esa referencia', async () => {
      await ui.ctx(ui.row('remotes', 'extra-remote'), /^Merge en la rama actual/);
      await ui.waitDialog(/Merge/);
      assert.equal(await ui.page.locator('#fd-ref').inputValue(), 'origin/extra-remote');
      await ui.cancel();
    });
    it('Eliminar rama remota… (con confirmación) la borra en el remoto', async () => {
      g('push', '-q', 'origin', 'topic:refs/heads/del-me');
      g('fetch', '-q', 'origin');
      await refresh(ui);
      await ui.ctx(ui.row('remotes', 'del-me'), /^Eliminar rama remota/);
      await ui.waitDialog();
      await ui.cancel();
      assert.ok(gitSoft(fx.bare, 'rev-parse', '--verify', '-q', 'refs/heads/del-me') !== '', 'cancelar no borra');
      await ui.ctx(ui.row('remotes', 'del-me'), /^Eliminar rama remota/);
      await ui.confirm();
      await until(() => gitSoft(fx.bare, 'rev-parse', '--verify', '-q', 'refs/heads/del-me') === '', 'borrada en el remoto');
      await until(async () => !(await ui.labels('remotes')).includes('del-me'), 'desaparece de la barra');
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/** Añade un commit en otra rama sin dejar la actual. */
function commitFileOn(fx: Fixture, branch: string, file: string, content: string, msg: string): void {
  const cur = fx.g('branch', '--show-current');
  fx.g('checkout', '-q', branch);
  commitFile(fx, file, content, msg);
  fx.g('checkout', '-q', cur || 'main');
}

/** Commit desde otro clon de un bare cualquiera (simula a otra persona). */
function pushFrom(base: string, bare: string, file: string, msg: string): string {
  const clone = mkdtempSync(path.join(base, 'clone-'));
  git(base, 'clone', '-q', bare, clone);
  git(clone, 'config', 'user.name', 'Bob');
  git(clone, 'config', 'user.email', 'bob@example.com');
  writeFileSync(path.join(clone, file), `${msg}\n`);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', msg);
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  const h = git(clone, 'rev-parse', 'HEAD');
  rmSync(clone, { recursive: true, force: true });
  return h;
}

/* ════════════════════════════ C. Barra lateral: remotos ════════════════════════════ */

describe('barra lateral: remotos (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  let bare2 = '';
  const g = (...a: string[]) => fx.g(...a);

  before(async () => {
    fx = sidebarRepo();
    cleanTree(fx);
    bare2 = path.join(fx.base, 'second.git');
    git(fx.base, 'init', '-q', '--bare', '-b', 'main', bare2);
    g('remote', 'add', 'second', bare2);
    g('push', '-q', 'second', 'main');
    g('fetch', '-q', 'second');
    ui = await boot(fx);
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  it('cada remoto es un grupo; su título muestra la URL y el contador los cuenta', async () => {
    assert.equal(await ui.badge('remotes'), 2);
    const l = await ui.labels('remotes');
    assert.ok(l.includes('origin') && l.includes('second'));
    assert.equal(await ui.row('remotes', 'origin').getAttribute('title'), fx.bare);
    assert.equal(await ui.row('remotes', 'second').getAttribute('title'), bare2);
  });

  it('el grupo de un remoto se pliega sin tocar al otro', async () => {
    assert.ok((await ui.labels('remotes')).includes('remote-only'));
    await ui.row('remotes', 'origin').click();
    await until(async () => !(await ui.labels('remotes')).includes('remote-only'), 'pliega origin');
    assert.ok((await ui.labels('remotes')).includes('main'), 'las ramas de second siguen visibles');
    assert.ok((await ui.labels('remotes')).includes('second'));
    await ui.row('remotes', 'origin').click();
    await until(async () => (await ui.labels('remotes')).includes('remote-only'), 'despliega origin');
  });

  it('menú del remoto: todas sus opciones', async () => {
    const items = await ui.items(ui.row('remotes', 'origin'));
    assert.deepEqual(items, [
      'Fetch de este remoto',
      'Limpiar ramas eliminadas (prune)',
      'Ver pull requests…',
      'Editar URL…',
      'Renombrar remoto…',
      'Quitar remoto…',
    ]);
  });

  it('Fetch de este remoto trae sólo ese remoto', async () => {
    const hOrigin = fx.remoteCommit('c1.txt', 'remote: c1');
    const hSecond = pushFrom(fx.base, bare2, 's1.txt', 'second: s1');
    const prevOrigin = g('rev-parse', 'origin/main');
    const prevSecond = g('rev-parse', 'second/main');
    await ui.ctx(ui.row('remotes', 'origin'), /^Fetch de este remoto/);
    await until(() => g('rev-parse', 'origin/main') === hOrigin, 'origin actualizado');
    assert.notEqual(prevOrigin, hOrigin);
    assert.equal(g('rev-parse', 'second/main'), prevSecond, 'second no se tocó');
    await ui.ctx(ui.row('remotes', 'second'), /^Fetch de este remoto/);
    await until(() => g('rev-parse', 'second/main') === hSecond, 'second actualizado');
  });

  it('"Limpiar ramas eliminadas (prune)" borra las referencias remotas obsoletas', async () => {
    g('push', '-q', 'origin', 'topic:refs/heads/stale');
    g('fetch', '-q', 'origin');
    git(fx.bare, 'branch', '-q', '-D', 'stale');
    assert.ok(g('branch', '-r').includes('origin/stale'), 'antes: referencia obsoleta');
    await ui.ctx(ui.row('remotes', 'origin'), /^Limpiar ramas/);
    await until(() => !g('branch', '-r').includes('origin/stale'), 'prune hecho');
  });

  it('"Ver pull requests…" abre el diálogo; sin cuenta informa y no sale a la red', async () => {
    await ui.ctx(ui.row('remotes', 'origin'), /^Ver pull requests/);
    await ui.waitDialog(/Pull requests/);
    await ui.dialog.last().getByText(/cuenta|account/i).first().waitFor({ timeout: 8000 });
    assert.deepEqual((await ui.shellCalls()).external, []);
    await ui.closeAll();
  });

  it('"Editar URL…" cambia la URL de fetch y, si se indica, la de push', async () => {
    await ui.ctx(ui.row('remotes', 'second'), /^Editar URL/);
    await ui.waitDialog(/Editar remoto/);
    assert.equal(await ui.page.locator('#fd-url').inputValue(), bare2);
    await ui.cancel();
    assert.equal(g('remote', 'get-url', 'second'), bare2, 'cancelar no cambia nada');
    const alt = `${bare2}/`;
    await ui.ctx(ui.row('remotes', 'second'), /^Editar URL/);
    await ui.waitDialog(/Editar remoto/);
    await ui.fill('fd-url', alt);
    await ui.fill('fd-pushUrl', fx.bare);
    await ui.confirm();
    await until(() => g('remote', 'get-url', 'second') === alt, 'URL de fetch cambiada');
    assert.equal(g('remote', 'get-url', '--push', 'second'), fx.bare);
    g('remote', 'set-url', 'second', bare2);
    g('config', '--unset', 'remote.second.pushurl');
  });

  it('"Renombrar remoto…"', async () => {
    await ui.ctx(ui.row('remotes', 'second'), /^Renombrar remoto/);
    await ui.waitDialog(/Renombrar remoto/);
    assert.equal(await ui.page.locator('#fd-v').inputValue(), 'second');
    await ui.fill('fd-v', 'renamed');
    await ui.confirm();
    await until(() => g('remote').split('\n').includes('renamed'), 'remoto renombrado');
    assert.ok(!g('remote').split('\n').includes('second'));
    assert.ok(gitSoft(fx.repo, 'rev-parse', '--verify', '-q', 'refs/remotes/renamed/main') !== '', 'sus ramas migran');
    await until(async () => (await ui.labels('remotes')).includes('renamed'), 'la barra lo refleja');
  });

  it('"Quitar remoto…" pide confirmación y sólo quita ese remoto', async () => {
    await ui.ctx(ui.row('remotes', 'renamed'), /^Quitar remoto/);
    await ui.waitDialog();
    await ui.cancel();
    assert.ok(g('remote').split('\n').includes('renamed'), 'cancelar no quita');
    await ui.ctx(ui.row('remotes', 'renamed'), /^Quitar remoto/);
    await ui.confirm();
    await until(() => !g('remote').split('\n').includes('renamed'), 'remoto quitado');
    assert.ok(g('remote').split('\n').includes('origin'));
    await until(async () => (await ui.badge('remotes')) === 1, 'contador a 1');
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ D. Barra lateral: tags y stashes ════════════════════════════ */

describe('barra lateral: tags y stashes (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  const g = (...a: string[]) => fx.g(...a);
  const stashFile = (n: string) => path.join(fx.repo, `stash-${n}.txt`);
  const mkStash = (n: string) => {
    writeFileSync(stashFile(n), `${n}\n`);
    g('stash', '-u', '-q', '-m', `stash ${n}`);
  };

  before(async () => {
    fx = sidebarRepo();
    cleanTree(fx);
    g('stash', 'clear');
    mkStash('uno');
    mkStash('dos');
    ui = await boot(fx);
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  describe('tags', () => {
    it('la sección empieza plegada y el contador cuenta los tags', async () => {
      assert.equal(await ui.isOpen('tags'), false);
      assert.equal(await ui.badge('tags'), 2);
      await ui.ensureOpen('tags');
      assert.deepEqual((await ui.labels('tags')).sort(), ['light', 'v1.0']);
    });
    it('el título de un tag anotado es su mensaje y el de uno ligero su nombre', async () => {
      assert.equal(await ui.row('tags', 'v1.0').getAttribute('title'), 'release one');
      assert.equal(await ui.row('tags', 'light').getAttribute('title'), 'light');
    });
    it('un clic en un tag selecciona el commit al que apunta', async () => {
      await ui.navRow(/Cambios locales/).click();
      await ui.row('tags', 'v1.0').click();
      await ui.scroller.waitFor();
      const want = g('log', '-1', '--format=%s', 'v1.0^{commit}');
      await until(async () => (await ui.detailSubject()) === want, 'detalle del commit de v1.0');
      await ui.row('tags', 'light').click();
      const other = g('log', '-1', '--format=%s', 'light');
      assert.notEqual(want, other);
      await until(async () => (await ui.detailSubject()) === other, 'detalle del commit de light');
    });
    it('menú del tag: todas sus opciones', async () => {
      const items = await ui.items(ui.row('tags', 'v1.0'));
      assert.deepEqual(items, ['Checkout v1.0', 'Crear rama aquí…', 'Push del tag', 'Copiar nombre', 'Eliminar tag…', 'Eliminar tag del remoto…']);
    });
    it('Checkout deja HEAD separado en el commit del tag', async () => {
      await ui.ctx(ui.row('tags', 'v1.0'), /^Checkout v1\.0$/);
      await until(() => g('rev-parse', 'HEAD') === g('rev-list', '-n1', 'v1.0'), 'HEAD en el tag');
      assert.equal(g('branch', '--show-current'), '');
      g('checkout', '-q', 'main');
      await refresh(ui);
    });
    it('Crear rama aquí… parte del tag', async () => {
      await ui.ctx(ui.row('tags', 'v1.0'), /^Crear rama aquí/);
      await ui.waitDialog(/Crear rama/);
      assert.equal(await ui.page.locator('#fd-start').inputValue(), 'v1.0');
      await ui.fill('fd-name', 'from-tag');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'rev-parse', 'from-tag') === g('rev-list', '-n1', 'v1.0'), 'rama desde el tag');
      g('checkout', '-q', 'main');
      await refresh(ui);
    });
    it('Push del tag sube sólo ese tag', async () => {
      assert.equal(gitSoft(fx.bare, 'tag', '-l'), '');
      await ui.ctx(ui.row('tags', 'v1.0'), /^Push del tag/);
      await until(() => gitSoft(fx.bare, 'tag', '-l') === 'v1.0', 'tag subido');
    });
    it('Copiar nombre copia el nombre del tag', async () => {
      await ui.ctx(ui.row('tags', 'light'), /^Copiar nombre$/);
      assert.equal((await ui.clip()).at(-1), 'light');
    });
    it('Eliminar tag del remoto… (con confirmación) lo borra sólo en el remoto', async () => {
      await ui.ctx(ui.row('tags', 'v1.0'), /^Eliminar tag del remoto/);
      await ui.waitDialog();
      await ui.cancel();
      assert.equal(gitSoft(fx.bare, 'tag', '-l'), 'v1.0', 'cancelar no borra');
      await ui.ctx(ui.row('tags', 'v1.0'), /^Eliminar tag del remoto/);
      await ui.confirm();
      await until(() => gitSoft(fx.bare, 'tag', '-l') === '', 'borrado en el remoto');
      assert.equal(g('tag', '-l', 'v1.0'), 'v1.0', 'el local permanece');
    });
    it('Eliminar tag… (con confirmación) lo borra en local', async () => {
      await ui.ctx(ui.row('tags', 'light'), /^Eliminar tag…$/);
      await ui.waitDialog();
      await ui.cancel();
      assert.equal(g('tag', '-l', 'light'), 'light');
      await ui.ctx(ui.row('tags', 'light'), /^Eliminar tag…$/);
      await ui.confirm();
      await until(() => g('tag', '-l', 'light') === '', 'tag borrado');
      await until(async () => !(await ui.labels('tags')).includes('light'), 'sale de la barra');
      assert.equal(await ui.badge('tags'), 1);
    });
  });

  describe('stashes', () => {
    const rowUno = () => ui.sec('stashes').locator('li').filter({ hasText: 'stash uno' });
    const rowDos = () => ui.sec('stashes').locator('li').filter({ hasText: 'stash dos' });
    const count = () => g('stash', 'list').split('\n').filter(Boolean).length;

    it('lista cada stash (el más reciente primero) y su contador', async () => {
      assert.equal(await ui.badge('stashes'), 2);
      const l = await ui.labels('stashes');
      assert.equal(l.length, 2);
      assert.match(l[0], /stash dos/);
      assert.match(l[1], /stash uno/);
    });
    it('un clic selecciona el commit del stash y muestra sus archivos', async () => {
      await ui.navRow(/Cambios locales/).click();
      await rowUno().click();
      await ui.scroller.waitFor();
      const want = g('log', '-1', '--format=%s', 'stash@{1}');
      await until(async () => (await ui.detailSubject()) === want, 'detalle del stash');
      await ui.page.locator('section ul li[title="stash-uno.txt"]').waitFor();
    });
    it('menú del stash: todas sus opciones', async () => {
      assert.deepEqual(await ui.items(rowUno()), ['Aplicar stash', 'Aplicar y eliminar (pop)', 'Crear rama desde el stash…', 'Eliminar stash…']);
    });
    it('el doble clic aplica el stash y lo conserva en la lista', async () => {
      await rowUno().dblclick();
      await until(() => existsSync(stashFile('uno')), 'archivo restaurado');
      assert.equal(count(), 2);
      cleanTree(fx);
    });
    it('Aplicar stash (menú) restaura los cambios y conserva el stash', async () => {
      await ui.ctx(rowDos(), /^Aplicar stash$/);
      await until(() => existsSync(stashFile('dos')), 'archivo restaurado');
      assert.equal(count(), 2);
      assert.ok(!existsSync(stashFile('uno')), 'el otro stash no se aplicó');
      cleanTree(fx);
    });
    it('Aplicar y eliminar (pop) restaura y quita ese stash', async () => {
      await ui.ctx(rowDos(), /^Aplicar y eliminar/);
      await until(() => count() === 1, 'stash eliminado');
      assert.ok(existsSync(stashFile('dos')));
      assert.match(g('stash', 'list'), /stash uno/);
      cleanTree(fx);
      await refresh(ui);
    });
    it('Crear rama desde el stash… crea la rama con esos cambios y consume el stash', async () => {
      await ui.ctx(rowUno(), /^Crear rama desde el stash/);
      await ui.waitDialog(/Crear rama desde stash/);
      await ui.fill('fd-name', 'from-stash');
      await ui.confirm();
      await until(() => g('branch', '--show-current') === 'from-stash', 'rama creada');
      assert.ok(existsSync(stashFile('uno')));
      assert.equal(count(), 0);
      resetTo(fx, 'main', g('rev-parse', 'main'));
      await refresh(ui);
    });
    it('Eliminar stash… pide confirmación', async () => {
      mkStash('tres');
      await refresh(ui);
      const row = ui.sec('stashes').locator('li').filter({ hasText: 'stash tres' });
      await ui.ctx(row, /^Eliminar stash…$/);
      await ui.waitDialog();
      await ui.cancel();
      assert.equal(count(), 1, 'cancelar no borra');
      await ui.ctx(row, /^Eliminar stash…$/);
      await ui.confirm();
      await until(() => count() === 0, 'stash eliminado');
      await until(async () => (await ui.badge('stashes')) === 0, 'contador a 0');
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ E. Submódulos y worktrees ════════════════════════════ */

describe('barra lateral: submódulos y worktrees (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  let subsrc = '';
  let subsrc2 = '';
  const g = (...a: string[]) => fx.g(...a);
  const sub = () => path.join(fx.repo, 'libs', 'sub');

  function makeSource(name: string): string {
    const dir = path.join(fx.base, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Sub');
    git(dir, 'config', 'user.email', 'sub@example.com');
    writeFileSync(path.join(dir, 'lib.txt'), 'lib\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'lib: init');
    return dir;
  }

  before(async () => {
    fx = makeFixture();
    cleanTree(fx);
    subsrc = makeSource('subsrc');
    subsrc2 = makeSource('subsrc2');
    g('submodule', 'add', '-q', subsrc, 'libs/sub');
    g('commit', '-qm', 'chore: add submodule');
    ui = await boot(fx);
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  async function backToFirstTab(): Promise<void> {
    await ui.tabs().first().click();
    await sleep(500);
  }

  describe('submódulos', () => {
    it('la sección aparece con su contador, abierta, y la fila lleva hash y describe en el título', async () => {
      assert.equal(await ui.badge('submodules'), 1);
      assert.equal(await ui.isOpen('submodules'), true);
      assert.deepEqual(await ui.labels('submodules'), ['libs/sub']);
      const title = (await ui.row('submodules', 'libs/sub').getAttribute('title')) ?? '';
      assert.ok(title.startsWith(git(sub(), 'rev-parse', 'HEAD')), title);
    });
    it('un submódulo al día no lleva marcador', async () => {
      assert.doesNotMatch(await ui.row('submodules', 'libs/sub').innerText(), /[M−!]\s*$/);
    });
    it('la cabecera pliega y despliega, y no tiene botón "+"', async () => {
      await ui.head('submodules').click();
      await until(async () => !(await ui.isOpen('submodules')), 'pliega');
      await ui.head('submodules').click();
      await until(async () => ui.isOpen('submodules'), 'despliega');
      assert.equal(await ui.head('submodules').locator('button').count(), 0);
    });
    it('menú de la fila: abrir, actualizar, desactivar', async () => {
      assert.deepEqual(await ui.items(ui.row('submodules', 'libs/sub')), [
        'Abrir submódulo en una pestaña',
        'Actualizar submódulo',
        'Desactivar submódulo (deinit)…',
      ]);
    });
    it('el doble clic abre el submódulo en una pestaña nueva', async () => {
      const n = await ui.tabs().count();
      await ui.row('submodules', 'libs/sub').dblclick();
      await until(async () => (await ui.tabs().count()) === n + 1, 'pestaña nueva');
      assert.match(await ui.tabs().last().innerText(), /sub/);
      await backToFirstTab();
    });
    it('"Abrir submódulo en una pestaña" lleva a la pestaña del submódulo', async () => {
      await ui.ctx(ui.row('submodules', 'libs/sub'), /^Abrir submódulo/);
      await sleep(800);
      const selected = await ui.page.locator('[role=tab][aria-selected=true]').innerText();
      assert.match(selected, /sub/);
      await backToFirstTab();
    });
    it('un submódulo con commits propios sin registrar se marca con M', async () => {
      commitFile(
        { ...fx, repo: sub() } as Fixture,
        'extra.txt',
        'extra\n',
        'lib: extra',
        { GIT_AUTHOR_NAME: 'Sub', GIT_AUTHOR_EMAIL: 's@e.com', GIT_COMMITTER_NAME: 'Sub', GIT_COMMITTER_EMAIL: 's@e.com' },
      );
      await refresh(ui);
      await until(async () => /M\s*$/.test(await ui.row('submodules', 'libs/sub').innerText()), 'marcador M');
    });
    it('"Actualizar submódulo" devuelve el submódulo al commit registrado', async () => {
      const recorded = g('ls-tree', 'HEAD', 'libs/sub').split(/\s+/)[2];
      assert.notEqual(git(sub(), 'rev-parse', 'HEAD'), recorded);
      await ui.ctx(ui.row('submodules', 'libs/sub'), /^Actualizar submódulo/);
      await until(() => git(sub(), 'rev-parse', 'HEAD') === recorded, 'submódulo actualizado');
      await refresh(ui);
      await until(async () => !/M\s*$/.test(await ui.row('submodules', 'libs/sub').innerText()), 'sin marcador');
    });
    it('"Desactivar submódulo (deinit)…" pide confirmación y lo deja sin inicializar', async () => {
      await ui.ctx(ui.row('submodules', 'libs/sub'), /^Desactivar submódulo/);
      await ui.waitDialog();
      await ui.cancel();
      assert.doesNotMatch(g('submodule', 'status'), /^-/, 'cancelar no lo desactiva');
      await ui.ctx(ui.row('submodules', 'libs/sub'), /^Desactivar submódulo/);
      await ui.confirm();
      await until(() => g('submodule', 'status').startsWith('-'), 'submódulo sin inicializar');
      assert.deepEqual(readdirSync(sub()), []);
      await until(async () => /−\s*$/.test(await ui.row('submodules', 'libs/sub').innerText()), 'marcador −');
    });
    it('cabecera → "Actualizar submódulos" lo vuelve a inicializar', async () => {
      assert.deepEqual(await ui.items(ui.head('submodules')), ['Agregar submódulo…', 'Actualizar submódulos (init + recursive)']);
      await ui.ctx(ui.head('submodules'), /^Actualizar submódulos/);
      await until(() => !g('submodule', 'status').startsWith('-'), 'submódulo inicializado', 20000);
      assert.ok(existsSync(path.join(sub(), 'lib.txt')));
    });
    it('cabecera → "Agregar submódulo…" agrega uno real', async () => {
      await ui.ctx(ui.head('submodules'), /^Agregar submódulo/);
      await ui.waitDialog(/Agregar submódulo/);
      await ui.fill('fd-url', subsrc2);
      await ui.fill('fd-path', 'libs/two');
      await ui.confirm();
      await until(() => g('submodule', 'status').includes('libs/two'), 'submódulo agregado', 20000);
      assert.ok(existsSync(path.join(fx.repo, 'libs', 'two', 'lib.txt')));
      await until(async () => (await ui.badge('submodules')) === 2, 'contador a 2');
    });
  });

  describe('worktrees', () => {
    const wtDir = () => path.join(fx.base, 'wt-dir1');

    it('sin worktrees adicionales la sección no aparece', async () => {
      assert.equal(await ui.sec('worktrees').count(), 0);
    });
    it('al crear un worktree aparece la sección, plegada, con su contador', async () => {
      g('worktree', 'add', '-q', '-b', 'wt1', wtDir());
      await refresh(ui);
      await ui.head('worktrees').waitFor();
      assert.equal(await ui.badge('worktrees'), 2);
      assert.equal(await ui.isOpen('worktrees'), false);
      await ui.head('worktrees').click();
      await ui.sec('worktrees').locator('ul').waitFor();
      assert.deepEqual((await ui.labels('worktrees')).sort(), ['main', 'wt1']);
      assert.equal(await ui.head('worktrees').locator('button').count(), 0, 'sin botón +');
    });
    it('el título de cada worktree es su ruta', async () => {
      assert.equal(await ui.row('worktrees', 'wt1').getAttribute('title'), wtDir());
      assert.equal(await ui.row('worktrees', 'main').getAttribute('title'), fx.repo);
    });
    it('menú del worktree: el principal no se puede eliminar, los demás sí', async () => {
      assert.deepEqual(await ui.items(ui.row('worktrees', 'main')), ['Abrir worktree en una pestaña', 'Abrir en el explorador de archivos']);
      assert.deepEqual(await ui.items(ui.row('worktrees', 'wt1')), [
        'Abrir worktree en una pestaña',
        'Abrir en el explorador de archivos',
        'Eliminar worktree…',
      ]);
    });
    it('el doble clic abre el worktree en una pestaña nueva', async () => {
      const n = await ui.tabs().count();
      await ui.row('worktrees', 'wt1').dblclick();
      await until(async () => (await ui.tabs().count()) === n + 1, 'pestaña del worktree');
      assert.match(await ui.tabs().last().innerText(), /wt-dir1/);
      await backToFirstTab();
    });
    it('"Abrir en el explorador de archivos" pide al sistema mostrar la ruta del worktree', async () => {
      await ui.ctx(ui.row('worktrees', 'wt1'), /^Abrir en el explorador/);
      await until(async () => (await ui.shellCalls()).folder.includes(wtDir()), 'showItemInFolder llamado');
    });
    it('cabecera → "Agregar worktree…" crea el worktree con su rama', async () => {
      assert.deepEqual(await ui.items(ui.head('worktrees')), ['Agregar worktree…', 'Limpiar worktrees obsoletos']);
      await ui.ctx(ui.head('worktrees'), /^Agregar worktree/);
      await ui.waitDialog(/Agregar worktree/);
      await ui.fill('fd-branch', 'wt2');
      await ui.fill('fd-path', path.join(fx.base, 'wt-dir2'));
      await ui.confirm();
      await until(() => g('worktree', 'list').includes('wt2'), 'worktree agregado');
      assert.ok(existsSync(path.join(fx.base, 'wt-dir2', 'README.md')));
      await until(async () => (await ui.badge('worktrees')) === 3, 'contador a 3');
    });
    it('cabecera → "Limpiar worktrees obsoletos" elimina los registros de carpetas borradas', async () => {
      const stale = path.join(fx.base, 'wt-stale');
      g('worktree', 'add', '-q', '-b', 'stale', stale);
      rmSync(stale, { recursive: true, force: true });
      assert.match(g('worktree', 'list', '--porcelain'), /prunable/);
      await ui.ctx(ui.head('worktrees'), /^Limpiar worktrees/);
      await until(() => !g('worktree', 'list').includes('wt-stale'), 'worktree obsoleto limpiado');
      assert.ok(g('worktree', 'list').includes('wt-dir1'), 'los válidos permanecen');
    });
    it('"Eliminar worktree…" pide confirmación, borra la carpeta y la sección se ajusta', async () => {
      await ui.ctx(ui.row('worktrees', 'wt2'), /^Eliminar worktree/);
      await ui.waitDialog();
      await ui.cancel();
      assert.ok(existsSync(path.join(fx.base, 'wt-dir2')), 'cancelar no borra');
      await ui.ctx(ui.row('worktrees', 'wt2'), /^Eliminar worktree/);
      await ui.confirm();
      await until(() => !g('worktree', 'list').includes('wt-dir2'), 'worktree quitado');
      assert.ok(!existsSync(path.join(fx.base, 'wt-dir2')));
      await ui.ctx(ui.row('worktrees', 'wt1'), /^Eliminar worktree/);
      await ui.confirm();
      await until(() => !g('worktree', 'list').includes('wt-dir1'), 'último worktree quitado');
      await ui.sec('worktrees').waitFor({ state: 'detached', timeout: 8000 });
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ Fixtures del historial ════════════════════════════ */

const DAN = { GIT_AUTHOR_NAME: 'Dan Dev', GIT_AUTHOR_EMAIL: 'dan@example.com', GIT_COMMITTER_NAME: 'Carol Committer', GIT_COMMITTER_EMAIL: 'carol@example.com' };
const BOB = { GIT_AUTHOR_NAME: 'Bob Builder', GIT_AUTHOR_EMAIL: 'bob@builder.io', GIT_COMMITTER_NAME: 'Bob Builder', GIT_COMMITTER_EMAIL: 'bob@builder.io' };

/**
 * Historial con variedad: autor distinto del committer, cuerpo de mensaje, rename, borrado,
 * rama lateral con merge --no-ff, tags (anotado y ligero), rama sin fusionar (`extra`) y remoto.
 */
function historyRepo(): Fixture {
  const fx = makeFixture();
  const g = fx.g;
  cleanTree(fx);
  commitFile(fx, 'src/util.ts', 'export const u = 1;\nexport const v = 2;\nexport const w = 3;\n', 'feat: util\n\nBody line 1\nBody line 2', DAN);
  g('tag', '-a', 'v1.0', '-m', 'release one');
  commitFile(fx, 'src/a.ts', 'export const a = 2;\n', 'fix: tweak a', BOB);
  writeFileSync(path.join(fx.repo, 'docs-old.txt'), 'old\n');
  g('add', '-A');
  g('commit', '-qm', 'docs: add old file');
  g('tag', 'light');
  g('mv', 'src/a.ts', 'src/alpha.ts');
  rmSync(path.join(fx.repo, 'docs-old.txt'));
  g('add', '-A');
  g('commit', '-qm', 'refactor: rename a');
  const fork = g('rev-parse', 'HEAD');
  g('checkout', '-qb', 'side', fork);
  commitFile(fx, 'side1.txt', '1\n', 's1: side one');
  commitFile(fx, 'side2.txt', '2\n', 's2: side two');
  g('checkout', '-q', 'main');
  commitFile(fx, 'main-only.txt', 'm\n', 'feat: main only');
  g('merge', '--no-ff', '-qm', 'merge: side', 'side');
  commitFile(fx, 'after.txt', 'a\n', 'chore: after merge');
  // rama sin fusionar con dos commits
  g('checkout', '-qb', 'extra', 'main~2');
  commitFile(fx, 'e1.txt', 'e1\n', 'x: extra one');
  commitFile(fx, 'e2.txt', 'e2\n', 'x: extra two');
  g('checkout', '-q', 'main');
  g('push', '-q', 'origin', 'main', 'side');
  return fx;
}

/** Ref de cada rama/tag que pertenece al estado base de `historyRepo`. */
const BASE_BRANCHES = ['main', 'feature/login', 'side', 'extra'];
const BASE_TAGS = ['v1.0', 'light'];

function restoreRefs(fx: Fixture, baseMain: string): void {
  resetTo(fx, 'main', baseMain);
  for (const b of fx.g('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean))
    if (!BASE_BRANCHES.includes(b)) gitSoft(fx.repo, 'branch', '-qD', b);
  for (const t of fx.g('tag', '-l').split('\n').filter(Boolean)) if (!BASE_TAGS.includes(t)) gitSoft(fx.repo, 'tag', '-d', t);
  gitSoft(fx.repo, 'stash', 'clear');
}

/** Repo con muchos commits (más que una página de 400) creados con fast-import. */
function bigRepo(total = 450): Fixture {
  const fx = makeFixture();
  const lines: string[] = [];
  const t0 = 1_700_000_000;
  for (let i = 1; i <= total; i++) {
    const msg = `bulk ${String(i).padStart(3, '0')}`;
    const who = i % 3 === 0 ? 'Bob Builder <bob@builder.io>' : 'Ana Torres <ana@example.com>';
    const content = `line ${i}\n`;
    lines.push('commit refs/heads/main', `committer ${who} ${t0 + i * 60} +0000`, `data ${Buffer.byteLength(msg)}`, msg);
    if (i === 1) lines.push('from refs/heads/main^0');
    lines.push('M 644 inline bulk.txt', `data ${Buffer.byteLength(content)}`, content);
  }
  gitSoft(fx.repo, 'branch', '-D', 'feature/login'); // historia lineal: la fila superior es siempre 'bulk 450'
  execFileSync('git', ['fast-import', '--quiet'], { cwd: fx.repo, input: lines.join('\n') + '\n' });
  gitSoft(fx.repo, 'reset', '-q', '--hard', 'HEAD');
  wip(fx);
  return fx;
}

function numCommits(fx: Fixture): number {
  return Number(fx.g('rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD'));
}

/** Detalle del commit seleccionado (mitad inferior de la vista). */
function details(ui: Ui): Locator {
  return ui.page.locator('gt-viewer section').nth(1);
}

/* ════════════════════════════ F. Historial: lista grande, teclado y carga diferida ════════════════════════════ */

describe('historial: lista grande, teclado y carga diferida (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  let total = 0;

  before(async () => {
    fx = bigRepo(450);
    total = numCommits(fx);
    ui = await boot(fx);
    await ui.scroller.waitFor();
    await until(async () => (await ui.options.count()) > 3, 'filas visibles');
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  const loaded = async () => Math.round((await ui.scroller.locator(':scope > div.relative').evaluate((e) => parseFloat((e as HTMLElement).style.height))) / 28);

  it('hay más de una página (400): el repositorio tiene más commits que los cargados al inicio', async () => {
    assert.ok(total > 400, `total ${total}`);
    assert.equal(await loaded(), 400);
  });

  it('virtualiza: sólo hay unas decenas de filas en el DOM aunque se hayan cargado 400', async () => {
    const n = await ui.options.count();
    assert.ok(n >= 8 && n < 80, `filas en el DOM: ${n}`);
  });

  it('cada fila muestra grafo, mensaje, autor, fecha relativa y hash corto', async () => {
    const rows = await ui.rows();
    const first = rows[0];
    assert.equal(first.subject, 'bulk 450');
    assert.equal(first.author, 'Bob Builder');
    assert.equal(first.hash, fx.g('log', '-1', '--format=%h', 'main'));
    assert.ok(first.date.length > 0);
    assert.ok(first.hasGraph, 'celda del grafo');
    assert.ok(first.refs.includes('main'), `refs: ${first.refs.join(',')}`);
    assert.equal(rows[1].author, 'Ana Torres');
    assert.equal(rows[1].subject, 'bulk 449');
  });

  it('la fila de cambios sin commit aparece arriba y abre la vista de cambios', async () => {
    const btn = ui.page.getByRole('button', { name: /Cambios sin commit \(2\)/ });
    await btn.waitFor();
    await btn.click();
    await ui.scroller.waitFor({ state: 'detached', timeout: 5000 });
    assert.ok((await ui.page.locator('main').innerText()).includes('new.ts'));
    await ui.showHistory();
  });

  it('un clic selecciona una sola fila y muestra su detalle', async () => {
    await ui.rowOf('bulk 449').click();
    await ui.expectSelected(['bulk 449']);
    await until(async () => (await ui.detailSubject()) === 'bulk 449', 'detalle');
    await ui.rowOf('bulk 448').click();
    await ui.expectSelected(['bulk 448']);
  });

  it('↓ y ↑ mueven la selección de a una fila y el detalle la sigue', async () => {
    await ui.rowOf('bulk 450').click();
    await ui.page.keyboard.press('ArrowDown');
    await until(async () => (await ui.selectedSubjects()).join() === 'bulk 449', '↓');
    await until(async () => (await ui.detailSubject()) === 'bulk 449', 'el detalle sigue a la selección');
    await ui.page.keyboard.press('ArrowDown');
    await until(async () => (await ui.selectedSubjects()).join() === 'bulk 448', '↓↓');
    await ui.page.keyboard.press('ArrowUp');
    await until(async () => (await ui.selectedSubjects()).join() === 'bulk 449', '↑');
  });

  it('↑ en la primera fila se queda en ella (no sale de la lista)', async () => {
    await ui.rowOf('bulk 450').click();
    await ui.expectSelected(['bulk 450']);
    await ui.page.keyboard.press('ArrowUp');
    await sleep(300);
    await ui.expectSelected(['bulk 450']);
  });

  it('las flechas desplazan la lista para mantener visible la selección', async () => {
    await ui.rowOf('bulk 450').click();
    for (let i = 0; i < 40; i++) await ui.page.keyboard.press('ArrowDown');
    await until(async () => (await ui.selectedSubjects()).join() === 'bulk 410', '40 pasos abajo');
    const ok = await ui.scroller.evaluate((el) => {
      const sel = el.querySelector('[aria-selected=true]') as HTMLElement | null;
      if (!sel) return false;
      const top = parseFloat(sel.style.top);
      return top >= el.scrollTop - 1 && top + 28 <= el.scrollTop + el.clientHeight + 1;
    });
    assert.ok(ok, 'la fila seleccionada está dentro del área visible');
    assert.ok((await ui.scroller.evaluate((el) => el.scrollTop)) > 0);
  });

  it('Re Pág / Av Pág desplazan una página', { todo: 'PageUp/PageDown no están implementados (sólo ↑/↓)' }, async () => {
    await ui.rowOf('bulk 450').click();
    await ui.page.keyboard.press('PageDown');
    await sleep(300);
    const sel = await ui.selectedSubjects();
    assert.ok(sel.length === 1 && sel[0] !== 'bulk 450' && sel[0] !== 'bulk 449', `PageDown debía saltar varias filas: ${sel.join()}`);
  });

  it('Inicio / Fin llevan a la primera / última fila', { todo: 'Home/End no están implementados (sólo ↑/↓)' }, async () => {
    await ui.rowOf('bulk 449').click();
    await ui.page.keyboard.press('Home');
    await until(async () => (await ui.selectedSubjects()).join() === 'bulk 450', 'Home');
    await ui.page.keyboard.press('End');
    await until(async () => (await ui.selectedSubjects()).join() === 'chore: init', 'End', 4000);
  });

  it('al acercarse al final se carga la siguiente página, completa y sin duplicados', async () => {
    await ui.scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await until(async () => (await loaded()) === total, `carga hasta ${total} (hay ${await loaded()})`, 20000);
    await ui.scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await ui.waitRows((s) => s.includes('chore: init'), 'último commit visible');
    const rows = await ui.rows();
    assert.equal(new Set(rows.map((r) => r.hash)).size, rows.length, 'sin hashes repetidos');
    assert.equal(rows.at(-1)?.subject, 'chore: init');
    assert.ok(rows.length < 80, 'sigue virtualizado');
  });

  it('volver arriba muestra de nuevo el commit más reciente', async () => {
    await ui.scroller.evaluate((el) => (el.scrollTop = 0));
    await ui.waitRows((s) => s[0] === 'bulk 450', 'primera fila');
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ G. Historial: filas, búsqueda, filtros y detalle ════════════════════════════ */

describe('historial: filas, búsqueda, filtros y detalle (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  const g = (...a: string[]) => fx.g(...a);
  const ALL = ['log', '--topo-order', '--branches', '--remotes', '--tags', 'HEAD', '--format=%s'];
  const gitSubjects = (...extra: string[]) => g(...ALL, ...extra).split('\n').filter(Boolean);
  /** Hash completo del commit cuyo asunto es exactamente `subject`. */
  const h = (subject: string) => g('log', '--all', '-1', '--format=%H', '--fixed-strings', `--grep=${subject}`);

  before(async () => {
    fx = historyRepo();
    wip(fx);
    ui = await boot(fx);
    await ui.scroller.waitFor();
    await ui.waitRows((s) => s.length > 5, 'historial cargado');
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  async function resetFilters() {
    await ui.closeAll();
    if (await ui.chip.count()) await ui.chip.locator('button').click();
    await ui.search.fill('');
    await ui.search.press('Enter');
    await ui.scopeSelect.selectOption('all');
    if (await ui.firstParent.isChecked()) await ui.firstParent.uncheck();
    await ui.waitRows((s) => s.length === gitSubjects().length, 'sin filtros');
  }

  describe('filas', () => {
    it('muestran todos los commits (mismo orden que git log --topo-order)', async () => {
      assert.deepEqual(await ui.subjects(), gitSubjects());
    });
    it('refs de rama, remota y tag en la fila del commit', async () => {
      const rows = await ui.rows();
      const by = (s: string) => rows.find((r) => r.subject === s)!;
      assert.deepEqual([...by('chore: after merge').refs].sort(), ['main', 'origin/main']);
      assert.ok(by('s2: side two').refs.includes('side') && by('s2: side two').refs.includes('origin/side'));
      assert.ok(by('feat: util').refs.includes('v1.0'));
      assert.ok(by('docs: add old file').refs.includes('light'));
      assert.deepEqual(by('feat: login').refs.filter((r) => r === 'feature/login'), ['feature/login']);
      assert.deepEqual(by('fix: tweak a').refs, [], 'un commit sin ref no lleva etiquetas');
    });
    it('autor, hash corto y fecha de cada fila', async () => {
      const rows = await ui.rows();
      const fix = rows.find((r) => r.subject === 'fix: tweak a')!;
      assert.equal(fix.author, 'Bob Builder');
      assert.equal(fix.hash, g('rev-parse', '--short', h('fix: tweak a')));
      assert.ok(fix.date.length > 0);
      assert.equal(await ui.rowOf('fix: tweak a').locator('span[title="bob@builder.io"]').count(), 1, 'el correo va en el title del autor');
      assert.ok(rows.every((r) => r.hasGraph), 'todas tienen celda de grafo');
    });
    it('el commit actual (HEAD) va en negrita', async () => {
      const cls = await ui.rowOf('chore: after merge').locator('span.text-ellipsis').first().getAttribute('class');
      assert.match(cls ?? '', /font-semibold/);
      assert.doesNotMatch((await ui.rowOf('fix: tweak a').locator('span.text-ellipsis').first().getAttribute('class')) ?? '', /font-semibold/);
    });
    it('el commit de merge se atenúa (texto apagado)', async () => {
      assert.match((await ui.rowOf('merge: side').locator('span.text-ellipsis').first().getAttribute('class')) ?? '', /text-muted/);
      assert.doesNotMatch((await ui.rowOf('fix: tweak a').locator('span.text-ellipsis').first().getAttribute('class')) ?? '', /text-muted/);
    });
    it('la cabecera de columnas está presente', async () => {
      const t = await ui.page.locator('gt-viewer').innerText();
      for (const h of ['Grafo', 'Mensaje', 'Autor', 'Fecha', 'Commit']) assert.ok(t.includes(h), `falta columna ${h}`);
    });
    it('la fila "Cambios sin commit" cuenta los archivos y se oculta con un filtro de archivo o búsqueda', async () => {
      const btn = ui.page.getByRole('button', { name: /Cambios sin commit \(2\)/ });
      await btn.waitFor();
      await ui.search.fill('merge');
      await ui.search.press('Enter');
      await btn.waitFor({ state: 'detached', timeout: 5000 });
      await resetFilters();
      await btn.waitFor();
    });
  });

  describe('selección', () => {
    it('clic simple selecciona una fila (aria-selected) y las demás no', async () => {
      await ui.rowOf('fix: tweak a').click();
      await ui.expectSelected(['fix: tweak a']);
      await ui.rowOf('feat: util').click();
      await ui.expectSelected(['feat: util']);
    });
    it('Ctrl+clic añade y quita filas de la selección; el detalle muestra la primera', async () => {
      await ui.rowOf('fix: tweak a').click();
      await ui.rowOf('feat: util').click({ modifiers: ['Control'] });
      await ui.expectSelected(['feat: util', 'fix: tweak a']);
      await until(async () => (await ui.detailSubject()) === 'fix: tweak a', 'el detalle muestra la primera seleccionada');
      await ui.rowOf('fix: tweak a').click({ modifiers: ['Control'] });
      await ui.expectSelected(['feat: util']);
      await ui.rowOf('docs: second').click();
      await ui.expectSelected(['docs: second']);
    });
    it('Mayús+clic selecciona el rango entre dos filas', { todo: 'Shift+clic no está implementado: sólo Ctrl/Cmd' }, async () => {
      await ui.rowOf('chore: after merge').click();
      await ui.rowOf('merge: side').click({ modifiers: ['Shift'] });
      const sel = await ui.selectedSubjects();
      assert.ok(sel.length >= 2, `el rango debía tener varias filas: ${sel.join()}`);
    });
    it('clic derecho sobre una fila no seleccionada la selecciona; sobre una seleccionada conserva la multi-selección', async () => {
      await ui.rowOf('fix: tweak a').click();
      await ui.rowOf('feat: util').click({ modifiers: ['Control'] });
      await ui.rowOf('docs: second').click({ button: 'right' });
      await ui.menu.waitFor();
      await ui.expectSelected(['docs: second']);
      await ui.page.keyboard.press('Escape');
      await ui.rowOf('fix: tweak a').click();
      await ui.rowOf('feat: util').click({ modifiers: ['Control'] });
      await ui.rowOf('feat: util').click({ button: 'right' });
      await ui.menu.waitFor();
      assert.equal((await ui.selectedSubjects()).length, 2);
      await ui.page.keyboard.press('Escape');
    });
  });

  describe('búsqueda y filtros', () => {
    it('buscar por mensaje: sólo con Enter, sin distinguir mayúsculas; vaciar restaura', async () => {
      await ui.search.fill('RENAME');
      await sleep(600);
      assert.equal((await ui.subjects()).length, gitSubjects().length, 'escribir sin Enter no filtra');
      await ui.search.press('Enter');
      await ui.waitRows((s) => s.length === 1, 'filtrado por mensaje');
      assert.deepEqual(await ui.subjects(), ['refactor: rename a']);
      await ui.search.fill('');
      await ui.search.press('Enter');
      await ui.waitRows((s) => s.length === gitSubjects().length, 'restaurado');
    });
    it('buscar por hash corto devuelve exactamente ese commit', async () => {
      const short = g('rev-parse', '--short', h('fix: tweak a'));
      await ui.search.fill(short);
      await ui.search.press('Enter');
      await ui.waitRows((s) => s.length === 1, 'un resultado por hash');
      assert.deepEqual(await ui.subjects(), ['fix: tweak a']);
      await resetFilters();
    });
    it('el texto sin coincidencias deja la lista vacía', async () => {
      await ui.search.fill('zzz-no-existe');
      await ui.search.press('Enter');
      await ui.waitRows((s) => s.length === 0, 'sin resultados');
      await resetFilters();
    });
    it('una búsqueda sin resultados no dice que el repositorio no tiene commits', { todo: 'se muestra "Este repositorio aún no tiene commits." incluso con la búsqueda sin resultados' }, async () => {
      await ui.search.fill('zzz-no-existe');
      await ui.search.press('Enter');
      await ui.waitRows((s) => s.length === 0, 'sin resultados');
      const msg = await ui.page.locator('gt-viewer').innerText();
      await resetFilters();
      assert.doesNotMatch(msg, /aún no tiene commits/);
    });
    it('buscar por autor (sintaxis autor:nombre) devuelve sus commits', async () => {
      await ui.search.fill('autor:Bob Builder');
      await ui.search.press('Enter');
      await sleep(900);
      const want = gitSubjects('--author=Bob Builder');
      const got = await ui.subjects();
      await resetFilters();
      assert.deepEqual(got, want, 'autor:nombre filtra por autor');
    });
    it('Escape en el cuadro de búsqueda lo vacía y restaura la lista', async () => {
      await ui.search.fill('rename');
      await ui.search.press('Enter');
      await ui.waitRows((s) => s.length === 1, 'filtrado');
      await ui.search.press('Escape');
      await ui.waitRows((s) => s.length === gitSubjects().length, 'restaurado con Escape');
      assert.equal(await ui.search.inputValue(), '');
    });
    it('"Solo la rama actual" oculta lo que no es alcanzable desde HEAD; "Todas" lo devuelve', async () => {
      assert.ok((await ui.subjects()).includes('feat: login'));
      await ui.scopeSelect.selectOption('current');
      const want = g('log', '--topo-order', 'HEAD', '--format=%s').split('\n');
      await ui.waitRows((s) => s.length === want.length, 'sólo HEAD');
      assert.deepEqual(await ui.subjects(), want);
      assert.ok(!(await ui.subjects()).includes('feat: login'));
      assert.ok(!(await ui.subjects()).includes('x: extra two'));
      await ui.scopeSelect.selectOption('all');
      await ui.waitRows((s) => s.includes('feat: login'), 'todas las ramas');
    });
    it('"Solo primer padre" oculta los commits de la rama fusionada y se puede desmarcar', async () => {
      // con todas las ramas la lateral también es "primer padre" de su propia punta: la lista coincide con git
      await ui.firstParent.check();
      const want = gitSubjects('--first-parent');
      await until(async () => (await ui.search.count()) === 1 && (await ui.firstParent.isChecked()), 'casilla marcada');
      await sleep(600);
      assert.deepEqual(await ui.subjects(), want);
      await ui.firstParent.uncheck();
      await sleep(600);
      assert.deepEqual(await ui.subjects(), gitSubjects());
    });
    it('rama actual + primer padre se combinan', async () => {
      await ui.scopeSelect.selectOption('current');
      await ui.firstParent.check();
      const want = g('log', '--topo-order', '--first-parent', 'HEAD', '--format=%s').split('\n');
      await ui.waitRows((s) => s.length === want.length, 'combinado');
      assert.deepEqual(await ui.subjects(), want);
      assert.ok(!want.includes('s1: side one') && (await ui.subjects()).includes('merge: side'), 'sin los commits de la rama fusionada');
      await resetFilters();
    });
    it('el filtro de archivo muestra un chip, restringe la lista (siguiendo renombres) y el botón lo quita', async () => {
      await ui.rowOf('refactor: rename a').click();
      await ui.page.locator('gt-viewer li[title="src/alpha.ts"]').click({ button: 'right' });
      await ui.menu.waitFor();
      await ui.page.locator('[role=menuitem]').filter({ hasText: /^Historial del archivo$/ }).click();
      await ui.chip.waitFor();
      assert.match(await ui.chip.innerText(), /Historial de src\/alpha\.ts/);
      const want = g('log', '--follow', '--topo-order', '--format=%s', '--', 'src/alpha.ts').split('\n');
      await ui.waitRows((s) => s.length === want.length, 'historial del archivo');
      assert.deepEqual(await ui.subjects(), want);
      assert.ok(want.includes('chore: init'), 'siguió el rename hasta el original');
      assert.equal(await ui.page.getByRole('button', { name: /Cambios sin commit/ }).count(), 0, 'sin fila de cambios con filtro de archivo');
      await ui.chip.locator('button').click();
      await ui.chip.waitFor({ state: 'detached' });
      await ui.waitRows((s) => s.length === gitSubjects().length, 'lista completa');
    });
  });

  describe('panel de detalle', () => {
    it('sin selección pide elegir un commit (y no hay panel de autor)', async () => {
      await ui.page.keyboard.press('Escape');
      // un repositorio recién abierto no tiene selección; aquí se comprueba el mensaje con la selección vacía
      const n = (await ui.selectedSubjects()).length;
      if (n === 0) assert.match(await details(ui).innerText(), /Selecciona un commit/);
    });
    it('autor, correo, committer distinto, cuerpo, padres, estadísticas y archivos', async () => {
      await ui.rowOf('feat: util').click();
      await until(async () => (await ui.detailSubject()) === 'feat: util', 'detalle');
      const d = details(ui);
      const t = await d.innerText();
      assert.ok(t.includes('Dan Dev'));
      assert.ok(t.includes('<dan@example.com>'));
      assert.match(t, /Committer: Carol Committer/);
      assert.ok(t.includes('Body line 1') && t.includes('Body line 2'), 'cuerpo del mensaje');
      assert.match(t, /Padres:/);
      assert.match(t, /1 archivo\(s\) cambiado\(s\)/);
      assert.equal((await d.locator('.text-diff-add').first().innerText()).trim(), '+3');
      assert.match((await d.locator('.text-diff-del').first().innerText()).trim(), /^[−-]0$/);
      assert.deepEqual(await d.locator('ul li[title]').evaluateAll((l) => l.map((e) => e.getAttribute('title'))), ['src/util.ts']);
      assert.equal(await d.locator('span.rounded-full').first().innerText(), 'DD', 'iniciales del autor');
    });
    it('si autor y committer coinciden no se muestra el committer', async () => {
      await ui.rowOf('fix: tweak a').click();
      await until(async () => (await ui.detailSubject()) === 'fix: tweak a', 'detalle');
      assert.doesNotMatch(await details(ui).innerText(), /Committer:/);
    });
    it('el botón de hash copia el hash completo', async () => {
      await ui.rowOf('fix: tweak a').click();
      await until(async () => (await ui.detailSubject()) === 'fix: tweak a', 'detalle');
      const btn = details(ui).locator('button[title="Copiar hash"]');
      assert.equal((await btn.innerText()).trim(), g('rev-parse', '--short', h('fix: tweak a')));
      await btn.click();
      assert.equal((await ui.clip()).at(-1), h('fix: tweak a'));
    });
    it('el enlace de padre navega al commit padre', async () => {
      await ui.rowOf('fix: tweak a').click();
      await until(async () => (await ui.detailSubject()) === 'fix: tweak a', 'detalle');
      const parent = details(ui).locator('button.mono:not([title])');
      assert.equal(await parent.count(), 1);
      assert.equal((await parent.innerText()).trim(), h('fix: tweak a').slice(0, 0) + g('rev-parse', `${h('fix: tweak a')}^`).slice(0, 8));
      await parent.click();
      await until(async () => (await ui.detailSubject()) === 'feat: util', 'navegó al padre');
      assert.deepEqual(await ui.selectedSubjects(), ['feat: util']);
    });
    it('un commit de merge enlaza a sus dos padres', async () => {
      await ui.rowOf('merge: side').click();
      await until(async () => (await ui.detailSubject()) === 'merge: side', 'detalle merge');
      const parents = details(ui).locator('button.mono:not([title])');
      assert.equal(await parents.count(), 2);
      await parents.nth(1).click();
      await until(async () => (await ui.detailSubject()) === 's2: side two', 'segundo padre');
    });
    it('el commit raíz no tiene padres', async () => {
      await ui.rowOf('chore: init').click();
      await until(async () => (await ui.detailSubject()) === 'chore: init', 'detalle raíz');
      assert.doesNotMatch(await details(ui).innerText(), /Padres:/);
    });
    it('lista letras A/M/D/R y el primer archivo se abre solo', async () => {
      await ui.rowOf('refactor: rename a').click();
      await until(async () => (await ui.detailSubject()) === 'refactor: rename a', 'detalle');
      const items = details(ui).locator('ul li[title]');
      await items.first().waitFor();
      const rows = await items.evaluateAll((l) => l.map((e) => [e.getAttribute('title'), (e.querySelector('span')?.textContent ?? '').trim(), e.className.includes('bg-selected')]));
      const letters = Object.fromEntries(rows.map((r) => [r[0], r[1]]));
      assert.equal(letters['src/alpha.ts'], 'R');
      assert.equal(letters['docs-old.txt'], 'D');
      assert.equal(rows.filter((r) => r[2]).length, 1, 'un archivo seleccionado');
      assert.equal(rows[0][2], true, 'el primero');
    });
    it('clic en un archivo muestra su diff (renombrado y borrado)', async () => {
      const d = details(ui);
      await d.locator('ul li[title="docs-old.txt"]').click();
      await until(async () => /docs-old\.txt/.test(await d.locator('gt-diff-viewer').innerText()), 'diff del borrado');
      assert.match(await d.locator('gt-diff-viewer').innerText(), /old/);
      await d.locator('ul li[title="src/alpha.ts"]').click();
      await sleep(1200);
      const txt = await d.locator('gt-diff-viewer').innerText();
      assert.match(txt, /renombrado|renamed/i, `el diff de un archivo renombrado debe indicarlo; muestra: ${txt.slice(0, 160).replace(/\n/g, ' | ')}`);
    });
    it('clic en un archivo de un commit con contenido muestra las líneas añadidas', async () => {
      await ui.rowOf('feat: util').click();
      await until(async () => (await ui.detailSubject()) === 'feat: util', 'detalle');
      await until(async () => (await details(ui).locator('gt-diff-viewer').innerText()).includes('export const v = 2;'), 'diff con contenido');
    });
  });

  describe('visor de diff dentro del detalle', () => {
    it('los botones unificado / lado a lado cambian el modo y el contenido sigue visible', async () => {
      await ui.rowOf('feat: util').click();
      await until(async () => (await ui.detailSubject()) === 'feat: util', 'detalle');
      const d = details(ui);
      await d.locator('button[title="Lado a lado"]').click();
      await until(async () => /bg-hover/.test((await d.locator('button[title="Lado a lado"]').getAttribute('class')) ?? ''), 'modo dividido activo');
      assert.doesNotMatch((await d.locator('button[title="Unificado"]').getAttribute('class')) ?? '', /bg-hover/);
      await until(async () => (await d.locator('gt-diff-viewer').innerText()).includes('export const w = 3;'), 'contenido en modo dividido');
      await d.locator('button[title="Unificado"]').click();
      await until(async () => /bg-hover/.test((await d.locator('button[title="Unificado"]').getAttribute('class')) ?? ''), 'modo unificado activo');
    });
  });

  describe('menú contextual de un archivo del commit', () => {
    it('archivo modificado/renombrado: historial, blame, checkout y copiar ruta; archivo borrado: sólo historial y copiar', async () => {
      await ui.rowOf('refactor: rename a').click();
      await until(async () => (await ui.detailSubject()) === 'refactor: rename a', 'detalle');
      const d = details(ui);
      assert.deepEqual(await ui.items(d.locator('ul li[title="src/alpha.ts"]')), [
        'Historial del archivo',
        'Blame (autoría por línea)',
        `Checkout (${g('rev-parse', '--short', h('refactor: rename a'))})`,
        'Copiar ruta',
      ]);
      assert.deepEqual(await ui.items(d.locator('ul li[title="docs-old.txt"]')), ['Historial del archivo', 'Copiar ruta']);
    });
    it('Copiar ruta', async () => {
      await ui.ctx(details(ui).locator('ul li[title="src/alpha.ts"]'), /^Copiar ruta$/);
      assert.equal((await ui.clip()).at(-1), 'src/alpha.ts');
    });
    it('Blame abre el diálogo con la autoría de cada línea y un clic en el hash lleva al commit', async () => {
      await ui.rowOf('fix: tweak a').click();
      await until(async () => (await ui.detailSubject()) === 'fix: tweak a', 'detalle');
      await ui.ctx(details(ui).locator('ul li[title="src/a.ts"]'), /^Blame/);
      await ui.waitDialog(/Blame: src\/a\.ts/);
      await ui.dialog.locator('tbody tr').first().waitFor();
      const want = g('blame', '-l', h('fix: tweak a'), '--', 'src/a.ts').split('\n');
      assert.equal(await ui.dialog.locator('tbody tr').count(), want.length);
      const dialogText = await ui.dialog.innerText();
      assert.ok(dialogText.includes('export const a = 2;'));
      assert.ok(dialogText.includes('Bob Builder'));
      await ui.dialog.locator('tbody tr td').first().click();
      await ui.dialog.waitFor({ state: 'detached', timeout: 5000 });
    });
    it('Checkout (hash) restaura el archivo desde ese commit', async () => {
      await ui.rowOf('fix: tweak a').click();
      await until(async () => (await ui.detailSubject()) === 'fix: tweak a', 'detalle');
      const target = path.join(fx.repo, 'src', 'a.ts');
      assert.ok(!existsSync(target));
      await ui.ctx(details(ui).locator('ul li[title="src/a.ts"]'), /^Checkout \(/);
      await until(() => existsSync(target), 'archivo restaurado');
      assert.equal(readFileSync(target, 'utf8'), g('show', `${h('fix: tweak a')}:src/a.ts`) + '\n');
      gitSoft(fx.repo, 'reset', '-q');
      rmSync(target);
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ H. Historial: menú contextual de commits ════════════════════════════ */

describe('historial: menú contextual de commits (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  let baseMain = '';
  const g = (...a: string[]) => fx.g(...a);
  const h = (subject: string) => g('log', '--all', '-1', '--format=%H', '--fixed-strings', `--grep=${subject}`);
  const current = () => g('branch', '--show-current');
  const row = (subject: string) => ui.rowOf(subject);
  let loginHash = '';

  before(async () => {
    fx = historyRepo();
    loginHash = fx.g('rev-parse', 'feature/login');
    // la URL de fetch apunta a un puerto cerrado de localhost (nada sale a la red); los push siguen yendo al bare local
    g('remote', 'set-url', 'origin', 'https://localhost:9/acme/demo.git');
    g('config', 'remote.origin.pushurl', fx.bare);
    baseMain = g('rev-parse', 'main');
    ui = await boot(fx);
    await ui.scroller.waitFor();
    await ui.waitRows((s) => s.length > 5, 'historial cargado');
  });
  after(() => shutdown(ui, fx));
  beforeEach(async () => {
    await ui.closeAll();
    const dirty = g('rev-parse', 'HEAD') !== baseMain || current() !== 'main' || g('for-each-ref', 'refs/heads', 'refs/tags').split('\n').length !== BASE_BRANCHES.length + BASE_TAGS.length;
    if (dirty) {
      restoreRefs(fx, baseMain);
      await refresh(ui);
    }
    await ui.waitRows((s) => s.includes('chore: init'), 'historial cargado');
    await row('chore: init').click(); // selección simple conocida
    await ui.expectSelected(['chore: init']);
  });

  async function back() {
    await ui.closeAll();
    restoreRefs(fx, baseMain);
    await refresh(ui);
    await ui.waitRows((s) => s.includes('chore: after merge'), 'historial recargado');
  }

  describe('contenido', () => {
    it('commit sin refs: acciones de commit (sin checkout de ramas ni merge)', async () => {
      const items = await ui.items(row('fix: tweak a'));
      for (const re of [
        /^Checkout de este commit/,
        /^Crear rama aquí/,
        /^Crear tag aquí/,
        /^Rebase de la rama actual sobre este commit/,
        /^Rebase interactivo desde aquí/,
        /^Cherry-pick$/,
        /^Revertir commit$/,
        /^Reset de la rama actual hasta aquí/,
        /^Copiar hash$/,
        /^Copiar mensaje$/,
        /^Guardar como parche/,
        /^Abrir en el navegador$/,
      ])
        assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
      assert.ok(!items.some((i) => /^Checkout (?!de este)/.test(i) || /^Merge/.test(i)), `sobran ramas: ${items.join(' | ')}`);
    });
    it('commit con una rama no actual: checkout de la rama y merge en la actual', async () => {
      const items = await ui.items(row('x: extra two'));
      assert.ok(items.includes('Checkout extra'), items.join(' | '));
      assert.ok(items.includes('Merge en la rama actual: extra → main'), items.join(' | '));
    });
    it('commit con rama remota: ofrece checkout de la remota (y de la local si es otra)', async () => {
      const items = await ui.items(row('s2: side two'));
      for (const l of ['Checkout side', 'Checkout origin/side', 'Merge en la rama actual: side → main']) assert.ok(items.includes(l), `falta ${l}: ${items.join(' | ')}`);
    });
    it('el commit de la rama actual no ofrece checkout de ella misma ni merge', async () => {
      const items = await ui.items(row('chore: after merge'));
      assert.ok(!items.includes('Checkout main') && !items.some((i) => /^Merge/.test(i)), items.join(' | '));
      assert.ok(items.includes('Checkout origin/main'));
    });
    it('multi-selección: sólo lo que admite varios commits', async () => {
      await row('fix: tweak a').click();
      await row('feat: util').click({ modifiers: ['Control'] });
      await ui.expectSelected(['fix: tweak a', 'feat: util']);
      const items = await ui.items(row('feat: util'));
      for (const re of [/^Cherry-pick$/, /^Revertir commit$/, /^Copiar hash$/, /^Guardar como parche/]) assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
      for (const re of [/^Checkout de este commit/, /^Crear rama/, /^Crear tag/, /^Rebase/, /^Reset/, /^Copiar mensaje/, /^Abrir en el navegador/])
        assert.ok(!items.some((i) => re.test(i)), `sobra ${re}: ${items.join(' | ')}`);
    });
    it('el menú no incluye amend/reword/squash/fixup/compare/export como entradas propias', async () => {
      const items = (await ui.items(row('fix: tweak a'))).join(' | ');
      for (const word of ['amend', 'Enmendar', 'squash', 'fixup', 'Comparar']) assert.ok(!new RegExp(word, 'i').test(items), `inesperado: ${word}`);
    });
  });

  describe('acciones de un commit', () => {
    it('Checkout de una rama del commit', async () => {
      await ui.ctx(row('s2: side two'), /^Checkout side$/);
      await until(() => current() === 'side', 'en side');
      await back();
    });
    it('Checkout de la remota (existe la local): cambia a la local con seguimiento', async () => {
      await ui.ctx(row('s2: side two'), /^Checkout origin\/side$/);
      await until(() => current() === 'side', 'en side');
      assert.equal(g('rev-parse', 'HEAD'), h('s2: side two'));
      await back();
    });
    it('Checkout de este commit (HEAD separado)', async () => {
      await ui.ctx(row('fix: tweak a'), /^Checkout de este commit/);
      await until(() => g('rev-parse', 'HEAD') === h('fix: tweak a'), 'HEAD en el commit');
      assert.equal(current(), '');
      await until(async () => (await ui.page.getByText(/HEAD separado en/).count()) > 0, 'la barra lo muestra');
      await back();
    });
    it('Crear rama aquí… parte del hash del commit', async () => {
      await ui.ctx(row('fix: tweak a'), /^Crear rama aquí/);
      await ui.waitDialog(/Crear rama/);
      assert.equal(await ui.page.locator('#fd-start').inputValue(), h('fix: tweak a'));
      await ui.fill('fd-name', 'branch-here');
      await ui.confirm();
      await until(() => current() === 'branch-here', 'rama creada');
      assert.equal(g('rev-parse', 'HEAD'), h('fix: tweak a'));
      await back();
    });
    it('Crear tag aquí…', async () => {
      await ui.ctx(row('feat: util'), /^Crear tag aquí/);
      await ui.waitDialog(/Crear tag/);
      assert.equal(await ui.page.locator('#fd-ref').inputValue(), h('feat: util'));
      await ui.fill('fd-name', 'tag-here');
      await ui.fill('fd-message', 'mensaje del tag');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'tag', '-l', 'tag-here') === 'tag-here', 'tag creado');
      assert.equal(g('rev-list', '-n1', 'tag-here'), h('feat: util'));
      assert.equal(g('tag', '-l', '--format=%(contents)', 'tag-here'), 'mensaje del tag');
      await back();
    });
    it('Merge en la rama actual (rama sin fusionar)', async () => {
      await ui.ctx(row('x: extra two'), /^Merge en la rama actual: extra/);
      await ui.waitDialog(/Merge/);
      assert.equal(await ui.page.locator('#fd-ref').inputValue(), 'extra');
      await ui.confirm();
      await until(() => gitSoft(fx.repo, 'merge-base', '--is-ancestor', 'extra', 'HEAD') === '' && g('rev-parse', 'HEAD') !== baseMain, 'merge hecho');
      assert.ok(existsSync(path.join(fx.repo, 'e2.txt')));
      await back();
    });
    it('Rebase de la rama actual sobre este commit', async () => {
      g('checkout', '-qb', 'rbtest', h('docs: second'));
      commitFile(fx, 'rb.txt', 'rb\n', 'rb: work');
      await refresh(ui);
      await ui.ctx(row('chore: after merge'), /^Rebase de la rama actual sobre este commit/);
      await ui.waitDialog(/Rebase/);
      assert.equal(await ui.page.locator('#fd-onto').inputValue(), 'main', 'con una rama en ese commit se usa su nombre');
      await ui.confirm();
      await until(() => g('merge-base', 'rbtest', 'main') === baseMain, 'rebase hecho');
      assert.equal(g('log', '-1', '--format=%s'), 'rb: work');
      await back();
    });
    it('Cherry-pick de un commit de otra rama', async () => {
      await ui.ctx(row('feat: login'), /^Cherry-pick$/);
      await until(() => g('log', '-1', '--format=%s') === 'feat: login', 'cherry-pick aplicado');
      assert.notEqual(g('rev-parse', 'HEAD'), loginHash, 'es un commit nuevo');
      assert.ok(existsSync(path.join(fx.repo, 'src', 'login.ts')));
      await back();
    });
    it('Cherry-pick de varios commits conserva el orden cronológico (clic en el más nuevo primero)', async () => {
      await row('x: extra two').click();
      await row('x: extra one').click({ modifiers: ['Control'] });
      await ui.ctx(row('x: extra one'), /^Cherry-pick$/);
      await until(() => g('log', '-1', '--format=%s') === 'x: extra one' || g('log', '-1', '--format=%s') === 'x: extra two', 'aplicados', 15000);
      await until(() => g('rev-list', '--count', `${baseMain}..HEAD`) === '2', 'dos commits aplicados');
      assert.deepEqual(g('log', '--format=%s', '-2').split('\n'), ['x: extra two', 'x: extra one']);
      await back();
    });
    it('Cherry-pick de varios commits conserva el orden cronológico (clic en el más antiguo primero)', async () => {
      await row('x: extra one').click();
      await row('x: extra two').click({ modifiers: ['Control'] });
      await ui.ctx(row('x: extra two'), /^Cherry-pick$/);
      await until(() => gitSoft(fx.repo, 'rev-list', '--count', `${baseMain}..HEAD`) === '2', 'dos commits aplicados', 15000);
      const got = g('log', '--format=%s', '-2').split('\n');
      await back();
      assert.deepEqual(got, ['x: extra two', 'x: extra one'], 'el orden de aplicación depende del orden de los clics, no de la historia');
    });
    it('Revertir commit crea un commit de reversión', async () => {
      await ui.ctx(row('chore: after merge'), /^Revertir commit$/);
      await until(() => g('log', '-1', '--format=%s') === 'Revert "chore: after merge"', 'revert hecho');
      assert.ok(!existsSync(path.join(fx.repo, 'after.txt')));
      await back();
    });
    it('Revertir varios commits a la vez', async () => {
      await row('chore: after merge').click();
      await row('feat: main only').click({ modifiers: ['Control'] });
      await ui.ctx(row('feat: main only'), /^Revertir commit$/);
      await until(() => g('rev-list', '--count', `${baseMain}..HEAD`) === '2', 'dos reversiones');
      assert.ok(!existsSync(path.join(fx.repo, 'after.txt')) && !existsSync(path.join(fx.repo, 'main-only.txt')));
      await back();
    });
  });

  describe('Reset', () => {
    const target = () => h('fix: tweak a');
    async function openReset() {
      await ui.ctx(row('fix: tweak a'), /^Reset de la rama actual hasta aquí/);
      await ui.waitDialog(/Reset/);
      assert.equal(await ui.page.locator('#fd-target').inputValue(), target());
    }
    it('cancelar no mueve la rama', async () => {
      await openReset();
      await ui.cancel();
      assert.equal(g('rev-parse', 'HEAD'), baseMain);
    });
    it('soft: mueve la rama y deja los cambios preparados', async () => {
      await openReset();
      await ui.dialog.locator('input[type=radio]').nth(0).check();
      await ui.confirm();
      await until(() => g('rev-parse', 'HEAD') === target(), 'rama movida');
      assert.notEqual(g('diff', '--cached', '--name-only'), '', 'índice conserva los cambios');
      assert.ok(existsSync(path.join(fx.repo, 'after.txt')));
      await back();
    });
    it('mixed (por defecto): mueve la rama, vacía el índice y conserva los archivos', async () => {
      await openReset();
      assert.equal(await ui.dialog.locator('input[type=radio]').nth(1).isChecked(), true);
      await ui.confirm();
      await until(() => g('rev-parse', 'HEAD') === target(), 'rama movida');
      assert.equal(g('diff', '--cached', '--name-only'), '');
      assert.ok(existsSync(path.join(fx.repo, 'after.txt')), 'archivo conservado como no rastreado');
      assert.match(g('status', '--porcelain'), /\?\? after\.txt/);
      await back();
    });
    it('hard: avisa del descarte, mueve la rama y limpia el árbol', async () => {
      await openReset();
      assert.equal(await ui.dialog.getByText(/elimina tus cambios sin commit/).count(), 0, 'sin aviso en mixed');
      await ui.dialog.locator('input[type=radio]').nth(3).check();
      await ui.dialog.getByText(/elimina tus cambios sin commit/).waitFor();
      await ui.confirm();
      await until(() => g('rev-parse', 'HEAD') === target(), 'rama movida');
      assert.equal(g('status', '--porcelain'), '');
      assert.ok(!existsSync(path.join(fx.repo, 'after.txt')));
      await back();
    });
    it('keep: conserva los cambios locales si no hay conflicto', async () => {
      appendFileSync(path.join(fx.repo, 'README.md'), 'local edit\n');
      await openReset();
      await ui.dialog.locator('input[type=radio]').nth(2).check();
      await ui.confirm();
      await until(() => g('rev-parse', 'HEAD') === target(), 'rama movida');
      assert.ok(readFileSync(path.join(fx.repo, 'README.md'), 'utf8').includes('local edit'));
      await back();
    });
  });

  describe('Copiar y exportar', () => {
    it('Copiar hash copia el hash completo (varios: separados por espacio, en orden de selección)', async () => {
      await ui.ctx(row('fix: tweak a'), /^Copiar hash$/);
      assert.equal((await ui.clip()).at(-1), h('fix: tweak a'));
      await row('feat: util').click();
      await row('docs: second').click({ modifiers: ['Control'] });
      await ui.expectSelected(['feat: util', 'docs: second']);
      await ui.ctx(row('docs: second'), /^Copiar hash$/);
      assert.equal((await ui.clip()).at(-1), `${h('feat: util')} ${h('docs: second')}`);
    });
    it('Copiar mensaje copia asunto y cuerpo', async () => {
      await ui.ctx(row('feat: util'), /^Copiar mensaje$/);
      assert.equal((await ui.clip()).at(-1), g('log', '-1', '--format=%B', h('feat: util')).trim());
      assert.match((await ui.clip()).at(-1) ?? '', /^feat: util\n\nBody line 1\nBody line 2$/);
    });
    it('Guardar como parche… escribe el .patch en la carpeta elegida; cancelar no escribe nada', async () => {
      const out = mkdtempSync(path.join(fx.base, 'patches-'));
      await ui.app.electron.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      await ui.ctx(row('feat: util'), /^Guardar como parche/);
      await sleep(900);
      assert.deepEqual(readdirSync(out), []);
      await ui.pickDirectory(out);
      await ui.ctx(row('feat: util'), /^Guardar como parche/);
      await until(() => readdirSync(out).length === 1, 'parche escrito');
      const file = readdirSync(out)[0];
      assert.match(file, /^0001-feat-util\.patch$/);
      assert.match(readFileSync(path.join(out, file), 'utf8'), /Subject: \[PATCH\] feat: util/);
    });
    it('Guardar como parche… con varios commits escribe un parche por commit', async () => {
      const out = mkdtempSync(path.join(fx.base, 'patches-'));
      await ui.pickDirectory(out);
      await row('x: extra one').click();
      await row('x: extra two').click({ modifiers: ['Control'] });
      await ui.expectSelected(['x: extra one', 'x: extra two']);
      await ui.ctx(row('x: extra two'), /^Guardar como parche/);
      await until(() => readdirSync(out).length === 2, 'dos parches');
      assert.ok(readdirSync(out).some((f) => /extra-one/.test(f)) && readdirSync(out).some((f) => /extra-two/.test(f)));
    });
    it('Abrir en el navegador abre la URL del commit en el sitio del remoto', async () => {
      await ui.ctx(row('fix: tweak a'), /^Abrir en el navegador$/);
      await until(async () => (await ui.shellCalls()).external.length > 0, 'openExternal llamado');
      const url = (await ui.shellCalls()).external.at(-1) ?? '';
      assert.match(url, new RegExp(`^https://localhost(:9)?/acme/demo/commit/${h('fix: tweak a')}$`));
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ I. Rebase interactivo ════════════════════════════ */

describe('historial: rebase interactivo (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  let baseLin = '';
  const g = (...a: string[]) => fx.g(...a);
  const linLog = () => g('log', '--reverse', '--format=%s', 'main..lin').split('\n').filter(Boolean);
  const items = () => ui.dialog.locator('ol li');

  before(async () => {
    fx = historyRepo();
    g('checkout', '-qb', 'lin', 'main');
    for (const n of [1, 2, 3, 4]) commitFile(fx, `l${n}.txt`, `l${n}\n`, `lin: l${n}`);
    baseLin = g('rev-parse', 'lin');
    ui = await boot(fx);
    await ui.scroller.waitFor();
    await ui.waitRows((s) => s.includes('lin: l4'), 'historial con la rama lin');
  });
  after(() => shutdown(ui, fx));
  beforeEach(async () => {
    await ui.closeAll();
    if (g('rev-parse', 'HEAD') !== baseLin || gitSoft(fx.repo, 'status', '--porcelain') !== '') {
      resetTo(fx, 'lin', baseLin);
      await refresh(ui);
    }
    await ui.waitRows((s) => s.includes('lin: l4') && s.includes('lin: l1'), 'historial base');
  });

  async function openFrom(subject: string) {
    await ui.ctx(ui.rowOf(subject), /^Rebase interactivo desde aquí/);
    await ui.waitDialog(/Rebase interactivo/);
    await items().first().waitFor();
  }
  const start = async () => {
    await ui.dialog.locator('.btn.primary').last().click();
  };

  it('el diálogo lista los commits desde el elegido, del más antiguo al más reciente', async () => {
    await openFrom('lin: l1');
    assert.equal(await items().count(), 4);
    const subj = await items().evaluateAll((l) => l.map((e) => (e.querySelector('span.truncate')?.textContent ?? '').trim()));
    assert.deepEqual(subj, ['lin: l1', 'lin: l2', 'lin: l3', 'lin: l4']);
    const hashes = await items().evaluateAll((l) => l.map((e) => (e.querySelector('span.mono')?.textContent ?? '').trim()));
    assert.deepEqual(hashes, g('log', '--reverse', '--format=%H', 'main..lin').split('\n').map((x) => x.slice(0, 8)));
    assert.match(await ui.dialog.innerText(), new RegExp(`Commits desde ${g('rev-parse', 'main').slice(0, 8)}`));
  });

  it('desde un commit intermedio sólo incluye los posteriores', async () => {
    await openFrom('lin: l3');
    assert.equal(await items().count(), 2);
    await ui.cancel();
  });

  it('cada fila ofrece usar, cambiar mensaje, editar, combinar, fixup y descartar; la primera no puede combinarse', async () => {
    await openFrom('lin: l1');
    const opts = await items().nth(1).locator('select option').allInnerTexts();
    assert.deepEqual(opts.map((o) => o.trim()), ['Usar', 'Cambiar mensaje', 'Editar', 'Combinar (squash)', 'Combinar sin mensaje (fixup)', 'Descartar']);
    for (const v of ['squash', 'fixup']) assert.equal(await items().first().locator(`select option[value=${v}]`).isDisabled(), true, `primera: ${v} deshabilitado`);
    assert.equal(await items().nth(1).locator('select option[value=squash]').isDisabled(), false);
    await ui.cancel();
  });

  it('Cancelar (y la X) no cambia el historial', async () => {
    const before = g('rev-parse', 'HEAD');
    await openFrom('lin: l1');
    await items().nth(1).locator('select').selectOption('drop');
    await ui.dialog.locator('.btn.ghost').click();
    await ui.dialog.waitFor({ state: 'detached' });
    assert.equal(g('rev-parse', 'HEAD'), before);
    await openFrom('lin: l1');
    await ui.dialog.locator('header .icon-btn').click();
    await ui.dialog.waitFor({ state: 'detached' });
    assert.equal(g('rev-parse', 'HEAD'), before);
  });

  it('sin cambios, "Iniciar rebase" reaplica los commits tal cual', async () => {
    await openFrom('lin: l1');
    await start();
    await ui.waitNoDialog();
    await sleep(1500);
    assert.deepEqual(linLog(), ['lin: l1', 'lin: l2', 'lin: l3', 'lin: l4']);
  });

  it('Descartar elimina el commit', async () => {
    await openFrom('lin: l1');
    await items().nth(1).locator('select').selectOption('drop');
    assert.match((await items().nth(1).getAttribute('class')) ?? '', /bg-danger-bg/);
    await start();
    await until(() => linLog().length === 3, 'commit descartado', 20000);
    assert.deepEqual(linLog(), ['lin: l1', 'lin: l3', 'lin: l4']);
    assert.ok(!existsSync(path.join(fx.repo, 'l2.txt')));
  });

  it('Cambiar mensaje (reword) reescribe el asunto', async () => {
    await openFrom('lin: l1');
    await items().nth(2).locator('select').selectOption('reword');
    const input = items().nth(2).locator('input[type=text]');
    assert.equal(await input.inputValue(), 'lin: l3', 'parte del asunto actual');
    await input.fill('lin: l3 reworded');
    await start();
    await until(() => linLog().includes('lin: l3 reworded'), 'asunto reescrito', 20000);
    assert.deepEqual(linLog(), ['lin: l1', 'lin: l2', 'lin: l3 reworded', 'lin: l4']);
  });

  it('Combinar (squash) fusiona con el anterior y usa el mensaje indicado', async () => {
    await openFrom('lin: l1');
    await items().nth(1).locator('select').selectOption('squash');
    const msg = items().nth(1).locator('input[type=text]');
    await msg.fill('lin: l1+l2 combinados');
    await start();
    await until(() => linLog().length === 3, 'squash hecho', 20000);
    assert.deepEqual(linLog(), ['lin: l1+l2 combinados', 'lin: l3', 'lin: l4']);
    assert.ok(existsSync(path.join(fx.repo, 'l1.txt')) && existsSync(path.join(fx.repo, 'l2.txt')), 'conserva el contenido de ambos');
  });

  it('Combinar sin mensaje (fixup) conserva el mensaje del anterior', async () => {
    await openFrom('lin: l1');
    await items().nth(2).locator('select').selectOption('fixup');
    await start();
    await until(() => linLog().length === 3, 'fixup hecho', 20000);
    assert.deepEqual(linLog(), ['lin: l1', 'lin: l2', 'lin: l4']);
    assert.ok(existsSync(path.join(fx.repo, 'l3.txt')));
  });

  it('arrastrar reordena las filas y el rebase aplica el nuevo orden', async () => {
    await openFrom('lin: l1');
    await items().nth(3).dispatchEvent('dragstart');
    await items().nth(0).dispatchEvent('dragover');
    await items().nth(0).dispatchEvent('dragend');
    const subj = await items().evaluateAll((l) => l.map((e) => (e.querySelector('span.truncate')?.textContent ?? '').trim()));
    assert.deepEqual(subj, ['lin: l4', 'lin: l1', 'lin: l2', 'lin: l3']);
    await start();
    await until(() => linLog()[0] === 'lin: l4', 'reordenado', 20000);
    assert.deepEqual(linLog(), ['lin: l4', 'lin: l1', 'lin: l2', 'lin: l3']);
  });

  it('un squash arrastrado a la primera posición pasa a "Usar"', async () => {
    await openFrom('lin: l1');
    await items().nth(1).locator('select').selectOption('squash');
    await items().nth(1).dispatchEvent('dragstart');
    await items().nth(0).dispatchEvent('dragover');
    await items().nth(0).dispatchEvent('dragend');
    assert.equal(await items().nth(0).locator('select').inputValue(), 'pick');
    await ui.cancel();
  });

  it('con cambios locales y "autostash" marcado el rebase termina y conserva el cambio', async () => {
    appendFileSync(path.join(fx.repo, 'README.md'), 'cambio local\n');
    await openFrom('lin: l1');
    assert.equal(await ui.dialog.locator('#autostash').isChecked(), true);
    await items().nth(1).locator('select').selectOption('drop');
    await start();
    await until(() => linLog().length === 3, 'rebase con autostash', 20000);
    assert.ok(readFileSync(path.join(fx.repo, 'README.md'), 'utf8').includes('cambio local'), 'el cambio local se restauró');
  });

  it('con cambios locales y "autostash" desmarcado git rechaza el rebase y la rama queda igual', async () => {
    appendFileSync(path.join(fx.repo, 'README.md'), 'cambio local\n');
    await openFrom('lin: l1');
    await ui.dialog.locator('#autostash').uncheck();
    await items().nth(1).locator('select').selectOption('drop');
    await start();
    await sleep(2500);
    assert.deepEqual(linLog(), ['lin: l1', 'lin: l2', 'lin: l3', 'lin: l4']);
    assert.equal(g('rev-parse', 'HEAD'), baseLin);
    assert.ok(readFileSync(path.join(fx.repo, 'README.md'), 'utf8').includes('cambio local'));
  });

  it('Editar detiene el rebase: aparece la operación en curso y se puede abortar desde el menú', async () => {
    await openFrom('lin: l1');
    await items().nth(1).locator('select').selectOption('edit');
    await start();
    await until(() => existsSync(path.join(fx.repo, '.git', 'rebase-merge')), 'rebase detenido', 20000);
    await refresh(ui);
    const menu = await ui.app.menuItems('rebase');
    assert.ok(menu.some((i) => /continuar|continue/i.test(i)), menu.join(' | '));
    assert.ok(menu.some((i) => /abortar|abort/i.test(i)), menu.join(' | '));
    await ui.app.pick('rebase', /abortar|abort/i);
    if (await ui.dialogOpen()) await ui.confirm();
    await until(() => !existsSync(path.join(fx.repo, '.git', 'rebase-merge')), 'rebase abortado', 15000);
    assert.equal(g('rev-parse', 'HEAD'), baseLin);
  });

  it('desde el último commit el diálogo ofrece sólo ese commit', async () => {
    await openFrom('lin: l4');
    assert.equal(await items().count(), 1);
    await ui.cancel();
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

/* ════════════════════════════ J. Diálogos: reflog, estadísticas, treemap, benchmark, config ════════════════════════════ */

describe('diálogos de herramientas (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  const g = (...a: string[]) => fx.g(...a);
  const h = (subject: string) => g('log', '--all', '-1', '--format=%H', '--fixed-strings', `--grep=${subject}`);

  before(async () => {
    fx = historyRepo();
    wip(fx);
    ui = await boot(fx);
    await ui.scroller.waitFor();
    await ui.waitRows((s) => s.length > 5, 'historial cargado');
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  describe('reflog', () => {
    it('lista las entradas del reflog de HEAD (como git) y se cierra con la X', async () => {
      g('stash', '-u', '-q');
      g('checkout', '-q', 'side');
      g('checkout', '-q', 'main');
      g('stash', 'pop', '-q');
      await ui.app.pick('repository', /reflog/i);
      await ui.waitDialog(/Reflog/);
      const want = g('reflog', '--format=%H').split('\n').filter(Boolean);
      await until(async () => (await ui.dialog.locator('li').count()) === Math.min(want.length, 300), 'entradas', 8000);
      const hashes = await ui.dialog.locator('li span.mono:nth-child(2)').allInnerTexts();
      assert.deepEqual(hashes.map((x) => x.trim()), want.map((x) => x.slice(0, 8)));
      assert.match(await ui.dialog.locator('li').first().innerText(), /checkout: moving from side to main/);
      await ui.dialog.locator('header .icon-btn').click();
      await ui.dialog.waitFor({ state: 'detached' });
    });
    it('"Mostrar" selecciona ese commit en el historial y cierra el diálogo', async () => {
      await ui.app.pick('repository', /reflog/i);
      await ui.waitDialog(/Reflog/);
      const entry = ui.dialog.locator('li').filter({ hasText: 'commit: feat: util' }).first();
      await entry.waitFor();
      await entry.getByRole('button', { name: 'Mostrar' }).click();
      await ui.dialog.waitFor({ state: 'detached' });
      await until(async () => (await ui.detailSubject()) === 'feat: util', 'commit mostrado');
      assert.deepEqual(await ui.selectedSubjects(), ['feat: util']);
    });
    it('"Checkout" deja HEAD separado en ese commit', async () => {
      g('stash', '-u', '-q');
      await ui.app.pick('repository', /reflog/i);
      await ui.waitDialog(/Reflog/);
      const entry = ui.dialog.locator('li').filter({ hasText: 'commit: feat: util' }).first();
      await entry.waitFor();
      await entry.getByRole('button', { name: 'Checkout' }).click();
      await ui.dialog.waitFor({ state: 'detached' });
      await until(() => g('rev-parse', 'HEAD') === h('feat: util'), 'HEAD en el commit');
      assert.equal(g('branch', '--show-current'), '');
      g('checkout', '-q', 'main');
      g('stash', 'pop', '-q');
      await refresh(ui);
    });
    it('"Reset aquí" abre el reset con ese commit como destino y lo ejecuta', async () => {
      const tip = g('rev-parse', 'HEAD');
      g('stash', '-u', '-q');
      await ui.app.pick('repository', /reflog/i);
      await ui.waitDialog(/Reflog/);
      const entry = ui.dialog.locator('li').filter({ hasText: 'commit: feat: util' }).first();
      await entry.waitFor();
      await entry.getByRole('button', { name: 'Reset aquí' }).click();
      await ui.waitDialog(/Reset/);
      assert.equal(await ui.page.locator('#fd-target').inputValue(), h('feat: util'));
      await ui.dialog.locator('input[type=radio]').nth(3).check(); // hard
      await ui.confirm();
      await until(() => g('rev-parse', 'HEAD') === h('feat: util'), 'rama movida');
      g('reset', '-q', '--hard', tip);
      g('stash', 'pop', '-q');
      await refresh(ui);
    });
  });

  describe('estadísticas del repositorio', () => {
    it('muestra totales reales, actividad y colaboradores, y se cierra', async () => {
      await ui.app.pick('repository', /Estadísticas/);
      await ui.waitDialog(/Estadísticas del repositorio/);
      await ui.dialog.locator('dl').waitFor();
      const cards = Object.fromEntries(
        await ui.dialog.locator('dl > div').evaluateAll((els) => els.map((e) => [(e.querySelector('dt')?.textContent ?? '').trim(), (e.querySelector('dd')?.textContent ?? '').trim()])),
      );
      assert.equal(cards['Commits'], g('rev-list', '--count', '--all'));
      assert.equal(cards['Ramas'], String(g('for-each-ref', 'refs/heads').split('\n').length));
      assert.equal(cards['Tags'], String(g('tag', '-l').split('\n').length));
      assert.equal(cards['Archivos'], String(g('ls-tree', '-r', '--name-only', 'HEAD').split('\n').length));
      assert.ok(/KiB|MiB|B/.test(cards['Tamaño de .git']), cards['Tamaño de .git']);
      const text = await ui.dialog.innerText();
      assert.ok(text.includes('Bob Builder') && text.includes('Ana Torres'), 'colaboradores');
      const bob = g('shortlog', '-sn', '--all').split('\n').find((l) => l.includes('Bob Builder'))!.trim().split(/\s+/)[0];
      assert.match(text, new RegExp(`Bob Builder[\\s\\S]*?${bob} commit`));
      assert.equal(await ui.dialog.locator('ul[class*="h-32"] li').count(), 12, '12 meses de actividad');
      await ui.dialog.locator('header .icon-btn').click();
      await ui.dialog.waitFor({ state: 'detached' });
    });
  });

  describe('treemap', () => {
    it('muestra el tamaño por carpeta, se navega con clic y se sube con el botón o las migas', async () => {
      await ui.app.pick('repository', /Treemap/);
      await ui.waitDialog(/Treemap/);
      const total = await ui.dialog.getByText(/Total:/).waitFor().then(() => ui.dialog.innerText());
      const files = g('ls-tree', '-r', '--name-only', 'HEAD').split('\n').length;
      assert.match(total, new RegExp(`${files} archivos`));
      const src = ui.dialog.locator('button[aria-label^="src,"]');
      await src.waitFor();
      assert.equal(await ui.dialog.locator('button[title="Subir un nivel"]').isDisabled(), true, 'en la raíz no se sube');
      await src.click();
      await ui.dialog.locator('nav button', { hasText: /^src$/ }).waitFor();
      assert.equal(await ui.dialog.locator('button[title="Subir un nivel"]').isDisabled(), false);
      assert.match(await ui.dialog.innerText(), new RegExp(`${g('ls-tree', '-r', '--name-only', 'HEAD', 'src').split('\n').length} archivos`));
      assert.ok((await ui.dialog.locator('[role=img]').count()) > 0, 'archivos de src');
      await ui.dialog.locator('button[title="Subir un nivel"]').click();
      await ui.dialog.locator('nav button', { hasText: /^src$/ }).waitFor({ state: 'detached' });
      await src.click();
      await ui.dialog.locator('nav button', { hasText: /^Raíz$/ }).click();
      await ui.dialog.locator('nav button', { hasText: /^src$/ }).waitFor({ state: 'detached' });
      await ui.dialog.locator('header .icon-btn').click();
      await ui.dialog.waitFor({ state: 'detached' });
    });
  });

  describe('benchmark', () => {
    it('ejecuta las 7 mediciones, permite repetir y se cierra', async () => {
      await ui.app.pick('repository', /Benchmark/);
      await ui.waitDialog(/Benchmark/);
      assert.equal(await ui.dialog.locator('ul li').count(), 0, 'sin resultados antes de ejecutar');
      await ui.dialog.getByRole('button', { name: 'Ejecutar' }).click();
      await ui.dialog.locator('ul li').first().waitFor({ timeout: 20000 });
      assert.equal(await ui.dialog.locator('ul li').count(), 8, '7 pruebas + total');
      const text = await ui.dialog.innerText();
      for (const t of ['Estado', 'Historial', 'Listar ramas', 'Contar commits', 'Archivos versionados', 'Diferencias', 'Objetos', 'Total']) assert.ok(text.includes(t), `falta ${t}`);
      assert.ok(!text.includes('Falló'), 'ninguna medición falló');
      assert.match(text, /\d+ ms/);
      await ui.dialog.getByRole('button', { name: 'Repetir' }).click();
      await ui.dialog.locator('ul li').first().waitFor();
      await ui.dialog.locator('.btn', { hasText: /^Cerrar$/ }).click();
      await ui.dialog.waitFor({ state: 'detached' });
    });
  });

  describe('editor de configuración', () => {
    it('lista, edita, agrega y quita claves locales; la pestaña global usa su propio archivo', async () => {
      await ui.app.pick('repository', /Editar configuraci/);
      await ui.waitDialog(/Configuración de git/);
      const keyInput = (k: string) => ui.dialog.locator('div.grid', { has: ui.page.locator(`span[title="${k}"]`) }).locator('input');
      await keyInput('user.name').waitFor();
      assert.equal(await keyInput('user.name').inputValue(), 'Ana Torres');
      assert.ok((await ui.dialog.locator('span[title="remote.origin.url"]').count()) === 1);
      // editar
      await keyInput('user.name').fill('Ana Editada');
      await keyInput('user.name').press('Tab');
      await until(() => gitSoft(fx.repo, 'config', '--local', 'user.name') === 'Ana Editada', 'valor editado');
      // agregar
      await ui.dialog.locator('input[name=k]').fill('e2e.nuevo');
      await ui.dialog.locator('input[name=v]').fill('valor-1');
      await ui.dialog.getByRole('button', { name: 'Agregar clave' }).click();
      await until(() => gitSoft(fx.repo, 'config', '--local', 'e2e.nuevo') === 'valor-1', 'clave agregada');
      await ui.dialog.locator('span[title="e2e.nuevo"]').waitFor();
      // quitar
      await ui.dialog.locator('div.grid', { has: ui.page.locator('span[title="e2e.nuevo"]') }).locator('button').click();
      await until(() => gitSoft(fx.repo, 'config', '--local', 'e2e.nuevo') === '', 'clave quitada');
      await ui.dialog.locator('span[title="e2e.nuevo"]').waitFor({ state: 'detached' });
      g('config', '--local', 'user.name', 'Ana Torres');
      // global: archivo aislado, no el del usuario
      await ui.dialog.getByRole('button', { name: 'Global' }).click();
      await ui.dialog.locator('span[title="user.name"]').waitFor();
      // la pestaña recarga de forma asíncrona: se espera el valor global en vez de leer el anterior
      await until(async () => (await keyInput('user.name').inputValue()) === 'Global User', 'valor de la pestaña global');
      assert.ok(!(await ui.dialog.locator('span[title="remote.origin.url"]').count()), 'la global no tiene claves locales');
      await ui.dialog.getByRole('button', { name: 'Este repositorio' }).click();
      await ui.dialog.locator('span[title="remote.origin.url"]').waitFor();
      await ui.dialog.locator('header .icon-btn').click();
      await ui.dialog.waitFor({ state: 'detached' });
    });
    it('el botón "Agregar clave" está deshabilitado sin clave', async () => {
      await ui.app.pick('repository', /Editar configuraci/);
      await ui.waitDialog(/Configuración de git/);
      assert.equal(await ui.dialog.getByRole('button', { name: 'Agregar clave' }).isDisabled(), true);
      await ui.dialog.locator('input[name=k]').fill('x.y');
      assert.equal(await ui.dialog.getByRole('button', { name: 'Agregar clave' }).isDisabled(), false);
      await ui.closeAll();
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(ui.app.pageErrors, []);
  });
});

describe('historial: enlaces a issues (E2E)', { skip }, () => {
  let fx: Fixture;
  let ui: Ui;
  const URL12 = 'https://tracker.test/issues/12';
  const subjectLinks = () => ui.page.locator('gt-viewer h3 a');
  const bodyLinks = () => ui.page.locator('gt-viewer pre a');

  before(async () => {
    fx = sidebarRepo();
    fx.g('config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(fx.repo, 'issue.txt'), 'x\n');
    fx.g('add', 'issue.txt');
    fx.g('commit', '-m', 'Arregla #12 en el login', '-m', 'Refs #34, color #fff y a#9');
    fx.g('config', '--local', 'gitora.issueUrl', 'https://tracker.test/issues/{id}');
    ui = await boot(fx);
    await ui.scroller.waitFor();
    await ui.stubShell();
  });
  after(() => shutdown(ui, fx));
  beforeEach(() => ui.closeAll());

  it('las referencias del resumen y de la descripción son enlaces; los "#" que no lo son, no', async () => {
    await ui.rowOf('Arregla #12').click();
    await subjectLinks().first().waitFor();
    assert.equal(await subjectLinks().count(), 1);
    assert.equal(await subjectLinks().first().innerText(), '#12');
    assert.equal(await subjectLinks().first().getAttribute('href'), URL12);
    assert.equal(await ui.page.locator('gt-viewer h3').innerText(), 'Arregla #12 en el login', 'el texto no cambia');
    assert.equal(await bodyLinks().count(), 1, 'solo #34: ni "#fff" ni "a#9"');
    assert.equal(await bodyLinks().first().getAttribute('href'), 'https://tracker.test/issues/34');
    assert.equal(await ui.page.locator('gt-viewer pre').innerText(), 'Refs #34, color #fff y a#9');
  });

  it('un clic pide abrir la dirección en el navegador y no navega dentro de la app', async () => {
    await ui.rowOf('Arregla #12').click();
    await subjectLinks().first().waitFor();
    const before = ui.page.url();
    await subjectLinks().first().click();
    await until(async () => (await ui.shellCalls()).external.includes(URL12), 'openExternal con la dirección del issue');
    assert.equal(ui.page.url(), before);
  });

  it('control negativo: sin regla en git config ni remoto conocido no hay enlaces', async () => {
    fx.g('config', '--local', '--unset', 'gitora.issueUrl');
    await ui.page.keyboard.press('F5');
    await until(async () => {
      await ui.rowOf('Arregla #12').click();
      await ui.page.locator('gt-viewer h3').waitFor();
      return (await subjectLinks().count()) === 0;
    }, 'sin enlaces tras quitar la regla');
    assert.equal(await bodyLinks().count(), 0);
  });
});
