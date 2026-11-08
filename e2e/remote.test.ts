import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { App, makeRemoteFixture, RemoteFixture, TEST_BRANCH_PREFIX, TEST_TAG_PREFIX } from './helpers';

/**
 * Prueba contra un remoto REAL (GitLab, GitHub...). Solo corre si `GITORA_E2E_REMOTE_URL` está definida
 * (p. ej. `git@gitlab.com:usuario/prueba-gitlab.git`) y usa las credenciales ya configuradas en la máquina.
 * Trabaja únicamente en una rama nueva `gitora-e2e/<marca de tiempo>` y la borra al terminar; nunca empuja
 * a otra rama. `GITORA_E2E_REMOTE_URL=<url> npm run test:e2e`
 */
const url = process.env['GITORA_E2E_REMOTE_URL'];
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');
const skip = !url ? 'define GITORA_E2E_REMOTE_URL para probar contra un remoto real' : hasDisplay ? false : 'sin pantalla (usa xvfb-run)';

describe('remoto real (E2E)', { skip }, () => {
  let fx: RemoteFixture;
  let app: App;
  const head = () => fx.g('rev-parse', 'HEAD');

  /** Crea un archivo, lo prepara y hace commit desde la interfaz. */
  async function commitFromUi(name: string, message: string): Promise<void> {
    writeFileSync(path.join(fx.repo, name), `${message}\n`);
    await app.page.keyboard.press('F5');
    await app.page.getByText(/Cambios locales|Local changes/).first().click();
    await app.page.getByRole('button', { name: /Preparar todo|Stage all/ }).click();
    await app.page.getByPlaceholder(/Resumen|Summary/).fill(message);
    await app.page.getByRole('button', { name: /Hacer commit|^Commit \d/ }).click();
    await app.page.waitForTimeout(1500);
  }

  before(async () => {
    fx = makeRemoteFixture(url as string);
    assert.ok(fx.branch.startsWith(TEST_BRANCH_PREFIX));
    app = await App.launch(fx);
  });
  after(async () => {
    await app?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await app.closeAll();
  });

  it('commit desde la interfaz', async () => {
    await commitFromUi(`${fx.branch.split('/')[1]}-a.txt`, 'test: first e2e commit');
    assert.equal(fx.g('log', '-1', '--format=%s'), 'test: first e2e commit');
  });

  it('Push… crea la rama de prueba en el remoto', async () => {
    assert.equal(fx.remoteHead(), '');
    await app.pick('push', /^Push…/);
    await app.confirm();
    await until(() => fx.remoteHead() === head(), 'la rama de prueba en el remoto');
  });

  it('segundo commit y push rápido', async () => {
    await commitFromUi(`${fx.branch.split('/')[1]}-b.txt`, 'test: second e2e commit');
    await app.page.getByTitle(/^Push \(Ctrl\+Shift\+K\)$/).click();
    await until(() => fx.remoteHead() === head(), 'el remoto igual al local');
  });

  it('Fetch… y Pull… traen un commit hecho por otra persona', async () => {
    const h = fx.remoteCommit(`${fx.branch.split('/')[1]}-remote.txt`, 'test: remote commit');
    await app.pick('fetch', /^Fetch…/);
    await app.confirm();
    await until(() => fx.g('rev-parse', `origin/${fx.branch}`) === h, 'el fetch del commit remoto');
    await app.pick('pull', /^Pull…/);
    await app.confirm();
    await until(() => head() === h, 'el pull del commit remoto');
  });

  it('Push forzado (with-lease) tras un amend', async () => {
    fx.g('commit', '-q', '--amend', '-m', 'test: amended e2e commit');
    await app.pick('push', /forzado|force/i);
    await app.confirm();
    await until(() => fx.remoteHead() === head(), 'el remoto igual al local');
  });

  /** Espera (hasta `ms`) a que una condición sobre el remoto se cumpla: la red real no tiene duración fija. */
  async function until(cond: () => boolean, what: string, ms = 45000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return;
      await app.page.waitForTimeout(1000);
    }
    assert.fail(`tiempo agotado esperando: ${what}`);
  }
  const stamp = () => fx.branch.split('/')[1];
  const file = (name: string) => path.join(fx.repo, name);
  const rebaseInProgress = () => existsSync(path.join(fx.repo, '.git', 'rebase-merge')) || existsSync(path.join(fx.repo, '.git', 'rebase-apply'));

  /** Clic derecho sobre un tag de la barra lateral y elección de un ítem del menú. */
  async function tagMenu(name: string, item: RegExp): Promise<void> {
    if (!(await app.page.getByText(name, { exact: true }).count())) await app.page.getByText(/^Tags$/).first().click();
    await app.page.getByText(name, { exact: true }).first().click({ button: 'right' });
    await app.page.locator('[role=menuitem]').filter({ hasText: item }).first().click();
    await app.page.waitForTimeout(800);
  }

  describe('tags', () => {
    it('Crear tag… anotado con push desde el diálogo', async () => {
      const name = `${TEST_TAG_PREFIX}a-${stamp()}`;
      fx.tags.push(name);
      await app.pick('repository', /Crear tag|Create tag/i);
      await app.fill('fd-name', name);
      await app.page.locator('#fd-message').fill('annotated e2e tag');
      await app.dialog.getByRole('checkbox', { name: /push/i }).check();
      await app.confirm();
      assert.equal(fx.g('cat-file', '-t', name), 'tag');
      await until(() => fx.remoteHasTag(name), 'el tag anotado en el remoto');
    });
    it('Crear tag… ligero queda solo en local', async () => {
      const name = `${TEST_TAG_PREFIX}b-${stamp()}`;
      fx.tags.push(name);
      await app.pick('repository', /Crear tag|Create tag/i);
      await app.fill('fd-name', name);
      await app.confirm();
      assert.equal(fx.g('cat-file', '-t', name), 'commit');
      assert.equal(fx.remoteHasTag(name), false);
    });
    it('Push del tag (menú de la barra lateral)', async () => {
      const name = `${TEST_TAG_PREFIX}b-${stamp()}`;
      await tagMenu(name, /Push del tag|Push tag/i);
      if (await app.dialog.count()) await app.confirm();
      await until(() => fx.remoteHasTag(name), 'el tag en el remoto');
    });
    it('Push de todos los tags (desplegable de Push)', async () => {
      const name = `${TEST_TAG_PREFIX}c-${stamp()}`;
      fx.tags.push(name);
      fx.g('tag', name);
      assert.equal(fx.remoteHasTag(name), false);
      await app.pick('push', /todos los tags|all tags/i);
      await until(() => fx.remoteHasTag(name), 'todos los tags en el remoto');
    });
    it('Eliminar tag del remoto… conserva el tag local', async () => {
      const name = `${TEST_TAG_PREFIX}c-${stamp()}`;
      assert.ok(fx.remoteHasTag(name), 'precondición: el tag debe existir en el remoto antes de borrarlo');
      await tagMenu(name, /Eliminar tag del remoto|Delete tag from remote/i);
      await app.confirm();
      await until(() => !fx.remoteHasTag(name), 'el tag borrado del remoto');
      assert.equal(fx.g('tag', '-l', name), name);
    });
    it('Eliminar tag… borra el tag local', async () => {
      const name = `${TEST_TAG_PREFIX}c-${stamp()}`;
      await tagMenu(name, /^Eliminar tag…|^Delete tag…/i);
      await app.confirm();
      assert.equal(fx.g('tag', '-l', name), '');
    });
    it('Checkout de un tag deja HEAD desacoplado', async () => {
      const name = `${TEST_TAG_PREFIX}a-${stamp()}`;
      await tagMenu(name, /^Checkout/i);
      if (await app.dialog.count()) await app.confirm();
      assert.equal(fx.g('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
      fx.g('checkout', '-q', fx.branch);
      await app.page.keyboard.press('F5');
    });
  });

  describe('rebase', () => {
    const bannerButton = (re: RegExp) => app.page.getByRole('status').getByRole('button', { name: re });

    /** Deja un conflicto listo: la rama de prueba tiene `conf.txt`=ours y otra rama local lo tiene =theirs. */
    function makeConflict(n: string): { conf: string; orig: string } {
      const orig = fx.g('rev-parse', 'HEAD');
      const conf = `${fx.branch}-conf${n}`;
      writeFileSync(file(`${stamp()}-conf.txt`), 'ours\n');
      fx.g('add', '-A');
      fx.g('commit', '-qm', `test: ours ${n}`);
      fx.g('checkout', '-q', '-b', conf, orig);
      writeFileSync(file(`${stamp()}-conf.txt`), 'theirs\n');
      fx.g('add', '-A');
      fx.g('commit', '-qm', `test: theirs ${n}`);
      fx.g('checkout', '-q', fx.branch);
      return { conf, orig };
    }
    function restore(conf: string, orig: string): void {
      if (rebaseInProgress()) fx.g('rebase', '--abort');
      fx.g('checkout', '-q', fx.branch);
      fx.g('reset', '-q', '--hard', orig);
      try { fx.g('branch', '-q', '-D', conf); } catch { /* ya no existe */ }
    }
    async function rebaseOnto(ref: string, autostash = false): Promise<void> {
      await app.page.getByRole('button', { name: /^Rebase$/ }).click();
      await app.fill('fd-onto', ref);
      if (autostash) await app.dialog.getByRole('checkbox', { name: /autostash/i }).check();
      await app.confirm();
      await app.page.waitForTimeout(1200);
    }

    it('rebase con conflicto: Abortar vuelve al estado anterior', async () => {
      const { conf, orig } = makeConflict('abort');
      const before = head();
      await rebaseOnto(conf);
      assert.ok(rebaseInProgress(), 'debía quedar un rebase en curso por el conflicto');
      await bannerButton(/Abortar|Abort/).click();
      await app.page.waitForTimeout(500);
      if (await app.dialog.count()) await app.confirm();
      await app.page.waitForTimeout(1000);
      assert.equal(rebaseInProgress(), false);
      assert.equal(head(), before);
      restore(conf, orig);
    });
    it('rebase con conflicto: resolver y Continuar', async () => {
      const { conf, orig } = makeConflict('continue');
      await rebaseOnto(conf);
      assert.ok(rebaseInProgress());
      writeFileSync(file(`${stamp()}-conf.txt`), 'resolved\n');
      fx.g('add', `${stamp()}-conf.txt`);
      await app.page.keyboard.press('F5');
      await app.page.waitForTimeout(800);
      await bannerButton(/Continuar|Continue/).click();
      await app.page.waitForTimeout(1500);
      assert.equal(rebaseInProgress(), false);
      assert.equal(readFileSync(file(`${stamp()}-conf.txt`), 'utf8'), 'resolved\n');
      assert.ok(fx.g('log', '--format=%s', '-3').includes('test: ours continue'));
      restore(conf, orig);
    });
    it('rebase con conflicto: Omitir descarta el commit conflictivo', async () => {
      const { conf, orig } = makeConflict('skip');
      await rebaseOnto(conf);
      assert.ok(rebaseInProgress());
      await bannerButton(/Omitir|Skip/).click();
      await app.page.waitForTimeout(1500);
      assert.equal(rebaseInProgress(), false);
      assert.equal(readFileSync(file(`${stamp()}-conf.txt`), 'utf8'), 'theirs\n');
      assert.ok(!fx.g('log', '--format=%s', '-5').includes('test: ours skip'));
      restore(conf, orig);
    });
    it('rebase con autostash conserva los cambios sin commit', async () => {
      const orig = head();
      const base = `${fx.branch}-base1`;
      fx.g('checkout', '-q', '-b', base, orig);
      writeFileSync(file(`${stamp()}-base1.txt`), 'b\n');
      fx.g('add', '-A');
      fx.g('commit', '-qm', 'test: base1');
      fx.g('checkout', '-q', fx.branch);
      writeFileSync(file(`${stamp()}-a.txt`), 'dirty change\n');
      await app.page.keyboard.press('F5');
      await rebaseOnto(base, true);
      assert.equal(fx.g('rev-list', '--count', `${base}..HEAD`), '0');
      assert.ok(readFileSync(file(`${stamp()}-a.txt`), 'utf8').includes('dirty change'));
      restore(base, orig);
    });
    it('rebase interactivo: descartar y combinar commits', async () => {
      const orig = head();
      for (const n of ['c1', 'c2', 'c3']) {
        writeFileSync(file(`${stamp()}-${n}.txt`), `${n}\n`);
        fx.g('add', '-A');
        fx.g('commit', '-qm', `test: ${n}`);
      }
      await app.pick('rebase', /interactivo|interactive/i);
      await app.fill('fd-v', 'HEAD~3');
      await app.dialog.locator('.btn.primary').last().click();
      await app.page.waitForTimeout(1200);
      await app.dialog.locator('select[aria-label="test: c1"]').selectOption('drop');
      await app.dialog.locator('select[aria-label="test: c3"]').selectOption('fixup');
      await app.dialog.locator('.btn.primary').last().click();
      await app.page.waitForTimeout(2500);
      if (await app.dialog.count()) await app.confirm();
      assert.equal(rebaseInProgress(), false);
      const subjects = fx.g('log', '--format=%s', `${orig}..HEAD`).split('\n');
      assert.deepEqual(subjects, ['test: c2']);
      assert.equal(existsSync(file(`${stamp()}-c1.txt`)), false);
      assert.ok(existsSync(file(`${stamp()}-c2.txt`)) && existsSync(file(`${stamp()}-c3.txt`)));
      fx.g('reset', '-q', '--hard', orig);
    });
    it('rebase interactivo: cambiar el mensaje (reword)', async () => {
      const orig = head();
      writeFileSync(file(`${stamp()}-rw.txt`), 'rw\n');
      fx.g('add', '-A');
      fx.g('commit', '-qm', 'test: before reword');
      await app.pick('rebase', /interactivo|interactive/i);
      await app.fill('fd-v', 'HEAD~1');
      await app.dialog.locator('.btn.primary').last().click();
      await app.page.waitForTimeout(1200);
      await app.dialog.locator('select[aria-label="test: before reword"]').selectOption('reword');
      await app.dialog.locator('input[type=text], textarea').last().fill('test: after reword');
      await app.dialog.locator('.btn.primary').last().click();
      await app.page.waitForTimeout(2500);
      if (await app.dialog.count()) await app.confirm();
      assert.equal(fx.g('log', '-1', '--format=%s'), 'test: after reword');
      fx.g('reset', '-q', '--hard', orig);
    });
    it('Pull… con rebase mantiene el historial lineal', async () => {
      const mine = `${stamp()}-mine.txt`;
      writeFileSync(file(mine), 'mine\n');
      fx.g('add', '-A');
      fx.g('commit', '-qm', 'test: my local commit');
      const remote = fx.remoteCommit(`${stamp()}-theirs.txt`, 'test: remote commit for rebase');
      await app.pick('pull', /^Pull…/);
      await app.dialog.getByRole('checkbox', { name: /rebase/i }).check();
      await app.confirm();
      await until(() => fx.g('log', '-1', '--format=%s') === 'test: my local commit' && fx.g('rev-parse', 'HEAD~1') === remote, 'el pull con rebase');
      assert.equal(fx.g('rev-parse', 'HEAD~1'), remote);
      assert.equal(fx.g('rev-list', '--merges', '--count', `${remote}..HEAD`), '0');
    });
    it('rebase sobre una rama local y push forzado al remoto', async () => {
      const orig = head();
      const base = `${fx.branch}-base2`;
      // Base: el punto de partida de la rama de prueba (o su primer commit si el remoto estaba vacío)
      fx.g('checkout', '-q', '-b', base, fx.startPoint || fx.g('rev-list', '--max-parents=0', fx.branch));
      writeFileSync(file(`${stamp()}-base2.txt`), 'b2\n');
      fx.g('add', '-A');
      fx.g('commit', '-qm', 'test: base2');
      fx.g('checkout', '-q', fx.branch);
      await rebaseOnto(base);
      assert.equal(rebaseInProgress(), false);
      assert.equal(fx.g('merge-base', base, 'HEAD'), fx.g('rev-parse', base));
      assert.notEqual(head(), orig);
      await app.pick('push', /forzado|force/i);
      await app.confirm();
      await until(() => fx.remoteHead() === head(), 'el push forzado en el remoto');
      fx.g('branch', '-q', '-D', base);
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(app.pageErrors, []);
  });
});
