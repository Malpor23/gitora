import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { App, git, makeRemoteFixture, RemoteFixture, TEST_BRANCH_PREFIX } from './helpers';

/**
 * Acciones de Pull Requests contra GitHub REAL. Solo corre si están definidas:
 *   GITORA_E2E_PR_REPO_URL   p. ej. https://github.com/usuario/prueba-github.git
 *   GITORA_E2E_GITHUB_TOKEN  token con permiso `repo` (p. ej. `$(gh auth token)`); nunca se imprime
 * El token se escribe en una cuenta de Gitora dentro de un perfil temporal que se borra al terminar.
 * Crea PR desde ramas `gitora-e2e/*` hacia la rama por defecto del repositorio y los CIERRA al acabar
 * (los PR cerrados quedan en el historial de GitHub). No fusiona nada.
 */
const url = process.env['GITORA_E2E_PR_REPO_URL'];
const token = process.env['GITORA_E2E_GITHUB_TOKEN'];
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');
const skip = !url || !token ? 'define GITORA_E2E_PR_REPO_URL y GITORA_E2E_GITHUB_TOKEN' : hasDisplay ? false : 'sin pantalla (usa xvfb-run)';

interface GhPull { number: number; title: string; state: string; draft: boolean; head: { ref: string }; base: { ref: string } }

