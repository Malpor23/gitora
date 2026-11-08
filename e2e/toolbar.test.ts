import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { App, Fixture, git, makeFixture } from './helpers';

/**
 * Prueba de extremo a extremo de la barra de herramientas: abre Gitora (Electron real) sobre un
 * repositorio desechable y ejecuta cada ítem de los dropdowns, verificando el resultado con git.
 * Requiere pantalla (en CI: `xvfb-run -a npm run test:e2e`) y el build previo. `npm run test:e2e`
 */
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');

describe('barra de herramientas (E2E)', { skip: hasDisplay ? false : 'sin pantalla (usa xvfb-run)' }, () => {
  let fx: Fixture;
  let app: App;
  let g: Fixture['g'];
  const bareRef = (ref: string) => git(fx.bare, 'rev-parse', ref);
  const head = () => g('rev-parse', 'HEAD');
  const file = (name: string) => path.join(fx.repo, name);

  before(async () => {
    fx = makeFixture();
    g = fx.g;
    app = await App.launch(fx);
  });
  after(async () => {
    await app?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await app.closeAll();
  });

  describe('contenido de los dropdowns', () => {
    const expected: [Parameters<App['menuItems']>[0], RegExp[]][] = [
      ['fetch', [/^Fetch…/, /todos los remotos|all remotes/i]],
      ['pull', [/^Pull…/]],
      ['push', [/^Push…/, /forzado|force/i, /todos los tags|all tags/i]],
      ['branch', [/^Crear rama|^Create branch/, /worktree/i, /feature/i, /Git Flow/i, /checkout/i, /Renombrar|Rename/i, /Eliminar|Delete/i]],
      ['rebase', [/interactivo|interactive/i, /Cherry-pick/, /Revert/i, /^Reset/]],
      ['stash', [/Guardar stash|Save stash/]],
      ['repository', [/Actualizar|Refresh/, /tag/i, /parches|patch/i, /bisect/i, /reflog/i, /Treemap/i, /gc/i, /usuario y correo|user name and email/i]],
    ];
    for (const [menu, labels] of expected) {
      it(`${menu} muestra sus opciones y oculta las que no aplican`, async () => {
        const items = await app.menuItems(menu);
        for (const re of labels) assert.ok(items.some((i) => re.test(i)), `falta ${re} en ${menu}: ${items.join(' | ')}`);
      });
    }
    it('sin operación en curso no hay continuar/omitir/abortar ni pop/vaciar sin stashes', async () => {
      assert.ok(!(await app.menuItems('rebase')).some((i) => /continuar|continue|omitir|skip|abortar|abort/i.test(i)));
      assert.equal((await app.menuItems('stash')).length, 1);
    });
    it('el menú se cierra al hacer clic fuera', async () => {
      await app.openMenu('fetch');
      await app.page.mouse.click(700, 500);
      // Se espera a que desaparezca: en un runner lento el cierre tarda unos fotogramas
      await app.page.locator('[role=menu]').waitFor({ state: 'detached', timeout: 5000 });
      assert.equal(await app.page.locator('[role=menu]').count(), 0);
    });
  });

  describe('interacción con el ratón dentro de los diálogos', () => {
    it('el slider de tamaño de letra responde al arrastre con el ratón', async () => {
      await app.page.getByTitle(/Ajustes|Settings/).click();
      const slider = app.page.locator('#s-font');
      const before = Number(await slider.inputValue());
      const box = await slider.boundingBox();
      assert.ok(box);
      await app.page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
      await app.page.mouse.down();
      await app.page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 6 });
      await app.page.mouse.up();
      await app.page.waitForTimeout(600);
      const after = Number(await slider.inputValue());
      assert.ok(after > before, `el valor debía subir con el arrastre (antes ${before}, después ${after})`);
      assert.match(await app.page.locator('label[for=s-font]').innerText(), new RegExp(`${after}px`));
      // Vuelve al valor original para no alterar los siguientes casos
      await slider.fill(String(before));
    });
    it('un clic en un campo de un diálogo lo enfoca', async () => {
      await app.pick('branch', /^Crear rama|^Create branch/);
      await app.page.locator('#fd-start').click();
      assert.equal(await app.page.evaluate(() => document.activeElement?.id), 'fd-start');
    });
    it('el clic en el fondo del diálogo sigue cerrándolo', async () => {
      await app.pick('branch', /^Crear rama|^Create branch/);
      await app.page.mouse.click(5, 400);
      await app.dialog.waitFor({ state: 'detached', timeout: 3000 });
    });
  });

  describe('remotos', () => {
    it('Fetch… trae los commits remotos', async () => {
      const h = fx.remoteCommit('r1.txt', 'remote: one');
      await app.pick('fetch', /^Fetch…/);
      await app.confirm();
      assert.equal(g('rev-parse', 'origin/main'), h);
    });
    it('Fetch de todos los remotos', async () => {
      const h = fx.remoteCommit('r2.txt', 'remote: two');
      await app.pick('fetch', /todos los remotos|all remotes/i);
      await app.page.waitForTimeout(1500);
      assert.equal(g('rev-parse', 'origin/main'), h);
    });
    it('Pull… integra los cambios y conserva el trabajo local (autostash)', async () => {
      await app.pick('pull', /^Pull…/);
      await app.confirm();
      assert.ok(existsSync(file('r2.txt')));
      assert.ok(readFileSync(file('README.md'), 'utf8').includes('wip'));
      assert.equal(head(), g('rev-parse', 'origin/main'));
    });
    it('Push… sube el commit local', async () => {
      g('stash', '-u', '-q');
      writeFileSync(file('p.txt'), 'p');
      g('add', '-A');
      g('commit', '-qm', 'feat: local push');
      g('stash', 'pop', '-q');
      await app.pick('push', /^Push…/);
      await app.confirm();
      assert.equal(bareRef('main'), head());
    });
    it('Push forzado (with-lease) tras un amend, con confirmación', async () => {
      g('stash', '-u', '-q');
      g('commit', '-q', '--amend', '-m', 'feat: local push amended');
      g('stash', 'pop', '-q');
      await app.pick('push', /forzado|force/i);
      await app.confirm();
      assert.equal(bareRef('main'), head());
    });
    it('Push de todos los tags', async () => {
      g('tag', '-a', 'v9.9.9', '-m', 't');
      await app.pick('push', /todos los tags|all tags/i);
      await app.page.waitForTimeout(1500);
      assert.equal(git(fx.bare, 'tag', '-l', 'v9.9.9'), 'v9.9.9');
    });
  });

  describe('ramas y Git Flow', () => {
    it('Crear rama… crea y cambia a la rama', async () => {
      await app.pick('branch', /^Crear rama|^Create branch/);
      await app.fill('fd-name', 'feat/dropdown-test');
      await app.confirm();
      assert.equal(g('branch', '--show-current'), 'feat/dropdown-test');
    });
    it('Renombrar rama actual…', async () => {
      await app.pick('branch', /Renombrar|Rename/i);
      await app.fill('fd-name', 'feat/renamed');
      await app.confirm();
      assert.equal(g('branch', '--show-current'), 'feat/renamed');
    });
    it('Cambiar de rama (checkout)…', async () => {
      await app.pick('branch', /Cambiar de rama|Switch branch/i);
      await app.fill('fd-ref', 'main');
      await app.confirm();
      assert.equal(g('branch', '--show-current'), 'main');
    });
    it('Eliminar rama…, con confirmación', async () => {
      await app.pick('branch', /Eliminar rama|Delete branch/i);
      await app.fill('fd-ref', 'feat/renamed');
      await app.confirm();
      assert.equal(g('branch', '--list', 'feat/renamed'), '');
    });
    it('Agregar worktree…', async () => {
      await app.pick('branch', /worktree/i);
      await app.fill('fd-branch', 'wt-branch');
      await app.fill('fd-path', path.join(fx.base, 'wt'));
      await app.confirm();
      assert.ok(g('worktree', 'list').includes('wt-branch'));
    });
    it('Iniciar feature… inicializa Git Flow y crea la rama', async () => {
      await app.pick('branch', /Iniciar feature|Start Feature/i);
      await app.confirm(); // inicialización con los valores por defecto
      await app.page.waitForTimeout(500);
      if (await app.dialog.count()) {
        await app.fill('fd-name', 'flowtest');
        await app.confirm();
      }
      assert.equal(g('branch', '--show-current'), 'feature/flowtest');
      assert.notEqual(g('config', '--get-regexp', '^gitflow'), '');
    });
    it('Desinicializar Git Flow… borra su configuración', async () => {
      g('checkout', '-q', 'main');
      await app.pick('branch', /Desinicializar|Deinitialize/i);
      await app.confirm();
      assert.equal(spawnConfig(fx.repo), '');
    });
  });

  describe('rebase y rewrites', () => {
    it('Rebase interactivo… abre el editor visual', async () => {
      await app.pick('rebase', /interactivo|interactive/i);
      await app.fill('fd-v', 'HEAD~1');
      await app.dialog.locator('.btn.primary').last().click();
      await app.page.waitForTimeout(1500);
      assert.ok((await app.dialog.count()) > 0);
    });
    it('Cherry-pick por hash…', async () => {
      const h = g('rev-parse', 'feature/login');
      g('stash', '-u', '-q');
      await app.pick('rebase', /Cherry-pick/);
      await app.fill('fd-h', h);
      await app.confirm();
      assert.equal(g('log', '-1', '--format=%s'), 'feat: login');
      g('stash', 'pop', '-q');
    });
    it('Revertir commit por hash…', async () => {
      g('stash', '-u', '-q');
      await app.pick('rebase', /Revert/i);
      await app.fill('fd-h', head());
      await app.confirm();
      assert.ok(g('log', '-1', '--format=%s').startsWith('Revert'));
      g('stash', 'pop', '-q');
    });
    it('Reset… (soft) mueve la rama', async () => {
      const want = g('rev-parse', 'HEAD~1');
      g('stash', '-u', '-q');
      await app.pick('rebase', /^Reset/);
      await app.fill('fd-target', 'HEAD~1');
      await app.confirm();
      assert.equal(head(), want);
      g('stash', 'pop', '-q');
      // Vuelve al estado base para los siguientes casos
      g('reset', '-q', '--hard', 'origin/main');
      appendFileSync(file('README.md'), 'wip\n');
      writeFileSync(file('src/new.ts'), 'x\n');
    });
  });

  describe('stash', () => {
    it('Guardar stash…', async () => {
      await app.pick('stash', /Guardar stash|Save stash/);
      await app.fill('fd-message', 'dropdown stash');
      await app.confirm();
      assert.ok(g('stash', 'list').includes('dropdown stash'));
    });
    it('Aplicar y quitar (pop)', async () => {
      await app.pick('stash', /pop|Aplicar|Apply/i);
      await app.confirm();
      assert.equal(g('stash', 'list'), '');
      assert.ok(readFileSync(file('README.md'), 'utf8').includes('wip'));
    });
    it('Vaciar (clear), con confirmación', async () => {
      g('stash', '-u', '-q', '-m', 'again');
      await app.page.keyboard.press('F5');
      await app.page.waitForTimeout(800);
      await app.pick('stash', /Vaciar|clear|Eliminar todos|Drop all/i);
      await app.confirm();
      assert.equal(g('stash', 'list'), '');
    });
  });

  describe('menú Repositorio', () => {
    it('Actualizar muestra un archivo creado desde fuera', async () => {
      writeFileSync(file('external.txt'), 'e');
      await app.page.getByText(/Cambios locales|Local changes/).first().click();
      await app.pick('repository', /Actualizar|Refresh/);
      await app.page.waitForTimeout(1200);
      assert.ok((await app.page.locator('main').innerText()).includes('external.txt'));
    });
    it('Crear tag…', async () => {
      await app.pick('repository', /Crear tag|Create tag/i);
      await app.fill('fd-name', 'v-dropdown');
      await app.confirm();
      assert.equal(g('tag', '-l', 'v-dropdown'), 'v-dropdown');
    });
    it('Configurar usuario y correo… (solo en el repo)', async () => {
      await app.pick('repository', /usuario y correo|user name and email/i);
      await app.fill('fd-name', 'Tester Local');
      await app.fill('fd-email', 'tester@example.com');
      const global = app.dialog.locator('input[type=checkbox]').first();
      if (await global.isChecked()) await global.uncheck();
      await app.confirm();
      assert.equal(g('config', '--local', 'user.email'), 'tester@example.com');
    });
    for (const [label, re] of [
      ['Editar configuración (git config)', /Editar configuraci|Edit config/i],
      ['Ver reflog', /reflog/i],
      ['Estadísticas del repositorio', /Estad|Statistics/i],
      ['Treemap del repositorio', /Treemap/i],
      ['Benchmark de rendimiento', /Benchmark/i],
      ['Iniciar bisect', /bisect/i],
    ] as [string, RegExp][]) {
      it(`${label} abre su diálogo`, async () => {
        await app.pick('repository', re);
        await app.page.waitForTimeout(1500);
        assert.ok((await app.dialog.count()) > 0);
        await app.closeAll();
        if (/bisect/i.test(label)) g('bisect', 'reset');
      });
    }
    it('Optimizar repositorio (gc) se registra en la consola', async () => {
      await app.pick('repository', /gc/i);
      await app.page.waitForTimeout(2500);
      await app.page.keyboard.press('Control+`');
      await app.page.waitForTimeout(500);
      assert.match(await app.page.locator('body').innerText(), /gc/);
      await app.page.keyboard.press('Control+`');
    });
    it('Exportar como archivo (zip/tar.gz)', async () => {
      const out = path.join(fx.base, 'export.tar.gz');
      await app.electron.evaluate(({ dialog }, o) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: o });
      }, out);
      await app.pick('repository', /Exportar|Export/i);
      if (await app.dialog.count()) await app.confirm();
      await app.page.waitForTimeout(2000);
      assert.ok(existsSync(out) && statSync(out).size > 0);
    });
    it('Aplicar parches (am) crea el commit', async () => {
      const patches = mkdtempSync(path.join(os.tmpdir(), 'gitora-e2e-patch-'));
      const other = path.join(fx.base, 'other2');
      git(fx.base, 'clone', '-q', fx.bare, other);
      git(other, 'config', 'user.name', 'Bob');
      git(other, 'config', 'user.email', 'bob@example.com');
      writeFileSync(path.join(other, 'patched.txt'), 'patched\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-qm', 'feat: patch me');
      git(other, 'format-patch', '-1', '-o', patches);
      const patch = path.join(patches, readdirSync(patches).find((f) => f.endsWith('.patch')) ?? '');
      g('stash', '-u', '-q');
      g('reset', '-q', '--hard', 'origin/main');
      await app.electron.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      }, patch);
      await app.pick('repository', /parches|patch/i);
      if (await app.dialog.count()) await app.confirm();
      await app.page.waitForTimeout(1500);
      assert.equal(g('log', '-1', '--format=%s'), 'feat: patch me');
    });
  });

  describe('consola', () => {
    it('la salida de un comando no lleva espacios ni saltos sobrantes dentro del <pre>', async () => {
      // Un formateador que reindente `<pre>` mete sangría real en la salida (el espacio ahí sí cuenta)
      await app.page.keyboard.press('Control+`');
      await app.page.getByPlaceholder(/status --short/).fill('log --oneline -1');
      await app.page.keyboard.press('Enter');
      await app.page.waitForTimeout(1200);
      const out = await app.page.evaluate(() => [...document.querySelectorAll('pre')].map((e) => e.textContent ?? ''));
      assert.ok(out.length > 0, 'debía haber salida en la consola');
      for (const t of out) {
        assert.equal(t, t.trim() + (t.endsWith('\n') ? '\n' : ''), `espacios sobrantes en: ${JSON.stringify(t.slice(0, 40))}`);
        assert.ok(!/^\s/.test(t), `la salida no debe empezar con espacios: ${JSON.stringify(t.slice(0, 40))}`);
      }
      await app.page.keyboard.press('Control+`');
    });
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(app.pageErrors, []);
  });
});

/** Configuración `gitflow.*` del repo (vacía si no hay ninguna). */
function spawnConfig(repo: string): string {
  try {
    return git(repo, 'config', '--get-regexp', '^gitflow');
  } catch {
    return '';
  }
}
