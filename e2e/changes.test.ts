import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Locator } from 'playwright-core';
import { App, Fixture, git, makeFixture } from './helpers';

/**
 * Auditoría E2E del panel Cambios, el visor de diff, el flujo de conflictos y la consola.
 * Abre Gitora (Electron real) sobre un repositorio desechable y comprueba los efectos con git.
 * Requiere pantalla (en CI: `xvfb-run -a ...`) y el build previo.
 */
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');

type Kind = 'conflicted' | 'unstaged' | 'staged';
const TITLE: Record<Kind, string> = { conflicted: 'Conflictos', unstaged: 'Sin preparar', staged: 'Preparados' };
const KEEP_BRANCHES = new Set(['main', 'feature/login']);

let seq = 0;
/** Contenido distinto en cada llamada: los commits de un caso no deben dejar archivos idénticos al siguiente. */
const uniq = () => `${++seq}-${Date.now()}\n`;
const pad = (i: number) => String(i).padStart(2, '0');
const lines = (n: number, f: (i: number) => string = (i) => `line ${pad(i)}`) =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

describe('panel Cambios, visor de diff, conflictos y consola (E2E)', { skip: hasDisplay ? false : 'sin pantalla (usa xvfb-run)' }, () => {
  let fx: Fixture;
  let app: App;
  let g: Fixture['g'];
  const file = (name: string) => path.join(fx.repo, name);
  const head = () => g('rev-parse', 'HEAD');
  const bareRef = (ref: string) => git(fx.bare, 'rev-parse', ref);
  const sh = (...a: string[]): string => {
    try {
      return g(...a);
    } catch {
      return '';
    }
  };
  const gitBuf = (...a: string[]): Buffer => execFileSync('git', a, { cwd: fx.repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const sleep = (ms: number) => app.page.waitForTimeout(ms);
  const hooksDir = () => path.join(fx.repo, '.git', 'hooks');

  async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await cond()) return;
      await sleep(150);
    }
    assert.fail(`tiempo agotado esperando: ${what}`);
  }

  /** Refresca la UI tras cambiar el repo desde fuera (en Linux no se vigila el árbol de trabajo). */
  async function sync(): Promise<void> {
    if ((await app.page.locator('gt-changes').count()) === 0) {
      await app.page.getByText(/Cambios locales/).first().click();
      await app.page.locator('gt-changes').waitFor();
    }
    await app.page.keyboard.press('F5');
    await sleep(900);
  }

  /** Deja el repo en el estado base: limpio, en main, sin operaciones ni ramas extra. */
  function reset(): void {
    for (const a of [['merge', '--abort'], ['rebase', '--abort'], ['cherry-pick', '--abort'], ['revert', '--abort'], ['bisect', 'reset'], ['am', '--abort']]) sh(...a);
    sh('checkout', '-qf', 'main');
    sh('reset', '-q', '--hard', 'HEAD');
    sh('clean', '-fdxq');
    for (const b of sh('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean))
      if (!KEEP_BRANCHES.has(b)) sh('branch', '-D', b);
    sh('stash', 'clear');
    rmSync(path.join(hooksDir(), 'pre-commit'), { force: true });
    sh('config', '--unset-all', 'merge.tool');
  }

  /* ───────── localizadores ───────── */
  const listOf = (k: Kind): Locator =>
    app.page.locator(`xpath=//header[contains(normalize-space(.), '${TITLE[k]}')]/following-sibling::ul[@role='listbox']`);
  const rowOf = (k: Kind, name: string): Locator => listOf(k).locator('[role=option]').filter({ hasText: name });
  const count = (k: Kind) => listOf(k).locator('[role=option]').count();
  const viewer = () => app.page.locator('gt-diff-viewer');
  const viewerPath = () => viewer().locator('span.mono[title]').first();
  const hunks = () => viewer().locator('div.sticky');
  const lineOf = (type: 'add' | 'del' | 'ctx') => viewer().locator(`[data-type=${type}]`);
  const menu = () => app.page.locator('[role=menu]');
  const menuItem = (re: RegExp) => menu().locator('[role=menuitem]').filter({ hasText: re });
  const subjectInput = () => app.page.locator('input[name=subject]');
  const bodyInput = () => app.page.locator('textarea[name=body]');
  const commitBtn = () => app.page.locator('form button[type=submit]');
  const pushBtn = () => app.page.locator('form button', { hasText: 'Commit y push' });
  const counter = () => app.page.locator('form span.absolute');
  const banner = () => app.page.locator('div[role=status]').filter({ hasText: /en curso/ });
  const bannerBtn = (re: RegExp) => banner().locator('button').filter({ hasText: re });
  const consolePanel = () => app.page.locator('gt-console-panel');

  /** Espera (el render es asíncrono) a que la fila tenga el estado de selección indicado. */
  const selected = (k: Kind, name: string, value: boolean) =>
    until(async () => (await rowOf(k, name).getAttribute('aria-selected')) === String(value), `${name} ${value ? '' : 'no '}seleccionado`);

  async function selectRow(k: Kind, name: string): Promise<void> {
    await rowOf(k, name).click();
    await until(async () => (await viewerPath().count()) > 0 && ((await viewerPath().innerText()).includes(name)), `visor con ${name}`);
  }
  async function ctxMenu(k: Kind, name: string): Promise<void> {
    await rowOf(k, name).click({ button: 'right' });
    await menu().waitFor();
  }
  async function pickCtx(k: Kind, name: string, re: RegExp): Promise<void> {
    await ctxMenu(k, name);
    await menuItem(re).first().click();
    await sleep(700);
  }
  async function menuLabels(k: Kind, name: string): Promise<string[]> {
    await ctxMenu(k, name);
    const items = await menu().locator('[role=menuitem]').allInnerTexts();
    await app.page.keyboard.press('Escape');
    await menu().waitFor({ state: 'detached' });
    return items.map((s) => s.split('\n')[0].trim());
  }
  /** Espera a que el diálogo (se monta de forma asíncrona) exista y pulsa su botón principal. */
  const okDialog = async () => {
    await app.dialog.last().waitFor();
    await app.confirm();
  };
  const cancelDialog = async () => {
    await app.dialog.locator('.btn.ghost', { hasText: 'Cancelar' }).click();
    await app.dialog.waitFor({ state: 'detached' });
  };
  const staged = () => g('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const porcelain = () => g('status', '--porcelain');

  async function setConsole(open: boolean): Promise<void> {
    if (((await consolePanel().count()) > 0) !== open) {
      await app.page.keyboard.press('Control+`');
      await sleep(300);
    }
  }

  /** Conflicto de merge real en `c.txt` (dos regiones) y `d.txt` (una región); queda en la rama `ca` con el merge en curso. */
  function makeMergeConflict(): void {
    g('checkout', '-qb', 'ca');
    writeFileSync(file('c.txt'), lines(12, (i) => `base-${pad(i)}`));
    writeFileSync(file('d.txt'), lines(3, (i) => `dbase-${i}`));
    g('add', '-A');
    g('commit', '-qm', 'test: conflict base');
    g('checkout', '-qb', 'cb');
    const side = (who: string) => {
      const c = readFileSync(file('c.txt'), 'utf8').split('\n');
      c[1] = `${who}-2`;
      c[9] = `${who}-10`;
      writeFileSync(file('c.txt'), c.join('\n'));
      const d = readFileSync(file('d.txt'), 'utf8').split('\n');
      d[1] = `${who}-d`;
      writeFileSync(file('d.txt'), d.join('\n'));
      g('add', '-A');
      g('commit', '-qm', `test: ${who} side`);
    };
    side('theirs');
    g('checkout', '-q', 'ca');
    side('ours');
    try {
      g('merge', 'cb');
    } catch {
      /* el conflicto es lo esperado */
    }
  }

  /** Conflicto de una sola región en multi.txt para rebase / cherry-pick / revert. Devuelve los hashes útiles. */
  function lineConflict(kind: 'rebase' | 'cherry-pick' | 'revert'): void {
    const base = head();
    const setLine = (txt: string, msg: string) => {
      const ls = readFileSync(file('multi.txt'), 'utf8').split('\n');
      ls[4] = txt;
      writeFileSync(file('multi.txt'), ls.join('\n'));
      g('commit', '-qam', msg);
    };
    if (kind === 'revert') {
      g('checkout', '-qb', 'rv');
      setLine('line 05 A', 'test: A');
      const a = head();
      setLine('line 05 B', 'test: B');
      try {
        g('revert', '--no-edit', a);
      } catch {
        /* conflicto esperado */
      }
      return;
    }
    g('checkout', '-qb', 'side-1');
    setLine('line 05 SIDE-1', 'test: side one');
    const one = head();
    g('checkout', '-q', base, '-b', 'side-2');
    setLine('line 05 SIDE-2', 'test: side two');
    try {
      if (kind === 'rebase') g('rebase', 'side-1');
      else g('cherry-pick', one);
    } catch {
      /* conflicto esperado */
    }
  }

  before(async () => {
    fx = makeFixture();
    g = fx.g;
    // Archivos versionados que usan los casos de diff
    g('config', 'core.autocrlf', 'false');
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.hooksPath', hooksDir());
    mkdirSync(hooksDir(), { recursive: true });
    writeFileSync(file('multi.txt'), lines(40));
    writeFileSync(file('crlf.txt'), lines(20).replace(/\n/g, '\r\n'));
    writeFileSync(file('bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
    writeFileSync(file('todel.txt'), 'bye\n');
    writeFileSync(file('ren.txt'), lines(10, (i) => `rename me ${i}`));
    g('add', '-A');
    g('commit', '-qm', 'test: diff fixtures');
    reset();
    app = await App.launch(fx);
  });
  after(async () => {
    await app?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await app.closeAll();
    reset();
    await setConsole(false);
    await sync();
    // El formulario de commit vive en el componente: se deja limpio entre casos
    await subjectInput().fill('');
    await bodyInput().fill('');
    // El campo y los chips de co-autores también viven en el componente: se dejan vacíos entre casos
    const coInputEl = app.page.locator('input[name=coauthor]');
    if (await coInputEl.count()) await coInputEl.fill('');
    const removeChip = app.page.getByRole('button', { name: /Quitar al co-autor/ });
    while ((await removeChip.count()) > 0) await removeChip.first().click();
    for (const id of ['amend', 'signoff', 'noverify']) await app.page.locator(`#${id}`).uncheck();
  });

  /* ═════════════════════ lista de cambios ═════════════════════ */
  describe('lista de cambios', () => {
    it('sin cambios muestra el estado vacío y desaparece al crear un archivo', async () => {
      await app.page.getByText(/No hay cambios/).waitFor();
      assert.equal(await count('unstaged'), 0);
      writeFileSync(file('n.txt'), 'n\n');
      await sync();
      assert.equal(await app.page.getByText(/No hay cambios/).count(), 0);
      assert.equal(await count('unstaged'), 1);
    });

    it('cada tipo de cambio muestra su letra (M, U, D, A, R)', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('untr.txt'), 'u\n');
      rmSync(file('todel.txt'));
      writeFileSync(file('added.txt'), 'a\n');
      g('add', 'added.txt');
      g('mv', 'ren.txt', 'renamed.txt');
      await sync();
      const letter = async (k: Kind, n: string) => (await rowOf(k, n).locator('span[data-kind]').innerText()).trim();
      assert.equal(await letter('unstaged', 'README.md'), 'M');
      assert.equal(await letter('unstaged', 'untr.txt'), 'U');
      assert.equal(await letter('unstaged', 'todel.txt'), 'D');
      assert.equal(await letter('staged', 'added.txt'), 'A');
      assert.equal(await letter('staged', 'renamed.txt'), 'R');
      // El renombrado muestra de dónde viene
      assert.match(await rowOf('staged', 'renamed.txt').innerText(), /ren\.txt/);
    });

    it('un clic selecciona la fila y abre su diff; los demás archivos quedan sin seleccionar', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('untr.txt'), 'u\n');
      await sync();
      await selectRow('unstaged', 'README.md');
      await selected('unstaged', 'README.md', true);
      await selected('unstaged', 'untr.txt', false);
      assert.match(await viewerPath().innerText(), /README\.md/);
      await selectRow('unstaged', 'untr.txt');
      await selected('unstaged', 'untr.txt', true);
      await selected('unstaged', 'README.md', false);
    });

    it('sin selección el visor pide elegir un archivo', async () => {
      writeFileSync(file('untr.txt'), 'u\n');
      await sync();
      await viewer().getByText(/Selecciona un archivo/).waitFor();
    });

    it('Ctrl+clic suma filas a la selección múltiple y el menú contextual actúa sobre todas', async () => {
      for (const n of ['m1.txt', 'm2.txt', 'm3.txt']) writeFileSync(file(n), `${n}\n`);
      await sync();
      await rowOf('unstaged', 'm1.txt').click({ modifiers: ['Control'] });
      await rowOf('unstaged', 'm2.txt').click({ modifiers: ['Control'] });
      await selected('unstaged', 'm1.txt', true);
      await selected('unstaged', 'm2.txt', true);
      await selected('unstaged', 'm3.txt', false);
      // Ctrl+clic de nuevo la quita
      await rowOf('unstaged', 'm2.txt').click({ modifiers: ['Control'] });
      await selected('unstaged', 'm2.txt', false);
      await rowOf('unstaged', 'm2.txt').click({ modifiers: ['Control'] });
      await pickCtx('unstaged', 'm1.txt', /^Preparar$/);
      await until(() => staged().length === 2, 'dos archivos preparados');
      assert.deepEqual(staged().sort(), ['m1.txt', 'm2.txt']);
      assert.equal(await rowOf('unstaged', 'm3.txt').count(), 1);
    });

    it('un clic normal tras una selección múltiple la limpia', async () => {
      for (const n of ['m1.txt', 'm2.txt', 'm3.txt']) writeFileSync(file(n), `${n}\n`);
      await sync();
      await rowOf('unstaged', 'm1.txt').click({ modifiers: ['Control'] });
      await rowOf('unstaged', 'm2.txt').click({ modifiers: ['Control'] });
      await rowOf('unstaged', 'm3.txt').click();
      await selected('unstaged', 'm1.txt', false);
      await selected('unstaged', 'm2.txt', false);
      await selected('unstaged', 'm3.txt', true);
    });

    // Mayús+clic no tiene implementación: select() solo mira ctrl/meta. Se deja como pendiente (todo) con el comportamiento esperado.
    it('Mayús+clic selecciona un rango de filas', { todo: 'select() no implementa el rango con Mayús' }, async () => {
      for (const n of ['m1.txt', 'm2.txt', 'm3.txt']) writeFileSync(file(n), `${n}\n`);
      await sync();
      await rowOf('unstaged', 'm1.txt').click();
      await rowOf('unstaged', 'm3.txt').click({ modifiers: ['Shift'] });
      await selected('unstaged', 'm2.txt', true);
    });

    it('el botón + de la fila prepara solo ese archivo', async () => {
      writeFileSync(file('s1.txt'), '1\n');
      writeFileSync(file('s2.txt'), '2\n');
      await sync();
      await rowOf('unstaged', 's1.txt').hover();
      await rowOf('unstaged', 's1.txt').locator('span[title="Preparar"]').click();
      await until(() => staged().includes('s1.txt'), 's1 preparado');
      assert.ok(!staged().includes('s2.txt'));
      await until(async () => (await rowOf('staged', 's1.txt').count()) === 1, 'fila en preparados');
      assert.equal(await rowOf('unstaged', 's1.txt').count(), 0);
      assert.equal(await rowOf('unstaged', 's2.txt').count(), 1);
    });

    it('el botón - de la fila quita del índice solo ese archivo', async () => {
      writeFileSync(file('s1.txt'), '1\n');
      writeFileSync(file('s2.txt'), '2\n');
      g('add', '-A');
      await sync();
      await rowOf('staged', 's1.txt').hover();
      await rowOf('staged', 's1.txt').locator('span[title="Quitar del índice"]').click();
      await until(() => !staged().includes('s1.txt'), 's1 fuera del índice');
      assert.ok(staged().includes('s2.txt'));
      assert.match(porcelain(), /\?\? s1\.txt/);
      await until(async () => (await rowOf('unstaged', 's1.txt').count()) === 1, 'fila en sin preparar');
    });

    it('Preparar todo prepara modificados, borrados y sin seguimiento', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('untr.txt'), 'u\n');
      rmSync(file('todel.txt'));
      await sync();
      await app.page.getByRole('button', { name: 'Preparar todo' }).click();
      await until(() => !/^.[MD?]/m.test(porcelain()) && staged().length === 3, 'todo preparado');
      assert.deepEqual(staged().sort(), ['README.md', 'todel.txt', 'untr.txt']);
      assert.equal(await count('unstaged'), 0);
    });

    it('Quitar todo deja el índice vacío pero conserva el contenido del árbol de trabajo', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('untr.txt'), 'u\n');
      g('add', '-A');
      await sync();
      await app.page.getByRole('button', { name: 'Quitar todo' }).click();
      await until(() => staged().length === 0, 'índice vacío');
      await until(async () => (await count('unstaged')) === 2, 'dos archivos sin preparar en la lista');
      assert.equal(readFileSync(file('README.md'), 'utf8'), 'changed\n');
      assert.equal(readFileSync(file('untr.txt'), 'utf8'), 'u\n');
      assert.equal(await count('unstaged'), 2);
    });

    it('los botones de lote solo aparecen si hay archivos en la lista', async () => {
      writeFileSync(file('untr.txt'), 'u\n');
      await sync();
      assert.equal(await app.page.getByRole('button', { name: 'Quitar todo' }).count(), 0);
      assert.equal(await app.page.getByRole('button', { name: 'Preparar todo' }).count(), 1);
    });

    it('doble clic prepara un archivo sin preparar y quita uno preparado', async () => {
      writeFileSync(file('d1.txt'), '1\n');
      await sync();
      await rowOf('unstaged', 'd1.txt').dblclick();
      await until(() => staged().includes('d1.txt'), 'doble clic prepara');
      await rowOf('staged', 'd1.txt').dblclick();
      await until(() => !staged().includes('d1.txt'), 'doble clic quita');
      assert.match(porcelain(), /\?\? d1\.txt/);
    });

    it('Descartar todo: cancelar conserva los archivos; confirmar elimina cambios y sin seguimiento', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('untr.txt'), 'u\n');
      writeFileSync(file('multi.txt'), 'staged change\n');
      g('add', 'multi.txt');
      await sync();
      await app.page.getByTitle('Descartar todos los cambios').click();
      await app.dialog.waitFor();
      assert.match(await app.dialog.innerText(), /Los archivos sin seguimiento también se eliminarán/);
      await cancelDialog();
      assert.equal(readFileSync(file('README.md'), 'utf8'), 'changed\n');
      assert.ok(existsSync(file('untr.txt')));
      assert.equal(staged().length, 1);
      await app.page.getByTitle('Descartar todos los cambios').click();
      await app.dialog.waitFor();
      await okDialog();
      await until(() => porcelain() === '', 'repo limpio');
      assert.ok(!existsSync(file('untr.txt')));
      await app.page.getByText(/No hay cambios/).waitFor();
    });
  });

  /* ═════════════════════ menú contextual ═════════════════════ */
  describe('menú contextual de archivo', () => {
    it('sin preparar (modificado): ofrece preparar, descartar, stash, abrir, copiar, historial y blame; sin ignorar', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      await sync();
      const items = await menuLabels('unstaged', 'README.md');
      for (const re of [/^Preparar$/, /Descartar cambios/, /Stash de estos archivos/, /Abrir archivo/, /Mostrar en la carpeta/, /Copiar ruta/, /Historial del archivo/, /Blame/])
        assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
      assert.ok(!items.some((i) => /Ignorar/.test(i)), 'un archivo versionado no debe ofrecer Ignorar');
      assert.ok(!items.some((i) => /Quitar del índice/.test(i)));
    });

    it('sin seguimiento: ofrece ignorar archivo, extensión y carpeta, y no historial ni blame', async () => {
      mkdirSync(file('docs/notes'), { recursive: true });
      writeFileSync(file('docs/notes/x.log'), 'x\n');
      await sync();
      const items = await menuLabels('unstaged', 'x.log');
      for (const re of [/Ignorar archivo/, /Ignorar todos los \*\.log/, /Ignorar carpeta docs\/notes\//])
        assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
      assert.ok(!items.some((i) => /Historial del archivo|Blame/.test(i)));
    });

    it('preparado: ofrece quitar del índice, no descartar; archivo nuevo (A) sin historial ni blame', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('added.txt'), 'a\n');
      g('add', '-A');
      await sync();
      const mod = await menuLabels('staged', 'README.md');
      assert.ok(mod.some((i) => /Quitar del índice/.test(i)));
      assert.ok(mod.some((i) => /Historial del archivo/.test(i)));
      assert.ok(!mod.some((i) => /Descartar cambios/.test(i)), 'no se descarta desde la lista de preparados');
      assert.ok(!mod.some((i) => /^Preparar$/.test(i)));
      const added = await menuLabels('staged', 'added.txt');
      assert.ok(!added.some((i) => /Historial del archivo|Blame/.test(i)));
    });

    it('Preparar y Quitar del índice desde el menú', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      await sync();
      await pickCtx('unstaged', 'README.md', /^Preparar$/);
      await until(() => staged().includes('README.md'), 'preparado');
      await pickCtx('staged', 'README.md', /Quitar del índice/);
      await until(() => staged().length === 0, 'quitado');
      assert.equal(readFileSync(file('README.md'), 'utf8'), 'changed\n');
    });

    it('Descartar cambios: cancelar conserva; confirmar restaura el archivo versionado', async () => {
      const original = readFileSync(file('README.md'), 'utf8');
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('keep.txt'), 'k\n');
      await sync();
      await pickCtx('unstaged', 'README.md', /Descartar cambios/);
      await app.dialog.waitFor();
      await cancelDialog();
      assert.equal(readFileSync(file('README.md'), 'utf8'), 'changed\n');
      await pickCtx('unstaged', 'README.md', /Descartar cambios/);
      await okDialog();
      await until(() => readFileSync(file('README.md'), 'utf8') === original, 'README restaurado');
      assert.ok(existsSync(file('keep.txt')), 'no debe tocar otros archivos');
    });

    it('Descartar cambios de un archivo sin seguimiento lo elimina', async () => {
      writeFileSync(file('gone.txt'), 'g\n');
      writeFileSync(file('keep.txt'), 'k\n');
      await sync();
      await pickCtx('unstaged', 'gone.txt', /Descartar cambios/);
      await okDialog();
      await until(() => !existsSync(file('gone.txt')), 'gone.txt eliminado');
      assert.ok(existsSync(file('keep.txt')));
    });

    it('Descartar cambios sobre una selección múltiple confirma y descarta todos', async () => {
      writeFileSync(file('gone1.txt'), 'g\n');
      writeFileSync(file('gone2.txt'), 'g\n');
      writeFileSync(file('keep.txt'), 'k\n');
      await sync();
      await rowOf('unstaged', 'gone1.txt').click({ modifiers: ['Control'] });
      await rowOf('unstaged', 'gone2.txt').click({ modifiers: ['Control'] });
      await pickCtx('unstaged', 'gone1.txt', /Descartar cambios/);
      assert.match(await app.dialog.innerText(), /2 archivo/);
      await okDialog();
      await until(() => !existsSync(file('gone1.txt')) && !existsSync(file('gone2.txt')), 'ambos eliminados');
      assert.ok(existsSync(file('keep.txt')));
    });

    it('Stash de estos archivos guarda solo el archivo elegido', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      writeFileSync(file('multi.txt'), 'other change\n');
      await sync();
      await pickCtx('unstaged', 'README.md', /Stash de estos archivos/);
      await app.dialog.waitFor();
      await app.fill('fd-message', 'solo readme');
      await okDialog();
      await until(() => g('stash', 'list').includes('solo readme'), 'stash creado');
      assert.equal(g('stash', 'show', '--name-only', 'stash@{0}'), 'README.md');
      assert.equal(readFileSync(file('multi.txt'), 'utf8'), 'other change\n', 'el otro archivo se queda en el árbol de trabajo');
      assert.ok(!/^ ?M README/m.test(porcelain()));
    });

    it('Abrir archivo y Mostrar en la carpeta llaman a shell con la ruta absoluta', async () => {
      await app.electron.evaluate(({ shell }) => {
        const calls = { open: [] as string[], show: [] as string[] };
        (globalThis as Record<string, unknown>)['__calls'] = calls;
        const s = shell as unknown as Record<string, unknown>;
        s['openPath'] = async (p: string) => {
          calls.open.push(p);
          return '';
        };
        s['showItemInFolder'] = (p: string) => {
          calls.show.push(p);
        };
      });
      writeFileSync(file('README.md'), 'changed\n');
      await sync();
      const read = () => app.electron.evaluate(() => (globalThis as Record<string, unknown>)['__calls'] as { open: string[]; show: string[] });
      assert.deepEqual(await read(), { open: [], show: [] });
      await pickCtx('unstaged', 'README.md', /Abrir archivo/);
      await until(async () => (await read()).open.length === 1, 'openPath llamado');
      assert.equal((await read()).open[0], file('README.md'));
      assert.equal((await read()).show.length, 0);
      await pickCtx('unstaged', 'README.md', /Mostrar en la carpeta/);
      await until(async () => (await read()).show.length === 1, 'showItemInFolder llamado');
      assert.equal((await read()).show[0], file('README.md'));
    });

    it('Copiar ruta escribe la ruta relativa en el portapapeles y avisa', async () => {
      await app.page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        w['__clip'] = null;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (t: string) => (w['__clip'] = t) },
        });
      });
      mkdirSync(file('docs'), { recursive: true });
      writeFileSync(file('docs/copy.txt'), 'c\n');
      await sync();
      await pickCtx('unstaged', 'copy.txt', /Copiar ruta/);
      await until(async () => (await app.page.evaluate(() => (window as unknown as Record<string, unknown>)['__clip'])) === 'docs/copy.txt', 'portapapeles');
      await app.page.getByText('Copiado al portapapeles').first().waitFor();
    });

    it('Ignorar archivo / extensión / carpeta escriben en .gitignore y ocultan el archivo', async () => {
      mkdirSync(file('docs/notes'), { recursive: true });
      writeFileSync(file('docs/notes/x.log'), 'x\n');
      writeFileSync(file('other.tmp'), 'x\n');
      writeFileSync(file('also.tmp'), 'x\n');
      writeFileSync(file('single.bak'), 'x\n');
      await sync();
      await pickCtx('unstaged', 'single.bak', /Ignorar archivo/);
      await until(() => existsSync(file('.gitignore')) && readFileSync(file('.gitignore'), 'utf8').includes('single.bak'), 'ignora archivo');
      await sync();
      assert.equal(await rowOf('unstaged', 'single.bak').count(), 0);
      await pickCtx('unstaged', 'other.tmp', /Ignorar todos los \*\.tmp/);
      await until(() => readFileSync(file('.gitignore'), 'utf8').includes('*.tmp'), 'ignora extensión');
      await sync();
      assert.equal(await rowOf('unstaged', 'other.tmp').count(), 0);
      assert.equal(await rowOf('unstaged', 'also.tmp').count(), 0, 'la extensión ignora también el otro .tmp');
      await pickCtx('unstaged', 'x.log', /Ignorar carpeta/);
      await until(() => readFileSync(file('.gitignore'), 'utf8').includes('docs/notes/'), 'ignora carpeta');
      await sync();
      assert.equal(await rowOf('unstaged', 'x.log').count(), 0);
      assert.equal(sh('check-ignore', 'docs/notes/x.log'), 'docs/notes/x.log');
    });

    it('Historial del archivo cambia a la vista de historial filtrada por la ruta', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      await sync();
      await pickCtx('unstaged', 'README.md', /Historial del archivo/);
      await app.page.getByText('Historial de README.md').first().waitFor();
      assert.equal(await app.page.locator('gt-changes').count(), 0);
      await app.page.getByText(/Cambios locales|Local changes/).first().click();
      await app.page.locator('gt-changes').waitFor();
    });

    it('Blame abre el diálogo con el archivo', async () => {
      writeFileSync(file('README.md'), 'changed\n');
      await sync();
      await pickCtx('unstaged', 'README.md', /Blame/);
      await app.dialog.waitFor();
      await until(async () => (await app.dialog.innerText()).includes('README.md'), 'blame con README.md');
      assert.match(await app.dialog.innerText(), /changed/, 'muestra el contenido línea a línea');
      await app.closeAll();
    });
  });

  /* ═════════════════════ visor de diff: hunks y líneas ═════════════════════ */
  describe('hunks y líneas del visor', () => {
    const twoHunks = () => {
      const ls = readFileSync(file('multi.txt'), 'utf8').split('\n');
      ls[2] = 'line 03 CHANGED';
      ls[37] = 'line 38 CHANGED';
      writeFileSync(file('multi.txt'), ls.join('\n'));
    };

    it('muestra dos hunks con sus contadores +/− y las líneas añadidas y eliminadas', async () => {
      twoHunks();
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      assert.equal(await lineOf('add').count(), 2);
      assert.equal(await lineOf('del').count(), 2);
      assert.match(await viewer().locator('span.font-mono').first().innerText(), /\+2\s*−2/);
      assert.match(await lineOf('add').first().innerText(), /line 03 CHANGED/);
    });

    it('Preparar hunk prepara solo el hunk elegido', async () => {
      twoHunks();
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      await hunks().nth(1).getByRole('button', { name: 'Preparar hunk' }).click();
      await until(() => staged().includes('multi.txt'), 'hunk preparado');
      const cached = g('diff', '--cached');
      assert.ok(cached.includes('line 38 CHANGED'));
      assert.ok(!cached.includes('line 03 CHANGED'));
      assert.ok(g('diff').includes('line 03 CHANGED'), 'el otro hunk sigue sin preparar');
      await until(async () => (await hunks().count()) === 1, 'queda un hunk en el visor');
    });

    it('Quitar hunk saca del índice solo ese hunk', async () => {
      twoHunks();
      g('add', 'multi.txt');
      await sync();
      await selectRow('staged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks preparados');
      assert.equal(await viewer().getByRole('button', { name: 'Descartar hunk' }).count(), 0, 'en preparados no se descarta');
      await hunks().nth(0).getByRole('button', { name: 'Quitar hunk' }).click();
      await until(() => g('diff', '--cached').includes('line 38 CHANGED') && !g('diff', '--cached').includes('line 03 CHANGED'), 'primer hunk fuera del índice');
      assert.ok(g('diff').includes('line 03 CHANGED'));
    });

    it('Descartar hunk: cancelar conserva; confirmar revierte solo ese hunk en el árbol de trabajo', async () => {
      twoHunks();
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      await hunks().nth(0).getByRole('button', { name: 'Descartar hunk' }).click();
      await app.dialog.waitFor();
      await cancelDialog();
      assert.ok(readFileSync(file('multi.txt'), 'utf8').includes('line 03 CHANGED'));
      await hunks().nth(0).getByRole('button', { name: 'Descartar hunk' }).click();
      await okDialog();
      await until(() => !readFileSync(file('multi.txt'), 'utf8').includes('line 03 CHANGED'), 'hunk revertido');
      const txt = readFileSync(file('multi.txt'), 'utf8');
      assert.ok(txt.includes('line 38 CHANGED'), 'el otro hunk permanece');
      assert.ok(txt.split('\n').includes('line 03'));
    });

    it('en una lista de conflictos el visor no ofrece acciones de hunk', async () => {
      makeMergeConflict();
      await sync();
      await selectRow('conflicted', 'd.txt');
      assert.equal(await viewer().getByRole('button', { name: /hunk/ }).count(), 0);
      assert.equal(await viewer().getByText(/Haz clic en las líneas/).count(), 0);
    });

    it('seleccionar líneas (clic y Mayús+clic) muestra el contador y Preparar líneas las prepara', async () => {
      twoHunks();
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      // Negative: una línea de contexto no se selecciona
      await lineOf('ctx').first().click();
      assert.equal(await viewer().getByRole('button', { name: /Preparar líneas/ }).count(), 0);
      await lineOf('del').first().click();
      await lineOf('add').first().click({ modifiers: ['Shift'] });
      await viewer().getByRole('button', { name: 'Preparar líneas (2)' }).click();
      await until(() => staged().includes('multi.txt'), 'líneas preparadas');
      const idx = g('show', ':multi.txt').split('\n');
      assert.ok(idx.includes('line 03 CHANGED'));
      assert.ok(!idx.includes('line 03'));
      assert.ok(idx.includes('line 38'), 'el otro hunk no se preparó');
    });

    it('preparar solo la línea añadida deja la eliminada sin preparar', async () => {
      twoHunks();
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      await lineOf('add').first().click();
      await viewer().getByRole('button', { name: 'Preparar líneas (1)' }).click();
      await until(() => staged().includes('multi.txt'), 'línea preparada');
      const idx = g('show', ':multi.txt').split('\n');
      assert.ok(idx.includes('line 03 CHANGED'));
      assert.ok(idx.includes('line 03'), 'la línea eliminada sigue en el índice');
    });

    it('Quitar líneas saca del índice solo la línea elegida', async () => {
      twoHunks();
      g('add', 'multi.txt');
      await sync();
      await selectRow('staged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      await lineOf('add').first().click();
      await viewer().getByRole('button', { name: 'Quitar líneas (1)' }).click();
      await until(() => !g('show', ':multi.txt').split('\n').includes('line 03 CHANGED'), 'línea fuera del índice');
      const idx = g('show', ':multi.txt').split('\n');
      assert.ok(!idx.includes('line 03'), 'la eliminación sigue preparada');
      assert.ok(idx.includes('line 38 CHANGED'));
    });

    it('Descartar líneas (solo una línea añadida): confirma y la quita del árbol de trabajo', async () => {
      const ls = readFileSync(file('multi.txt'), 'utf8').split('\n');
      ls.splice(10, 0, 'INSERTED A', 'INSERTED B');
      writeFileSync(file('multi.txt'), ls.join('\n'));
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 1, 'un hunk');
      await lineOf('add').first().click();
      await viewer().getByRole('button', { name: 'Descartar líneas' }).click();
      await okDialog();
      await until(() => !readFileSync(file('multi.txt'), 'utf8').includes('INSERTED A'), 'línea A descartada');
      const txt = readFileSync(file('multi.txt'), 'utf8');
      assert.ok(txt.includes('INSERTED B'), 'la otra línea permanece');
    });

    it('Descartar líneas de una línea añadida que reemplaza a otra la revierte sin romper el patch', async () => {
      twoHunks();
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      await lineOf('add').first().click();
      await viewer().getByRole('button', { name: 'Descartar líneas' }).click();
      await okDialog();
      await sleep(900);
      const txt = readFileSync(file('multi.txt'), 'utf8');
      assert.ok(!txt.includes('line 03 CHANGED'), 'la línea añadida debía descartarse (el patch parcial no aplicó)');
    });

    it('archivo sin seguimiento: Preparar hunk lo añade completo', async () => {
      writeFileSync(file('untr.txt'), lines(5, (i) => `u${i}`));
      await sync();
      await selectRow('unstaged', 'untr.txt');
      await hunks().first().getByRole('button', { name: 'Preparar hunk' }).click();
      await until(() => staged().includes('untr.txt'), 'untr preparado');
      assert.equal(g('show', ':untr.txt'), 'u1\nu2\nu3\nu4\nu5');
    });

    it('archivo sin seguimiento: Preparar líneas añade solo las seleccionadas', async () => {
      writeFileSync(file('untr.txt'), lines(5, (i) => `u${i}`));
      await sync();
      await selectRow('unstaged', 'untr.txt');
      await lineOf('add').nth(1).click();
      await lineOf('add').nth(2).click();
      await viewer().getByRole('button', { name: 'Preparar líneas (2)' }).click();
      await until(() => staged().includes('untr.txt'), 'untr parcialmente preparado');
      assert.equal(g('show', ':untr.txt'), 'u2\nu3');
      assert.ok(existsSync(file('untr.txt')) && readFileSync(file('untr.txt'), 'utf8') === lines(5, (i) => `u${i}`), 'el árbol de trabajo no cambia');
    });

    it('cambiar de archivo limpia la selección de líneas', async () => {
      twoHunks();
      writeFileSync(file('untr.txt'), 'u\n');
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks');
      await lineOf('add').first().click();
      await viewer().getByRole('button', { name: /Preparar líneas/ }).waitFor();
      await selectRow('unstaged', 'untr.txt');
      assert.equal(await viewer().getByRole('button', { name: /Preparar líneas/ }).count(), 0);
    });
  });

  /* ═════════════════════ modo de vista ═════════════════════ */
  describe('modo unificado / lado a lado', () => {
    const settingsFile = () => path.join(fx.data, 'settings.json');
    const savedMode = () => (JSON.parse(readFileSync(settingsFile(), 'utf8')) as { settings: { diffViewMode: string } }).settings.diffViewMode;

    it('alterna entre ambas vistas y persiste la elección en los ajustes', async () => {
      const ls = readFileSync(file('multi.txt'), 'utf8').split('\n');
      ls[2] = 'line 03 CHANGED';
      writeFileSync(file('multi.txt'), ls.join('\n'));
      await sync();
      await selectRow('unstaged', 'multi.txt');
      assert.equal(await viewer().locator('div.grid-cols-2').count(), 0, 'unificado: sin rejilla de dos columnas');
      await viewer().getByTitle('Lado a lado').click();
      await until(async () => (await viewer().locator('div.grid-cols-2').count()) > 0, 'vista dividida');
      await until(() => existsSync(settingsFile()) && savedMode() === 'split', 'modo split persistido');
      // En el modo dividido la línea eliminada y la añadida comparten fila
      const row = viewer().locator('div.grid-cols-2').filter({ hasText: 'line 03 CHANGED' }).first();
      assert.match(await row.innerText(), /line 03\b/);
      await viewer().getByTitle('Unificado').click();
      await until(async () => (await viewer().locator('div.grid-cols-2').count()) === 0, 'vuelve a unificado');
      await until(() => savedMode() === 'unified', 'modo unified persistido');
    });

    it('en modo dividido también se pueden seleccionar y preparar líneas', async () => {
      const ls = readFileSync(file('multi.txt'), 'utf8').split('\n');
      ls[2] = 'line 03 CHANGED';
      writeFileSync(file('multi.txt'), ls.join('\n'));
      await sync();
      await selectRow('unstaged', 'multi.txt');
      await viewer().getByTitle('Lado a lado').click();
      await until(async () => (await viewer().locator('div.grid-cols-2').count()) > 0, 'vista dividida');
      try {
        await lineOf('add').first().click();
        await viewer().getByRole('button', { name: 'Preparar líneas (1)' }).click();
        await until(() => g('show', ':multi.txt').split('\n').includes('line 03 CHANGED'), 'línea preparada desde split');
      } finally {
        await viewer().getByTitle('Unificado').click();
      }
    });
  });

  /* ═════════════════════ tipos de archivo en el visor ═════════════════════ */
  describe('visor: tipos de archivo', () => {
    it('archivo nuevo sin seguimiento: etiqueta "archivo nuevo" y solo líneas añadidas', async () => {
      writeFileSync(file('fresh.txt'), 'a\nb\nc\n');
      await sync();
      await selectRow('unstaged', 'fresh.txt');
      await viewer().getByText('archivo nuevo').waitFor();
      assert.equal(await lineOf('add').count(), 3);
      assert.equal(await lineOf('del').count(), 0);
    });

    it('archivo eliminado: etiqueta "archivo eliminado" y solo líneas eliminadas', async () => {
      rmSync(file('todel.txt'));
      await sync();
      await selectRow('unstaged', 'todel.txt');
      await viewer().getByText('archivo eliminado').waitFor();
      assert.equal(await lineOf('del').count(), 1);
      assert.equal(await viewer().getByText('archivo nuevo').count(), 0);
    });

    it('archivo renombrado (preparado): indica el origen', async () => {
      g('mv', 'ren.txt', 'moved.txt');
      writeFileSync(file('moved.txt'), readFileSync(file('moved.txt'), 'utf8') + 'extra\n');
      g('add', 'moved.txt');
      await sync();
      await selectRow('staged', 'moved.txt');
      await viewer().getByText(/renombrado desde ren\.txt/).waitFor();
    });

    it('archivo binario modificado: mensaje de binario y sin hunks', async () => {
      writeFileSync(file('bin.dat'), Buffer.from([9, 0, 9, 0, 9, 1, 2, 3]));
      await sync();
      await selectRow('unstaged', 'bin.dat');
      await viewer().getByText(/Archivo binario/).waitFor();
      assert.equal(await hunks().count(), 0);
    });

    it('archivo binario nuevo (sin seguimiento) también muestra el mensaje de binario', async () => {
      writeFileSync(file('new.bin'), Buffer.from([0, 1, 2, 0, 3, 4]));
      await sync();
      await selectRow('unstaged', 'new.bin');
      await viewer().getByText(/Archivo binario/).waitFor();
    });

    const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGO4o6EBRww4OQAa3g4RLYR9sQAAAABJRU5ErkJggg==', 'base64');
    const BLUE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAEUlEQVR4nGPQiLqDFTEMpAQAGdNBof4aAEcAAAAASUVORK5CYII=', 'base64');

    it('imagen PNG nueva (sin seguimiento): muestra la vista previa en vez del aviso de binario', async () => {
      writeFileSync(file('pic.png'), RED);
      await sync();
      await selectRow('unstaged', 'pic.png');
      await viewer().locator('gt-image-diff img').waitFor();
      assert.equal(await viewer().locator('gt-image-diff img').count(), 1, 'solo existe la versión nueva');
      assert.equal(await viewer().getByText(/Archivo binario/).count(), 0);
      assert.equal(await viewer().locator('gt-image-diff button').count(), 0, 'sin versión anterior no hay modos de comparación');
      const src = (await viewer().locator('gt-image-diff img').getAttribute('src')) ?? '';
      assert.ok(src.startsWith('data:image/png;base64,'), 'la imagen llega como data URL PNG');
      await until(async () => (await viewer().locator('gt-image-diff figcaption').innerText()).includes('4 × 3'), 'dimensiones 4 × 3');
    });

    it('imagen PNG modificada: compara antes y después en lado a lado, deslizador y mezcla', async () => {
      writeFileSync(file('pic2.png'), RED);
      g('add', 'pic2.png');
      g('commit', '-m', 'añade pic2');
      writeFileSync(file('pic2.png'), BLUE);
      await sync();
      await selectRow('unstaged', 'pic2.png');
      const imgs = viewer().locator('gt-image-diff img');
      await imgs.first().waitFor();
      await until(async () => (await imgs.count()) === 2, 'dos imágenes');
      const caps = await viewer().locator('gt-image-diff figcaption').allInnerTexts();
      assert.ok(caps[0].includes('Antes') && caps[0].includes('4 × 3'), `antes: ${caps[0]}`);
      assert.ok(caps[1].includes('Después') && caps[1].includes('8 × 6'), `después: ${caps[1]}`);

      await viewer().getByRole('button', { name: 'Deslizador' }).click();
      const slider = viewer().locator('gt-image-diff input[type=range]');
      await slider.fill('30');
      await until(async () => ((await imgs.nth(1).getAttribute('style')) ?? '').includes('70%'), 'recorte al 70 %');

      await viewer().getByRole('button', { name: 'Mezcla' }).click();
      await viewer().locator('gt-image-diff input[type=range]').fill('25');
      await until(async () => ((await imgs.nth(1).getAttribute('style')) ?? '').includes('opacity: 0.25'), 'opacidad 0.25');
    });

    it('imagen PNG preparada compara HEAD contra el índice', async () => {
      writeFileSync(file('pic3.png'), RED);
      g('add', 'pic3.png');
      g('commit', '-m', 'añade pic3');
      writeFileSync(file('pic3.png'), BLUE);
      g('add', 'pic3.png');
      await sync();
      await selectRow('staged', 'pic3.png');
      await until(async () => (await viewer().locator('gt-image-diff img').count()) === 2, 'antes y después');
    });

    it('archivo nuevo vacío (sin seguimiento) muestra el archivo seleccionado, no el aviso de "selecciona un archivo"', async () => {
      writeFileSync(file('empty.txt'), '');
      await sync();
      await rowOf('unstaged', 'empty.txt').click();
      await sleep(900);
      assert.equal(await viewer().getByText(/Selecciona un archivo/).count(), 0, 'el visor ignora la selección de un archivo vacío');
      assert.match(await viewerPath().innerText(), /empty\.txt/);
    });

    it('archivo nuevo vacío preparado: indica que no hay diferencias de contenido', async () => {
      writeFileSync(file('empty.txt'), '');
      g('add', 'empty.txt');
      await sync();
      await selectRow('staged', 'empty.txt');
      await viewer().getByText(/Sin diferencias de contenido/).waitFor();
      await viewer().getByText('archivo nuevo').waitFor();
    });

    it('línea muy larga: el visor la conserva completa y desplaza en horizontal sin romper la página', async () => {
      const long = 'x'.repeat(30000);
      writeFileSync(file('long.txt'), `const v = '${long}';\n`);
      await sync();
      await selectRow('unstaged', 'long.txt');
      const len = await lineOf('add').first().locator('.code').evaluate((e) => (e.textContent ?? '').length);
      assert.ok(len >= 30000, `contenido recortado: ${len}`);
      const m = await app.page.evaluate(() => {
        const sc = document.querySelector('gt-diff-viewer .overflow-auto') as HTMLElement;
        return { inner: sc.scrollWidth > sc.clientWidth, page: document.documentElement.scrollWidth <= window.innerWidth };
      });
      assert.ok(m.inner, 'el visor debía desplazarse en horizontal');
      assert.ok(m.page, 'la página no debe desbordarse');
    });

    it('archivo sin salto de línea final: muestra el marcador ⏎', async () => {
      writeFileSync(file('nonl.txt'), 'a\nb');
      await sync();
      await selectRow('unstaged', 'nonl.txt');
      assert.equal(await lineOf('add').count(), 2);
      assert.ok((await viewer().locator('[data-type=nonewline]').count()) >= 1);
    });

    it('CRLF: Preparar hunk conserva los finales de línea del índice', async () => {
      const ls = readFileSync(file('crlf.txt'), 'utf8').split('\r\n');
      ls[1] = 'line 02 CHANGED';
      ls[18] = 'line 19 CHANGED';
      writeFileSync(file('crlf.txt'), ls.join('\r\n'));
      await sync();
      await selectRow('unstaged', 'crlf.txt');
      await until(async () => (await hunks().count()) === 2, 'dos hunks CRLF');
      await hunks().nth(1).getByRole('button', { name: 'Preparar hunk' }).click();
      await until(() => staged().includes('crlf.txt'), 'hunk CRLF preparado');
      const blob = gitBuf('show', ':crlf.txt').toString('latin1');
      const expected = readFileSync(file('crlf.txt'), 'latin1').replace('line 02 CHANGED', 'line 02');
      assert.equal(blob, expected, 'el índice debía tener el segundo cambio y CRLF en todas las líneas');
    });

    it('CRLF: Preparar líneas sueltas conserva CRLF', async () => {
      const ls = readFileSync(file('crlf.txt'), 'utf8').split('\r\n');
      ls[1] = 'line 02 CHANGED';
      writeFileSync(file('crlf.txt'), ls.join('\r\n'));
      await sync();
      await selectRow('unstaged', 'crlf.txt');
      await lineOf('add').first().click();
      await viewer().getByRole('button', { name: 'Preparar líneas (1)' }).click();
      await until(() => staged().includes('crlf.txt'), 'línea CRLF preparada');
      const blob = gitBuf('show', ':crlf.txt').toString('latin1');
      assert.ok(blob.includes('line 02 CHANGED\r\n'));
      assert.ok(!/[^\r]\n/.test(blob), 'ninguna línea perdió su \\r');
    });

    it('diff enorme (>4000 líneas): pide confirmación y "Mostrar de todos modos" lo despliega', async () => {
      writeFileSync(file('huge.txt'), lines(4500, (i) => `h${i}`));
      await sync();
      await selectRow('unstaged', 'huge.txt');
      await viewer().getByText(/El diff es muy grande/).waitFor();
      assert.equal(await lineOf('add').count(), 0);
      await viewer().getByRole('button', { name: 'Mostrar de todos modos' }).click();
      await until(async () => (await lineOf('add').count()) > 0, 'líneas visibles');
    });

    it('cambio solo de permisos: indica que no hay diferencias de contenido', async () => {
      chmodSync(file('todel.txt'), 0o755);
      await sync();
      await selectRow('unstaged', 'todel.txt');
      await viewer().getByText(/Sin diferencias de contenido/).waitFor();
    });
  });

  /* ═════════════════════ caja de commit ═════════════════════ */
  describe('caja de commit', () => {
    const coInput = () => app.page.locator('input[name=coauthor]');
    const coChips = () => app.page.locator('form span:has(button[aria-label^="Quitar al co-autor"])');
    const ANA = 'Ana Pérez <ana@example.com>';
    const typeBtn = () => app.page.locator('form button[aria-haspopup=menu]');

    it('tipos convencionales: el menú escribe el tipo, lo reemplaza y marca el cambio incompatible', async () => {
      writeFileSync(file('cc1.txt'), uniq());
      g('add', 'cc1.txt');
      await sync();
      await typeBtn().click();
      const labels = (await menu().locator('[role=menuitem]').allInnerTexts()).map((t) => t.split('\n')[0].trim());
      assert.ok(labels.some((l) => l.startsWith('feat')) && labels.some((l) => l.startsWith('revert')), `tipos: ${labels}`);
      await menuItem(/^feat/).first().click();
      await until(async () => (await subjectInput().inputValue()) === 'feat: ', 'prefijo feat');
      assert.ok(await subjectInput().evaluate((el) => el === document.activeElement), 'el foco vuelve al resumen');

      await subjectInput().fill('feat(ui): botón nuevo');
      await typeBtn().click();
      await menuItem(/^fix/).first().click();
      await until(async () => (await subjectInput().inputValue()) === 'fix(ui): botón nuevo', 'tipo reemplazado');

      await typeBtn().click();
      await menuItem(/Cambio incompatible/).first().click();
      await until(async () => (await subjectInput().inputValue()) === 'fix(ui)!: botón nuevo', 'marca !');
      const before = head();
      await commitBtn().click();
      await until(() => head() !== before, 'commit creado');
      assert.equal(g('log', '-1', '--format=%s'), 'fix(ui)!: botón nuevo');
    });

    it('tipos convencionales: un resumen sin tipo conocido no se confunde y el cambio incompatible queda deshabilitado', async () => {
      await subjectInput().fill('Nota: revisar');
      await typeBtn().click();
      assert.equal(await menuItem(/Cambio incompatible/).first().getAttribute('aria-disabled'), 'true');
      await menuItem(/^chore/).first().click();
      await until(async () => (await subjectInput().inputValue()) === 'chore: Nota: revisar', 'prefijo antepuesto');
    });

    it('tipos convencionales: Personalizar guarda los tipos en la config local y vaciarlos restaura los predeterminados', async () => {
      await typeBtn().click();
      await menuItem(/Personalizar tipos/).first().click();
      await app.dialog.last().waitFor();
      await app.dialog.last().locator('input[type=text]').first().fill('feat, deploy, Deploy, mal!');
      await app.confirm();
      await until(() => sh('config', '--local', '--get', 'gitora.commitTypes') === 'feat,deploy', 'config local');
      await app.dialog.last().waitFor({ state: 'detached' });
      await typeBtn().click();
      await menu().waitFor();
      const labels = (await menu().locator('[role=menuitem]').allInnerTexts()).map((t) => t.split('\n')[0].trim());
      assert.ok(labels.some((l) => l === 'deploy'), `propios: ${labels}`);
      assert.ok(!labels.some((l) => l.startsWith('revert')), 'ya no están los predeterminados');
      await app.page.keyboard.press('Escape');

      await typeBtn().click();
      await menuItem(/Personalizar tipos/).first().click();
      await app.dialog.last().waitFor();
      await app.dialog.last().locator('input[type=text]').first().fill('');
      await app.confirm();
      await until(() => sh('config', '--local', '--get', 'gitora.commitTypes') === '', 'config local eliminada');
      await app.dialog.last().waitFor({ state: 'detached' });
      await typeBtn().click();
      await menu().waitFor();
      assert.ok(((await menu().locator('[role=menuitem]').allInnerTexts()).join('|')).includes('revert'));
      await app.page.keyboard.press('Escape');
    });


    it('co-autores: Enter añade un chip sin hacer commit y el commit lleva el trailer', async () => {
      writeFileSync(file('co1.txt'), uniq());
      g('add', 'co1.txt');
      await sync();
      await subjectInput().fill('Trabajo en pareja');
      const before = head();
      await coInput().fill(ANA);
      await coInput().press('Enter');
      await until(async () => (await coChips().count()) === 1, 'chip del co-autor');
      assert.equal(head(), before, 'Enter en el campo no debe hacer commit');
      assert.equal(await coInput().inputValue(), '');
      await commitBtn().click();
      await until(() => head() !== before, 'commit creado');
      assert.equal(g('log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)').trim(), ANA);
      assert.match(g('log', '-1', '--format=%B'), /^Trabajo en pareja\n\nCo-authored-by: Ana Pérez <ana@example\.com>/);
      await until(async () => (await coChips().count()) === 0, 'los co-autores se limpian tras el commit');
    });

    it('co-autores: lo escrito sin pulsar Enter también se incluye, y quitar el chip lo excluye', async () => {
      writeFileSync(file('co2.txt'), uniq());
      g('add', 'co2.txt');
      await sync();
      await subjectInput().fill('Sin Enter');
      await coInput().fill('Luis Gómez <luis@example.com>');
      await commitBtn().click();
      await until(() => g('log', '-1', '--format=%s') === 'Sin Enter', 'commit sin Enter');
      assert.equal(g('log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)').trim(), 'Luis Gómez <luis@example.com>');

      writeFileSync(file('co3.txt'), uniq());
      g('add', 'co3.txt');
      await sync();
      await subjectInput().fill('Quitado');
      await coInput().fill(ANA);
      await coInput().press('Enter');
      await until(async () => (await coChips().count()) === 1, 'chip');
      await app.page.getByRole('button', { name: /Quitar al co-autor/ }).click();
      await until(async () => (await coChips().count()) === 0, 'chip quitado');
      await commitBtn().click();
      await until(() => g('log', '-1', '--format=%s') === 'Quitado', 'commit sin co-autor');
      assert.equal(g('log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly)').trim(), '');
    });

    it('co-autores: un formato inválido avisa y bloquea el commit', async () => {
      writeFileSync(file('co4.txt'), uniq());
      g('add', 'co4.txt');
      await sync();
      await subjectInput().fill('Inválido');
      const before = head();
      await coInput().fill('sin correo');
      await commitBtn().click();
      await app.page.locator('#coauthor-error').waitFor();
      assert.equal(await coInput().getAttribute('aria-invalid'), 'true');
      assert.equal(head(), before, 'no se crea el commit');
      await coInput().fill('Ana <ana@example.com>');
      await until(async () => (await app.page.locator('#coauthor-error').count()) === 0, 'el aviso se quita al corregir');
    });

    it('el botón está deshabilitado sin nada preparado o sin resumen, y avisa cuando falta preparar', async () => {
      writeFileSync(file('c1.txt'), uniq());
      await sync();
      assert.ok(await commitBtn().isDisabled(), 'sin resumen ni preparados');
      await subjectInput().fill('feat: algo');
      assert.ok(await commitBtn().isDisabled(), 'con resumen pero nada preparado');
      await app.page.locator('form p.hint').waitFor();
      assert.match(await app.page.locator('form p.hint').innerText(), /No hay nada preparado/);
      g('add', 'c1.txt');
      await sync();
      assert.ok(await commitBtn().isEnabled(), 'con resumen y un archivo preparado');
      assert.equal(await app.page.locator('form p.hint').count(), 0);
      assert.match(await commitBtn().innerText(), /Hacer commit de 1 archivo/);
      await subjectInput().fill('   ');
      assert.ok(await commitBtn().isDisabled(), 'resumen en blanco');
    });

    it('Commit y push sigue las mismas reglas de habilitación', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      assert.ok(await pushBtn().isDisabled());
      await subjectInput().fill('feat: x');
      assert.ok(await pushBtn().isEnabled());
    });

    it('sin remoto, Commit y push queda deshabilitado aunque se pueda hacer commit', async () => {
      const url = g('remote', 'get-url', 'origin');
      g('remote', 'remove', 'origin');
      try {
        writeFileSync(file('c1.txt'), uniq());
        g('add', 'c1.txt');
        await sync();
        await subjectInput().fill('feat: x');
        assert.ok(await commitBtn().isEnabled());
        assert.ok(await pushBtn().isDisabled(), 'sin remotos no se puede empujar');
      } finally {
        g('remote', 'add', 'origin', url);
        g('fetch', '-q', 'origin');
        g('branch', '-q', '--set-upstream-to=origin/main', 'main');
      }
    });

    it('el contador muestra la longitud y avisa solo por encima de 72', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      const shows = (n: string) => until(async () => (await counter().innerText()).trim() === n, `contador ${n}`);
      await subjectInput().fill('a'.repeat(72));
      await shows('72');
      assert.ok(!(await counter().getAttribute('class'))?.includes('text-warning'), '72 no avisa');
      await subjectInput().fill('a'.repeat(73));
      await shows('73');
      assert.ok((await counter().getAttribute('class'))?.includes('text-warning'), '73 avisa');
      await subjectInput().fill('');
      await shows('0');
    });

    it('commit con resumen y descripción guarda ambos y limpia el formulario', async () => {
      writeFileSync(file('c1.txt'), uniq());
      writeFileSync(file('c2.txt'), uniq());
      g('add', 'c1.txt', 'c2.txt');
      await sync();
      const before = head();
      await subjectInput().fill('feat: dos archivos');
      await bodyInput().fill('Primera línea del cuerpo\n\nSegundo párrafo');
      assert.match(await commitBtn().innerText(), /Hacer commit de 2 archivo/);
      await commitBtn().click();
      await until(() => head() !== before, 'commit creado');
      await until(async () => (await subjectInput().inputValue()) === '', 'formulario limpio');
      assert.equal(g('log', '-1', '--format=%s'), 'feat: dos archivos');
      assert.equal(g('log', '-1', '--format=%b'), 'Primera línea del cuerpo\n\nSegundo párrafo');
      assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['c1.txt', 'c2.txt']);
      assert.equal(g('rev-parse', 'HEAD~1'), before);
      assert.equal(await subjectInput().inputValue(), '');
      assert.equal(await bodyInput().inputValue(), '');
      await app.page.getByText(/Commit [0-9a-f]{8} creado/).first().waitFor();
      assert.equal(await count('staged'), 0);
    });

    it('commit sin descripción no añade cuerpo', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      await subjectInput().fill('chore: solo resumen');
      await commitBtn().click();
      await until(() => g('log', '-1', '--format=%s') === 'chore: solo resumen', 'commit');
      assert.equal(g('log', '-1', '--format=%b'), '');
    });

    it('Enmendar: precarga el mensaje del último commit, cambia el botón y reescribe el commit', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      g('commit', '-qm', 'tmp: primero', '-m', 'cuerpo original');
      writeFileSync(file('c2.txt'), uniq());
      g('add', 'c2.txt');
      await sync();
      const n = g('rev-list', '--count', 'HEAD');
      const old = head();
      const parent = g('rev-parse', 'HEAD~1');
      await app.page.locator('#amend').check();
      await until(async () => (await subjectInput().inputValue()) === 'tmp: primero', 'asunto precargado');
      assert.equal(await bodyInput().inputValue(), 'cuerpo original');
      assert.match(await commitBtn().innerText(), /Enmendar último commit/);
      await subjectInput().fill('tmp: primero v2');
      await commitBtn().click();
      await until(() => head() !== old, 'commit enmendado');
      assert.equal(g('rev-list', '--count', 'HEAD'), n, 'no crea un commit nuevo');
      assert.equal(g('rev-parse', 'HEAD~1'), parent);
      assert.equal(g('log', '-1', '--format=%s'), 'tmp: primero v2');
      assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['c1.txt', 'c2.txt'], 'incluye lo preparado');
      await until(async () => !(await app.page.locator('#amend').isChecked()), 'Enmendar se desmarca tras el commit');
    });

    it('Enmendar permite reescribir solo el mensaje sin nada preparado', async () => {
      const old = head();
      await app.page.locator('#amend').check();
      await until(async () => (await subjectInput().inputValue()) !== '', 'asunto precargado');
      assert.ok(await commitBtn().isEnabled());
      await subjectInput().fill('docs: mensaje nuevo');
      await commitBtn().click();
      await until(() => head() !== old, 'enmienda');
      assert.equal(g('log', '-1', '--format=%s'), 'docs: mensaje nuevo');
    });

    it('sin marcar Enmendar y sin preparados, no hay commit posible aunque haya resumen (control negativo)', async () => {
      const old = head();
      await subjectInput().fill('feat: no debería');
      assert.ok(await commitBtn().isDisabled());
      await subjectInput().press('Control+Enter');
      await sleep(800);
      assert.equal(head(), old);
    });

    it('Firmar añade el trailer Signed-off-by; sin marcar no lo añade', async () => {
      writeFileSync(file('c1.txt'), uniq());
      writeFileSync(file('c2.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      const old = head();
      await subjectInput().fill('feat: sin firma');
      await commitBtn().click();
      await until(() => head() !== old, 'commit sin firma');
      assert.ok(!g('log', '-1', '--format=%B').includes('Signed-off-by'));
      g('add', 'c2.txt');
      await sync();
      const old2 = head();
      await app.page.locator('#signoff').check();
      await subjectInput().fill('feat: con firma');
      await commitBtn().click();
      await until(() => head() !== old2, 'commit firmado');
      assert.match(g('log', '-1', '--format=%B'), /Signed-off-by: Ana Torres <ana@example\.com>/);
      await app.page.locator('#signoff').uncheck();
    });

    it('Omitir hooks: sin marcar, un pre-commit que falla bloquea; marcada, el commit pasa', async () => {
      const hook = path.join(hooksDir(), 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\necho "HOOK BLOQUEA" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      const old = head();
      await subjectInput().fill('feat: con hook');
      await commitBtn().click();
      await sleep(1500);
      assert.equal(head(), old, 'el hook debía bloquear el commit');
      assert.equal(await subjectInput().inputValue(), 'feat: con hook', 'el formulario conserva el texto tras el fallo');
      assert.ok(await commitBtn().isEnabled(), 'el botón vuelve a estar habilitado tras el fallo');
      await app.page.locator('#noverify').check();
      await commitBtn().click();
      await until(() => head() !== old, 'commit con --no-verify');
      assert.equal(g('log', '-1', '--format=%s'), 'feat: con hook');
      await app.page.locator('#noverify').uncheck();
    });

    it('Commit y push crea el commit y lo sube al remoto', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      const old = head();
      await subjectInput().fill('feat: commit y push');
      await pushBtn().click();
      await until(() => head() !== old && bareRef('main') === head(), 'commit subido al remoto', 15000);
      assert.equal(git(fx.bare, 'log', '-1', '--format=%s', 'main'), 'feat: commit y push');
    });

    it('Ctrl+Enter hace commit sin subir; Ctrl+Mayús+Enter hace commit y push', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      const remoteBefore = bareRef('main');
      const old = head();
      await subjectInput().fill('feat: ctrl enter');
      await subjectInput().press('Control+Enter');
      await until(() => head() !== old, 'commit con Ctrl+Enter');
      await sleep(1500);
      assert.equal(bareRef('main'), remoteBefore, 'Ctrl+Enter no sube');
      writeFileSync(file('c2.txt'), uniq());
      g('add', 'c2.txt');
      await sync();
      const old2 = head();
      await bodyInput().fill('desde el cuerpo');
      await subjectInput().fill('feat: ctrl shift enter');
      await bodyInput().press('Control+Shift+Enter');
      await until(() => head() !== old2 && bareRef('main') === head(), 'commit y push con Ctrl+Mayús+Enter', 15000);
      assert.equal(g('log', '-1', '--format=%b'), 'desde el cuerpo');
    });

    it('Enter en el resumen envía el formulario (commit)', async () => {
      writeFileSync(file('c1.txt'), uniq());
      g('add', 'c1.txt');
      await sync();
      const old = head();
      await subjectInput().fill('feat: enter simple');
      await subjectInput().press('Enter');
      await until(() => head() !== old, 'commit con Enter');
    });

    it('un commit con el índice vacío falla sin crear commits y no vacía el formulario (control negativo de Ctrl+Mayús+Enter)', async () => {
      const old = head();
      await subjectInput().fill('feat: nada');
      await subjectInput().press('Control+Shift+Enter');
      await sleep(1000);
      assert.equal(head(), old);
      assert.equal(await subjectInput().inputValue(), 'feat: nada');
    });
  });

  /* ═════════════════════ conflictos ═════════════════════ */
  describe('conflictos de merge', () => {
    it('la lista de conflictos muestra los archivos con "!" y el banner de merge deshabilita Continuar', async () => {
      makeMergeConflict();
      await sync();
      assert.equal(await count('conflicted'), 2);
      assert.equal((await rowOf('conflicted', 'c.txt').locator('span.bg-danger').innerText()).trim(), '!');
      await banner().getByText(/Merge en curso/).waitFor();
      assert.ok(await bannerBtn(/Continuar/).isDisabled(), 'Continuar debe estar deshabilitado con conflictos');
      assert.equal(await bannerBtn(/Omitir/).count(), 0, 'Omitir solo existe en rebase');
      assert.equal(await bannerBtn(/Abortar/).count(), 1);
    });

    it('doble clic y el botón de lápiz abren el resolvedor', async () => {
      makeMergeConflict();
      await sync();
      await rowOf('conflicted', 'd.txt').dblclick();
      await app.dialog.waitFor();
      assert.match(await app.dialog.innerText(), /Resolver conflicto: d\.txt/);
      await app.closeAll();
      await rowOf('conflicted', 'd.txt').hover();
      await rowOf('conflicted', 'd.txt').locator('span[aria-hidden=true]').click();
      await app.dialog.waitFor();
      assert.match(await app.dialog.innerText(), /Resolver conflicto: d\.txt/);
    });

    it('el menú del conflicto ofrece resolver, ours, theirs, marcar resuelto, mergetool, stash y utilidades', async () => {
      makeMergeConflict();
      await sync();
      const items = await menuLabels('conflicted', 'd.txt');
      for (const re of [/Resolver en el editor/, /Resolver con mi versión/, /Resolver con la versión entrante/, /Marcar como resuelto/, /Abrir herramienta de merge/, /Stash de estos archivos/, /Copiar ruta/, /Descartar cambios/])
        assert.ok(items.some((i) => re.test(i)), `falta ${re}: ${items.join(' | ')}`);
    });

    it('menú: Resolver con mi versión (ours) deja la versión local y marca resuelto', async () => {
      makeMergeConflict();
      await sync();
      await pickCtx('conflicted', 'd.txt', /Resolver con mi versión/);
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'd.txt resuelto');
      assert.equal(readFileSync(file('d.txt'), 'utf8'), 'dbase-1\nours-d\ndbase-3\n');
      assert.equal(await rowOf('conflicted', 'd.txt').count(), 0);
      assert.equal(await rowOf('conflicted', 'c.txt').count(), 1, 'el otro conflicto sigue');
    });

    it('menú: Resolver con la versión entrante (theirs)', async () => {
      makeMergeConflict();
      await sync();
      await pickCtx('conflicted', 'd.txt', /Resolver con la versión entrante/);
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'd.txt resuelto');
      assert.equal(readFileSync(file('d.txt'), 'utf8'), 'dbase-1\ntheirs-d\ndbase-3\n');
    });

    it('menú: Marcar como resuelto acepta el archivo tal cual (con marcadores)', async () => {
      makeMergeConflict();
      await sync();
      await pickCtx('conflicted', 'd.txt', /Marcar como resuelto/);
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'd.txt marcado');
      assert.ok(readFileSync(file('d.txt'), 'utf8').includes('<<<<<<<'));
    });

    it('menú: Abrir herramienta de merge ejecuta la herramienta configurada y resuelve', async () => {
      makeMergeConflict();
      g('config', 'merge.tool', 'gt');
      g('config', 'mergetool.gt.cmd', 'cp "$REMOTE" "$MERGED"');
      g('config', 'mergetool.gt.trustExitCode', 'true');
      g('config', 'mergetool.keepBackup', 'false');
      await sync();
      await pickCtx('conflicted', 'd.txt', /Abrir herramienta de merge/);
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'd.txt resuelto por la herramienta', 12000);
      assert.equal(readFileSync(file('d.txt'), 'utf8'), 'dbase-1\ntheirs-d\ndbase-3\n');
    });

    it('menú: Descartar cambios sobre un archivo en conflicto no falla ni deja la UI rota', async () => {
      makeMergeConflict();
      await sync();
      await pickCtx('conflicted', 'd.txt', /Descartar cambios/);
      await okDialog();
      await sleep(1200);
      // Lo correcto es que o bien se descarte (se restaure alguna versión sin marcadores) o se avise; nunca un error sin tratar
      const txt = readFileSync(file('d.txt'), 'utf8');
      assert.ok(!txt.includes('<<<<<<<'), 'Descartar cambios debía quitar el conflicto del archivo');
    });

    it('resolvedor: Guardar está deshabilitado mientras queden marcadores y muestra ambas versiones', async () => {
      makeMergeConflict();
      await sync();
      await rowOf('conflicted', 'c.txt').dblclick();
      await app.dialog.waitFor();
      await until(async () => (await app.dialog.locator('.btn.tiny', { hasText: 'Usar la mía' }).count()) === 2, 'dos bloques');
      const save = app.dialog.locator('.btn.primary', { hasText: 'Guardar y marcar resuelto' });
      assert.ok(await save.isDisabled());
      const text = await app.dialog.innerText();
      assert.ok(text.includes('ours-2') && text.includes('theirs-2') && text.includes('ours-10') && text.includes('theirs-10'));
      assert.ok(text.includes('Mi versión (ours)') && text.includes('Versión entrante (theirs)'));
      assert.match(await app.dialog.locator('textarea').inputValue(), /<<<<<<</);
    });

    it('resolvedor: elegir un bloque con "Usar la mía" y otro con "Usar la entrante" y guardar', async () => {
      makeMergeConflict();
      await sync();
      await rowOf('conflicted', 'c.txt').dblclick();
      await app.dialog.waitFor();
      const ours = app.dialog.locator('.btn.tiny', { hasText: 'Usar la mía' });
      const theirs = app.dialog.locator('.btn.tiny', { hasText: 'Usar la entrante' });
      await until(async () => (await ours.count()) === 2, 'dos bloques');
      const save = app.dialog.locator('.btn.primary', { hasText: 'Guardar y marcar resuelto' });
      await ours.nth(0).click();
      assert.ok(await save.isDisabled(), 'con un bloque sin resolver sigue deshabilitado');
      await theirs.nth(1).click();
      await until(async () => save.isEnabled(), 'Guardar habilitado');
      const result = await app.dialog.locator('textarea').inputValue();
      assert.ok(result.includes('ours-2') && !result.includes('theirs-2'));
      assert.ok(result.includes('theirs-10') && !result.includes('ours-10'));
      await save.click();
      await app.dialog.waitFor({ state: 'detached' });
      await until(() => sh('ls-files', '-u', 'c.txt') === '', 'c.txt resuelto');
      const ls = readFileSync(file('c.txt'), 'utf8').split('\n');
      assert.equal(ls[1], 'ours-2');
      assert.equal(ls[9], 'theirs-10');
      assert.ok(!ls.some((l) => l.startsWith('<<<<<<<') || l.startsWith('>>>>>>>')));
      assert.equal(await rowOf('conflicted', 'c.txt').count(), 0);
    });

    it('resolvedor: "Usar ambas" concatena nuestra y la entrante', async () => {
      makeMergeConflict();
      await sync();
      await rowOf('conflicted', 'd.txt').dblclick();
      await app.dialog.waitFor();
      await app.dialog.locator('.btn.tiny', { hasText: 'Usar ambas' }).click();
      await until(async () => (await app.dialog.locator('textarea').inputValue()) === 'dbase-1\nours-d\ntheirs-d\ndbase-3\n', 'ambas versiones');
      await app.dialog.locator('.btn.primary', { hasText: 'Guardar' }).click();
      await app.dialog.waitFor({ state: 'detached' });
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'd.txt resuelto');
      assert.equal(readFileSync(file('d.txt'), 'utf8'), 'dbase-1\nours-d\ntheirs-d\ndbase-3\n');
    });

    it('resolvedor: "Usar la mía (Todos)" y "Usar la entrante (Todos)" resuelven todos los bloques', async () => {
      makeMergeConflict();
      await sync();
      await rowOf('conflicted', 'c.txt').dblclick();
      await app.dialog.waitFor();
      const area = app.dialog.locator('textarea');
      await app.dialog.locator('.btn.small', { hasText: /Usar la entrante/ }).click();
      await until(async () => !(await area.inputValue()).includes('<<<<<<<'), 'todo con la entrante');
      let r = await area.inputValue();
      assert.ok(r.includes('theirs-2') && r.includes('theirs-10') && !r.includes('ours-2') && !r.includes('<<<<<<<'));
      await app.dialog.locator('.btn.small', { hasText: /Usar la mía/ }).click();
      await until(async () => !(await area.inputValue()).includes('theirs-10'), 'todo con la mía');
      r = await area.inputValue();
      assert.ok(r.includes('ours-2') && r.includes('ours-10') && !r.includes('theirs-2') && !r.includes('<<<<<<<'));
      await app.dialog.locator('.btn.primary', { hasText: 'Guardar' }).click();
      await app.dialog.waitFor({ state: 'detached' });
      await until(() => sh('ls-files', '-u', 'c.txt') === '', 'c.txt resuelto');
      assert.equal(readFileSync(file('c.txt'), 'utf8').split('\n')[1], 'ours-2');
    });

    it('resolvedor: edición manual del resultado; con marcadores no se puede guardar, sin ellos sí', async () => {
      makeMergeConflict();
      await sync();
      await rowOf('conflicted', 'd.txt').dblclick();
      await app.dialog.waitFor();
      const area = app.dialog.locator('textarea');
      const save = app.dialog.locator('.btn.primary', { hasText: 'Guardar' });
      await area.fill('MANUAL\n<<<<<<< x\nmedio\n');
      assert.ok(await save.isDisabled(), 'marcadores residuales bloquean');
      await area.fill('RESULTADO MANUAL\n');
      assert.ok(await save.isEnabled());
      await save.click();
      await app.dialog.waitFor({ state: 'detached' });
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'd.txt resuelto');
      assert.equal(readFileSync(file('d.txt'), 'utf8'), 'RESULTADO MANUAL\n');
    });

    it('resolvedor: Cancelar y la X cierran sin tocar el archivo ni su estado de conflicto', async () => {
      makeMergeConflict();
      await sync();
      const before = readFileSync(file('d.txt'), 'utf8');
      await rowOf('conflicted', 'd.txt').dblclick();
      await app.dialog.waitFor();
      await app.dialog.locator('.btn.tiny', { hasText: 'Usar la mía' }).click();
      await app.dialog.locator('.btn.ghost', { hasText: 'Cancelar' }).click();
      await app.dialog.waitFor({ state: 'detached' });
      assert.equal(readFileSync(file('d.txt'), 'utf8'), before);
      assert.ok(sh('ls-files', '-u', 'd.txt') !== '');
      await rowOf('conflicted', 'd.txt').dblclick();
      await app.dialog.waitFor();
      await app.dialog.locator('header .icon-btn').click();
      await app.dialog.waitFor({ state: 'detached' });
      assert.equal(readFileSync(file('d.txt'), 'utf8'), before);
      assert.equal(await rowOf('conflicted', 'd.txt').count(), 1);
    });

    it('resolvedor: "Abrir herramienta de merge" cierra el diálogo y ejecuta la herramienta', async () => {
      makeMergeConflict();
      g('config', 'merge.tool', 'gt');
      g('config', 'mergetool.gt.cmd', 'cp "$LOCAL" "$MERGED"');
      g('config', 'mergetool.gt.trustExitCode', 'true');
      g('config', 'mergetool.keepBackup', 'false');
      await sync();
      await rowOf('conflicted', 'd.txt').dblclick();
      await app.dialog.waitFor();
      await app.dialog.locator('.btn.ghost', { hasText: 'Abrir herramienta de merge' }).click();
      await app.dialog.waitFor({ state: 'detached' });
      await until(() => sh('ls-files', '-u', 'd.txt') === '', 'resuelto por la herramienta', 12000);
      assert.equal(readFileSync(file('d.txt'), 'utf8'), 'dbase-1\nours-d\ndbase-3\n');
    });

    it('flujo completo: resolver ambos archivos desde la UI y Continuar crea el commit de merge', async () => {
      makeMergeConflict();
      await sync();
      const oursHead = head();
      const theirs = g('rev-parse', 'cb');
      for (const name of ['c.txt', 'd.txt']) {
        await rowOf('conflicted', name).dblclick();
        await app.dialog.waitFor();
        await app.dialog.locator('.btn.small', { hasText: /Usar la entrante/ }).click();
        await app.dialog.locator('.btn.primary', { hasText: 'Guardar' }).click();
        await app.dialog.waitFor({ state: 'detached' });
        await until(() => sh('ls-files', '-u', name) === '', `${name} resuelto`);
      }
      await until(async () => (await count('conflicted')) === 0, 'sin conflictos en la lista');
      await until(async () => bannerBtn(/Continuar/).isEnabled(), 'Continuar habilitado');
      await bannerBtn(/Continuar/).click();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'MERGE_HEAD')), 'merge terminado');
      assert.equal(g('rev-parse', 'HEAD^1'), oursHead);
      assert.equal(g('rev-parse', 'HEAD^2'), theirs);
      assert.equal(readFileSync(file('c.txt'), 'utf8').split('\n')[1], 'theirs-2');
      await until(async () => (await banner().count()) === 0, 'el banner desaparece');
      assert.equal(porcelain(), '');
    });

    it('Abortar el merge (con confirmación) restaura el árbol y quita el banner', async () => {
      makeMergeConflict();
      await sync();
      const h = head();
      await bannerBtn(/Abortar/).click();
      await app.dialog.waitFor();
      await cancelDialog();
      assert.ok(existsSync(path.join(fx.repo, '.git', 'MERGE_HEAD')), 'cancelar no aborta');
      await bannerBtn(/Abortar/).click();
      await okDialog();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'MERGE_HEAD')), 'merge abortado');
      assert.equal(head(), h);
      assert.equal(porcelain(), '');
      await until(async () => (await banner().count()) === 0, 'sin banner');
    });
  });

  /* ═════════════════════ banner de operación ═════════════════════ */
  describe('banner de operación en curso', () => {
    it('sin operación no hay banner (control negativo)', async () => {
      assert.equal(await banner().count(), 0);
    });

    it('rebase simple con conflicto: el banner anuncia un rebase en curso', async () => {
      // git (2.56) crea rebase-merge/interactive también en un rebase simple y `git status` lo llama «interactive»; el banner sigue a git
      lineConflict('rebase');
      await sync();
      await banner().getByText(/Rebase/).waitFor();
      assert.match(await banner().innerText(), /Rebase .*en curso/);
    });

    it('rebase con conflicto: Omitir descarta el commit conflictivo y termina el rebase', async () => {
      lineConflict('rebase');
      await sync();
      await banner().getByText(/Rebase/).waitFor();
      assert.equal(await bannerBtn(/Omitir/).count(), 1);
      assert.equal(await count('conflicted'), 1);
      const tip = g('rev-parse', 'side-1');
      await bannerBtn(/Omitir/).click();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'rebase-merge')), 'rebase terminado');
      assert.equal(head(), tip, 'al omitir el único commit la rama queda en side-1');
      await until(async () => (await banner().count()) === 0, 'sin banner');
    });

    it('rebase con conflicto: resolver y Continuar reescribe el commit sobre la nueva base', async () => {
      lineConflict('rebase');
      await sync();
      await banner().getByText(/Rebase/).waitFor();
      await pickCtx('conflicted', 'multi.txt', /Resolver con la versión entrante/);
      await until(async () => (await count('conflicted')) === 0, 'sin conflictos');
      await until(async () => bannerBtn(/Continuar/).isEnabled(), 'Continuar habilitado');
      await bannerBtn(/Continuar/).click();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'rebase-merge')), 'rebase terminado', 12000);
      assert.equal(g('rev-parse', 'HEAD~1'), g('rev-parse', 'side-1'));
      assert.equal(g('log', '-1', '--format=%s'), 'test: side two');
    });

    it('rebase con conflicto: Abortar vuelve a la rama original', async () => {
      lineConflict('rebase');
      await sync();
      const original = g('rev-parse', 'side-2');
      await banner().getByText(/Rebase/).waitFor();
      await bannerBtn(/Abortar/).click();
      await okDialog();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'rebase-merge')), 'rebase abortado');
      assert.equal(head(), original);
      assert.equal(g('branch', '--show-current'), 'side-2');
    });

    it('cherry-pick con conflicto: no ofrece Omitir; resolver y Continuar crea el commit', async () => {
      lineConflict('cherry-pick');
      await sync();
      await banner().getByText(/Cherry-pick en curso/).waitFor();
      assert.equal(await bannerBtn(/Omitir/).count(), 0);
      assert.ok(await bannerBtn(/Continuar/).isDisabled());
      const before = head();
      await pickCtx('conflicted', 'multi.txt', /Resolver con la versión entrante/);
      await until(async () => bannerBtn(/Continuar/).isEnabled(), 'Continuar habilitado');
      await bannerBtn(/Continuar/).click();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'CHERRY_PICK_HEAD')), 'cherry-pick terminado', 12000);
      assert.notEqual(head(), before);
      assert.equal(g('log', '-1', '--format=%s'), 'test: side one');
    });

    it('cherry-pick con conflicto: Abortar lo cancela', async () => {
      lineConflict('cherry-pick');
      await sync();
      const before = head();
      await banner().getByText(/Cherry-pick en curso/).waitFor();
      await bannerBtn(/Abortar/).click();
      await okDialog();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'CHERRY_PICK_HEAD')), 'cherry-pick abortado');
      assert.equal(head(), before);
    });

    it('revert con conflicto: Abortar lo cancela', async () => {
      lineConflict('revert');
      await sync();
      await banner().getByText(/Revert en curso/).waitFor();
      const before = head();
      await bannerBtn(/Abortar/).click();
      await okDialog();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'REVERT_HEAD')), 'revert abortado');
      assert.equal(head(), before);
    });

    it('revert con conflicto: resolver y Continuar', async () => {
      lineConflict('revert');
      await sync();
      await banner().getByText(/Revert en curso/).waitFor();
      const before = head();
      await pickCtx('conflicted', 'multi.txt', /Resolver con la versión entrante/);
      await until(async () => bannerBtn(/Continuar/).isEnabled(), 'Continuar habilitado');
      await bannerBtn(/Continuar/).click();
      await until(() => !existsSync(path.join(fx.repo, '.git', 'REVERT_HEAD')), 'revert terminado', 12000);
      assert.notEqual(head(), before);
      assert.match(g('log', '-1', '--format=%s'), /^Revert "test: A"/);
    });

    describe('bisect', () => {
      const setupBisect = () => {
        g('checkout', '-qb', 'bis');
        const first = head();
        for (let i = 1; i <= 7; i++) {
          writeFileSync(file(`b${i}.txt`), `${i}\n`);
          g('add', '-A');
          g('commit', '-qm', `bis ${i}`);
        }
        g('bisect', 'start', 'HEAD', first);
        return first;
      };
      const logLen = () => sh('bisect', 'log').split('\n').filter((l) => l.startsWith('git bisect')).length;

      it('muestra Bueno/Malo (sin Continuar ni Omitir) y cada uno registra el veredicto en git', async () => {
        setupBisect();
        await sync();
        await banner().getByText(/Bisect en curso/).waitFor();
        assert.equal(await bannerBtn(/Continuar/).count(), 0);
        assert.equal(await bannerBtn(/Omitir/).count(), 0);
        const n0 = logLen();
        await bannerBtn(/marcar como bueno/).click();
        await until(() => logLen() === n0 + 1, 'veredicto bueno registrado');
        assert.match(sh('bisect', 'log'), /# good: /);
        const n1 = logLen();
        await bannerBtn(/marcar como malo/).click();
        await until(() => logLen() === n1 + 1, 'veredicto malo registrado');
        assert.match(sh('bisect', 'log'), /# bad: /);
        await app.page.getByText(/(Bisecting|revisiones|revisions|bisect)/i).first().waitFor({ timeout: 5000 }).catch(() => undefined);
      });

      it('Abortar termina el bisect y vuelve a la rama original', async () => {
        setupBisect();
        await sync();
        await banner().getByText(/Bisect en curso/).waitFor();
        await bannerBtn(/Abortar/).click();
        await okDialog();
        await until(() => !existsSync(path.join(fx.repo, '.git', 'BISECT_LOG')), 'bisect terminado');
        assert.equal(g('branch', '--show-current'), 'bis');
        await until(async () => (await banner().count()) === 0, 'sin banner');
      });
    });
  });

  /* ═════════════════════ consola ═════════════════════ */
  describe('panel de consola', () => {
    const settingsFile = () => path.join(fx.data, 'settings.json');
    const savedConsole = () => (JSON.parse(readFileSync(settingsFile(), 'utf8')) as { settings: { showConsole: boolean } }).settings.showConsole;

    it('el botón del pie y Ctrl+` la muestran y ocultan, y el estado se guarda en los ajustes', async () => {
      assert.equal(await consolePanel().count(), 0);
      await app.page.locator('footer button', { hasText: 'Consola' }).click();
      await consolePanel().waitFor();
      await until(() => savedConsole() === true, 'showConsole guardado');
      await app.page.locator('footer button', { hasText: 'Consola' }).click();
      await consolePanel().waitFor({ state: 'detached' });
      await until(() => savedConsole() === false, 'showConsole apagado');
      await app.page.keyboard.press('Control+`');
      await consolePanel().waitFor();
      await app.page.keyboard.press('Control+`');
      await consolePanel().waitFor({ state: 'detached' });
    });

    it('el botón X de la cabecera la cierra', async () => {
      await setConsole(true);
      await consolePanel().getByRole('button', { name: 'Cerrar' }).click();
      await consolePanel().waitFor({ state: 'detached' });
    });

    it('muestra los comandos que ejecuta la app con su código de salida', async () => {
      writeFileSync(file('log1.txt'), '1\n');
      await sync();
      await setConsole(true);
      await consolePanel().getByRole('button', { name: 'Limpiar' }).click();
      await rowOf('unstaged', 'log1.txt').hover();
      await rowOf('unstaged', 'log1.txt').locator('span[title="Preparar"]').click();
      await until(async () => (await consolePanel().innerText()).includes('git add -A -- log1.txt'), 'comando add en la consola');
      const entry = consolePanel().locator('div.border-dashed').filter({ hasText: 'git add -A -- log1.txt' }).first();
      assert.match(await entry.innerText(), /ms · 0/);
    });

    it('la línea de comandos ejecuta git, muestra la salida, se vacía y refresca la lista', async () => {
      await setConsole(true);
      const input = consolePanel().locator('input[type=text]');
      await input.fill('log --oneline -1');
      await input.press('Enter');
      await until(async () => (await consolePanel().innerText()).includes('git log --oneline -1'), 'comando en la consola');
      assert.equal(await input.inputValue(), '');
      const out = await consolePanel().locator('pre').allInnerTexts();
      assert.ok(out.some((t) => t.includes(g('log', '-1', '--format=%s'))), 'la salida de git aparece');
    });

    it('un comando que modifica el repo desde la consola actualiza el panel Cambios', async () => {
      writeFileSync(file('viaconsole.txt'), 'x\n');
      await sync();
      await setConsole(true);
      assert.equal(await rowOf('unstaged', 'viaconsole.txt').count(), 1);
      const input = consolePanel().locator('input[type=text]');
      await input.fill('add viaconsole.txt');
      await input.press('Enter');
      await until(() => staged().includes('viaconsole.txt'), 'git add ejecutado desde la consola');
      await until(async () => (await rowOf('staged', 'viaconsole.txt').count()) === 1, 'lista actualizada');
    });

    it('un comando fallido se muestra en rojo con código distinto de 0', async () => {
      await setConsole(true);
      const input = consolePanel().locator('input[type=text]');
      await input.fill('nosuchcommand');
      await input.press('Enter');
      const entry = consolePanel().locator('div.border-dashed').filter({ hasText: 'git nosuchcommand' }).first();
      await entry.waitFor();
      await until(async () => /ms · [1-9]/.test(await entry.innerText()), 'código de error visible');
      assert.ok((await entry.locator('div.flex').first().getAttribute('class'))?.includes('text-danger'));
    });

    it('una entrada vacía no ejecuta nada (control negativo)', async () => {
      await setConsole(true);
      await consolePanel().getByRole('button', { name: 'Limpiar' }).click();
      const input = consolePanel().locator('input[type=text]');
      await input.fill('   ');
      await input.press('Enter');
      await sleep(600);
      assert.equal(await consolePanel().locator('div.border-dashed').count(), 0);
    });

    it('Limpiar vacía el registro y muestra el texto de vacío', async () => {
      await setConsole(true);
      const input = consolePanel().locator('input[type=text]');
      await input.fill('status --short');
      await input.press('Enter');
      await consolePanel().locator('div.border-dashed').first().waitFor();
      await consolePanel().getByRole('button', { name: 'Limpiar' }).click();
      await until(async () => (await consolePanel().locator('div.border-dashed').count()) === 0, 'registro vacío');
      await consolePanel().getByText(/Aquí aparecerá cada comando git/).waitFor();
    });

    it('arrastrar el borde superior cambia la altura de la consola', async () => {
      await setConsole(true);
      const holder = app.page.locator('div.relative', { has: consolePanel() }).last();
      const h0 = (await holder.boundingBox())!.height;
      const handle = app.page.locator('div.cursor-row-resize');
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await app.page.mouse.move(x, y);
      await app.page.mouse.down();
      await app.page.mouse.move(x, y - 80, { steps: 6 });
      await app.page.mouse.up();
      await sleep(300);
      const h1 = (await holder.boundingBox())!.height;
      assert.ok(h1 > h0 + 40, `la altura debía crecer (antes ${h0}, después ${h1})`);
      // y hacia abajo se reduce, con un mínimo de 100px
      const box2 = (await handle.boundingBox())!;
      await app.page.mouse.move(box2.x + 5, box2.y + 3);
      await app.page.mouse.down();
      await app.page.mouse.move(box2.x + 5, box2.y + 900, { steps: 6 });
      await app.page.mouse.up();
      await sleep(300);
      const h2 = (await holder.boundingBox())!.height;
      assert.ok(h2 < h1 && h2 >= 99, `la altura debía reducirse con mínimo 100 (era ${h1}, ahora ${h2})`);
    });

    it('la consola no ofrece botón de copiar (control inexistente)', async () => {
      await setConsole(true);
      assert.equal(await consolePanel().getByRole('button', { name: /Copiar|Copy/ }).count(), 0);
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(app.pageErrors, []);
  });
});