describe('Pull Requests en GitHub real (E2E)', { skip }, () => {
  let fx: RemoteFixture;
  let app: App;
  let owner = '';
  let repo = '';
  let base = '';
  let draftBranch = '';
  const opened: number[] = [];
  const stamp = () => fx.branch.split('/')[1];
  /** Llamada a la API de GitHub; reintenta ante cortes de red (DNS, conexión) que no dependen de la app. */
  const api = async (method: string, route: string, body?: unknown): Promise<Response> => {
    for (let i = 1; ; i++) {
      try {
        return await fetch(`https://api.github.com/repos/${owner}/${repo}${route}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'gitora-e2e' },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (i >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
  };
  /** Busca el PR de una rama, esperando hasta `ms` a que aparezca (la creación desde la app es asíncrona). */
  const findPr = async (head: string, ms = 30000): Promise<GhPull | undefined> => {
    const end = Date.now() + ms;
    for (;;) {
      const res = await api('GET', `/pulls?state=all&head=${owner}:${encodeURIComponent(head)}`);
      const pr = ((await res.json()) as GhPull[])[0];
      if (pr || Date.now() >= end) return pr;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  async function commitFromUi(name: string, message: string): Promise<void> {
    writeFileSync(path.join(fx.repo, name), `${message}\n`);
    await app.page.keyboard.press('F5');
    await app.page.getByText(/Cambios locales|Local changes/).first().click();
    await app.page.getByRole('button', { name: /Preparar todo|Stage all/ }).click();
    await app.page.getByPlaceholder(/Resumen|Summary/).fill(message);
    await app.page.getByRole('button', { name: /Hacer commit|^Commit \d/ }).click();
    await app.page.waitForTimeout(1500);
  }
  /** Abre la paleta de comandos y ejecuta el comando cuyo texto cumple `label`. */
  async function palette(label: RegExp): Promise<void> {
    await app.page.keyboard.press('Control+Shift+P');
    await app.dialog.locator('input').first().waitFor();
    await app.page.keyboard.type('pull');
    await app.dialog.getByText(label).first().click();
    await app.page.waitForTimeout(800);
  }

  before(async () => {
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url as string);
    assert.ok(m, 'GITORA_E2E_PR_REPO_URL debe ser de github.com');
    [, owner, repo] = m as RegExpExecArray;
    fx = makeRemoteFixture(url as string);
    assert.ok(fx.startPoint, 'el repositorio debe tener al menos un commit (rama por defecto) para abrir un PR');
    base = fx.g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
    draftBranch = `${fx.branch}-draft`;
    app = await App.launch(fx);
    // Evita abrir el navegador del sistema: se registra la URL que la app pediría abrir
    await app.electron.evaluate(({ shell }) => {
      (globalThis as unknown as { __opened: string[] }).__opened = [];
      shell.openExternal = async (u: string) => {
        (globalThis as unknown as { __opened: string[] }).__opened.push(u);
      };
    });
  });
  after(async () => {
    try {
      for (const n of opened) await api('PATCH', `/pulls/${n}`, { state: 'closed' });
      if (draftBranch.startsWith(TEST_BRANCH_PREFIX)) git(fx.repo, 'push', 'origin', '--delete', draftBranch);
    } catch {
      console.warn(`No se pudo limpiar del todo: revisa PR abiertos y la rama ${draftBranch} en ${owner}/${repo}`);
    }
    await app?.close();
    fx?.cleanup();
  });
  beforeEach(async () => {
    await app.closeAll();
  });

  it('sin cuenta, crear un PR falla con un aviso y no crea nada', async () => {
    await palette(/Crear pull request|Create pull request/i);
    assert.ok((await app.dialog.count()) > 0, 'debía abrir el diálogo de creación');
    await app.fill('fd-title', 'sin cuenta');
    await app.dialog.locator('.btn.primary').last().click();
    await app.page.waitForTimeout(2500);
    // El diálogo sigue abierto mostrando el error, y no se abrió ninguna URL
    assert.ok((await app.dialog.count()) > 0);
    assert.deepEqual(await app.electron.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened), []);
  });

  it('Ajustes, Cuentas: agregar una cuenta de GitHub con token', async () => {
    await app.closeAll();
    await app.page.getByTitle(/Ajustes|Settings/).click();
    await app.dialog.getByRole('tab', { name: /Cuentas|Accounts/ }).click();
    await app.page.locator('#a-secret').fill(token as string);
    await app.dialog.getByRole('button', { name: /Agregar cuenta|Add account/ }).last().click();
    await app.page.waitForTimeout(3500);
    const text = await app.dialog.innerText();
    assert.ok(!/No hay cuentas|No accounts/i.test(text), `la cuenta no se añadió: ${text.slice(-160)}`);
    assert.ok(text.toLowerCase().includes(owner.toLowerCase()), 'la lista debe mostrar el usuario de la cuenta');
    assert.ok(!text.includes(token as string), 'el token no debe mostrarse nunca');
    await app.closeAll();
  });

  it('Crear pull request desde un commit empujado', async () => {
    await commitFromUi(`${stamp()}-pr.txt`, `test: pr ${stamp()}`);
    await app.pick('push', /^Push…/);
    await app.confirm();
    await app.page.waitForTimeout(3000);
    await palette(/Crear pull request|Create pull request/i);
    await app.fill('fd-target', base);
    await app.fill('fd-title', `gitora-e2e PR ${stamp()}`);
    await app.page.locator('#fd-body').fill('Pull request de prueba creado por el E2E de Gitora. Se cierra solo.');
    await app.confirm();
    await app.page.waitForTimeout(3000);
    const pr = await findPr(fx.branch);
    assert.ok(pr, 'el PR debe existir en GitHub');
    opened.push(pr.number);
    assert.equal(pr.title, `gitora-e2e PR ${stamp()}`);
    assert.equal(pr.state, 'open');
    assert.equal(pr.base.ref, base);
    assert.equal(pr.draft, false);
    const urls = await app.electron.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    assert.ok(urls.some((u) => u.includes(`/pull/${pr.number}`)), 'debe pedir abrir la URL del PR en el navegador');
  });

  it('Pull requests: lista los abiertos y muestra el creado', async () => {
    await palette(/Ver pull requests|View pull requests/i);
    await app.page.waitForTimeout(3000);
    const text = await app.dialog.innerText();
    assert.ok(text.includes(`gitora-e2e PR ${stamp()}`), `el listado debe incluir el PR: ${text.slice(0, 120)}`);
    assert.ok(text.includes(fx.branch));
  });

  it('Pull requests: Checkout lleva a la rama del PR', async () => {
    await palette(/Ver pull requests|View pull requests/i);
    await app.page.waitForTimeout(3000);
    await app.dialog.getByRole('button', { name: /Checkout/ }).first().click();
    await app.page.waitForTimeout(2500);
    await app.closeAll();
    assert.equal(fx.g('rev-parse', 'HEAD'), fx.remoteHead());
    fx.g('checkout', '-q', fx.branch);
  });

  it('Crear un PR en borrador (draft)', async () => {
    fx.g('checkout', '-q', '-b', draftBranch);
    writeFileSync(path.join(fx.repo, `${stamp()}-draft.txt`), 'draft\n');
    fx.g('add', '-A');
    fx.g('commit', '-qm', `test: draft ${stamp()}`);
    fx.g('push', '-q', 'origin', `HEAD:refs/heads/${draftBranch}`);
    await app.page.keyboard.press('F5');
    await palette(/Crear pull request|Create pull request/i);
    await app.page.locator('#fd-source').selectOption(draftBranch);
    await app.fill('fd-target', base);
    await app.fill('fd-title', `gitora-e2e draft ${stamp()}`);
    await app.dialog.getByRole('checkbox', { name: /borrador|draft/i }).check();
    await app.confirm();
    await app.page.waitForTimeout(3000);
    const pr = await findPr(draftBranch);
    assert.ok(pr, 'el PR en borrador debe existir');
    opened.push(pr.number);
    assert.equal(pr.draft, true);
    fx.g('checkout', '-q', fx.branch);
  });

  it('un destino inexistente muestra el error y no crea el PR', async () => {
    await palette(/Crear pull request|Create pull request/i);
    await app.fill('fd-target', `no-existe-${stamp()}`);
    await app.fill('fd-title', `gitora-e2e invalido ${stamp()}`);
    await app.dialog.locator('.btn.primary').last().click();
    await app.page.waitForTimeout(3500);
    assert.ok((await app.dialog.count()) > 0, 'el diálogo debe seguir abierto con el error');
    const res = await api('GET', `/pulls?state=all&per_page=100`);
    const all = (await res.json()) as GhPull[];
    assert.ok(!all.some((p) => p.title.includes(`invalido ${stamp()}`)));
  });

  it('no hubo errores no controlados en la interfaz', () => {
    assert.deepEqual(app.pageErrors, []);
  });
});
