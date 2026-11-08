import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { _electron, ElectronApplication, Locator, Page } from 'playwright-core';
import { ROOT } from './helpers';

/**
 * Ajustes, Cuentas: lista y detalle (maestro-detalle), estado de la credencial, pestañas, navegación con
 * teclado y cambio de credencial sin quitar la cuenta. Sin red externa: las comprobaciones de estado van
 * a un servidor falso en 127.0.0.1 (o al puerto 9, cerrado, para «Sin conexión»); la clave SSH se valida
 * en local. Requiere pantalla (en CI: `xvfb-run -a ...`) y el build previo.
 */
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');

const account = (over: Record<string, unknown>) => ({
  id: 'x', provider: 'gitlab', baseUrl: 'http://127.0.0.1:9/api/v4', host: 'gitlab.com', username: 'ana',
  hasToken: true, authMethod: 'token', apiAccess: true, ...over,
});

describe('cuentas: lista, detalle y edición (E2E)', { skip: hasDisplay ? false : 'sin pantalla (usa xvfb-run)' }, () => {
  let base: string;
  let data: string;
  let keyA: string;
  let keyB: string;
  let app: ElectronApplication;
  let page: Page;
  let server: http.Server;
  let api = '';
  const hits = { good: 0, slow: 0 };
  const saved = () =>
    (JSON.parse(readFileSync(path.join(data, 'settings.json'), 'utf8')) as { settings: { accounts: Record<string, unknown>[] } }).settings.accounts;
  const calls = () => app.evaluate(() => (globalThis as unknown as { __calls: { fn: string; arg: string }[] }).__calls.slice());
  const panel = (): Locator => page.locator('div.fixed.inset-0.z-50').first().locator('[role=dialog]').first();
  const top = (): Locator => page.locator('div.fixed.inset-0.z-50').last().locator('[role=dialog]').first();
  const opt = (user: string) => panel().getByRole('option').filter({ hasText: user });
  const status = () => panel().locator('[data-status]');
  const key = () => page.locator('#a-key');
  const select = async (user: string) => {
    await opt(user).click();
    await waitSelected(user);
  };
  const waitSelected = async (user: string) => {
    await opt(user).and(page.locator('[aria-selected=true]')).waitFor({ timeout: 5000 });
  };
  const statusIs = async (text: string | RegExp) => {
    await status().filter({ hasText: text }).waitFor({ timeout: 10000 });
  };

  before(async () => {
    server = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/v3/user') {
        if (auth === 'Bearer good') {
          hits.good++;
          return json(200, { login: 'erin', name: 'Erin', avatar_url: '' });
        }
        if (auth === 'Bearer slow') {
          hits.slow++;
          return void setTimeout(() => json(200, { login: 'fran', name: 'Fran', avatar_url: '' }), 1500);
        }
        return json(401, { message: 'Bad credentials' });
      }
      if (req.url?.startsWith('/api/v3/user/repos')) return json(200, []);
      json(404, { message: 'no existe' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v3`;

    base = mkdtempSync(path.join(os.tmpdir(), 'gitora-e2e-acc-'));
    data = path.join(base, 'data');
    mkdirSync(data, { recursive: true });
    keyA = path.join(base, 'id_a');
    keyB = path.join(base, 'id_b');
    for (const k of [keyA, keyB]) writeFileSync(k, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n');
    const accounts = [
      account({ id: 'tok', username: 'ana' }),
      account({ id: 'ssh', username: 'deploy', host: 'git.acme.com', baseUrl: 'https://git.acme.com/api/v4', authMethod: 'ssh', hasToken: false, apiAccess: false, sshKeyPath: keyA }),
      account({ id: 'inv', provider: 'gitea', username: 'carol', host: 'codeberg.org', baseUrl: 'http://127.0.0.1:9/api/v1' }),
      account({ id: 'pw', username: 'dave', authMethod: 'password', apiAccess: false }),
      account({ id: 'ok', provider: 'github', username: 'erin', host: 'github.com', baseUrl: api, displayName: 'Erin Soto' }),
      account({ id: 'slow', provider: 'github', username: 'fran', host: 'github.com', baseUrl: api }),
    ];
    const tokens = {
      tok: { value: 'glpat-x', encrypted: false },
      ok: { value: 'good', encrypted: false },
      slow: { value: 'slow', encrypted: false },
    };
    writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ settings: { language: 'es', fetchInterval: 0, accounts }, tokens }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = await _electron.launch({ executablePath: require('electron') as unknown as string, args: ['.', '--no-sandbox', `--user-data-dir=${data}`], cwd: ROOT });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __calls: { fn: string; arg: string }[] };
      g.__calls = [];
      shell.openExternal = (async (u: string) => void g.__calls.push({ fn: 'openExternal', arg: u })) as typeof shell.openExternal;
    });
    await page.getByRole('button', { name: /Abrir repositorio local/ }).waitFor();
    await page.keyboard.press('Control+,');
    await page.locator('[role=dialog]').waitFor();
    await panel().getByRole('tab', { name: 'Cuentas', exact: true }).click();
    await opt('deploy').waitFor();
  });
  after(async () => {
    await app?.close();
    server?.closeAllConnections();
    server?.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('lista las cuentas con proveedor y usuario, selecciona la primera y muestra su cabecera', async () => {
    assert.equal(await panel().getByRole('listbox').count(), 1);
    assert.equal(await panel().getByRole('option').count(), 6);
    assert.match(await opt('deploy').innerText(), /GitLab\s+deploy/);
    assert.match(await opt('carol').innerText(), /Gitea \/ Forgejo\s+carol/);
    assert.equal(await opt('ana').getAttribute('aria-selected'), 'true', 'la primera queda seleccionada');
    assert.equal(await panel().locator('[aria-selected=true][role=option]').count(), 1);
    const head = panel().locator('section header');
    assert.equal((await head.locator('strong').innerText()).trim(), 'ana');
    assert.equal((await head.getByRole('link').innerText()).trim(), 'https://gitlab.com');
    assert.match(await head.locator('span[aria-hidden=true]').innerText(), /^A$/, 'iniciales cuando no hay avatar');
  });

  it('seleccionar otra cuenta cambia la cabecera; la iniciales salen del nombre completo', async () => {
    await select('erin');
    const head = panel().locator('section header');
    assert.equal((await head.locator('strong').innerText()).trim(), 'erin');
    assert.equal((await head.getByRole('link').innerText()).trim(), 'https://github.com');
    assert.match(await head.locator('span[aria-hidden=true]').innerText(), /^ES$/);
    await select('ana');
  });

  it('el enlace del servidor se abre con el navegador del sistema y no navega la ventana', async () => {
    const before = page.url();
    await panel().locator('section header').getByRole('link').click();
    await page.waitForTimeout(300);
    const c = await calls();
    assert.equal(c.length, 1);
    assert.deepEqual(c[0], { fn: 'openExternal', arg: 'https://gitlab.com' });
    assert.equal(page.url(), before);
  });

  it('estado: sin conexión (puerto cerrado), credencial inválida, no verificable (SSH y sin API) y en línea', async () => {
    await statusIs('Sin conexión'); // ana, seleccionada
    assert.equal(await status().getAttribute('data-tone'), 'danger');
    await select('carol');
    await statusIs('Credencial inválida');
    assert.equal(await status().getAttribute('data-tone'), 'warning');
    await select('deploy');
    await statusIs('No verificable (clave SSH)');
    assert.equal(await status().getAttribute('data-tone'), 'muted');
    await select('dave');
    await statusIs('No verificable (sin acceso a la API)');
    assert.equal(await status().getAttribute('data-tone'), 'muted');
    await select('erin');
    await statusIs('En línea');
    assert.equal(await status().getAttribute('data-tone'), 'success');
  });

  it('muestra «Comprobando…» con un spinner mientras responde el servidor y luego «En línea»', async () => {
    await select('fran');
    await statusIs('Comprobando…');
    assert.equal(await status().getAttribute('data-tone'), 'busy');
    assert.equal(await panel().locator('dd .spinner').count(), 1);
    await statusIs('En línea');
    assert.equal(await panel().locator('dd .spinner').count(), 0);
  });

  it('«Comprobar de nuevo» repite la llamada; volver a seleccionar la cuenta pronto no la repite', async () => {
    await select('erin');
    await statusIs('En línea');
    const n = hits.good;
    await select('deploy');
    await select('erin');
    await statusIs('En línea');
    assert.equal(hits.good, n, 'reutiliza la comprobación reciente');
    await panel().getByRole('button', { name: 'Comprobar de nuevo' }).click();
    await waitFor(() => hits.good === n + 1, 'segunda llamada');
    await statusIs('En línea');
  });

  it('pestaña Cuenta: filas con tipo de servidor, autenticación, usuario y clave; y el botón de cambiar credencial según el método', async () => {
    const panelTab = panel().locator('[role=tabpanel]');
    await select('deploy');
    const text = await panelTab.innerText();
    assert.match(text, /Tipo de servidor\s+GitLab/);
    assert.match(text, /Tipo de autenticación\s+Clave SSH/);
    assert.match(text, /Usuario\s+deploy/);
    assert.ok(text.includes(keyA), 'muestra la ruta de la clave');
    await panelTab.getByRole('button', { name: 'Cambiar clave…' }).waitFor();
    await select('dave');
    await panelTab.getByRole('button', { name: 'Actualizar contraseña…' }).waitFor();
    assert.equal(await panelTab.getByText(keyA).count(), 0);
    await select('ana');
    await panelTab.getByRole('button', { name: 'Actualizar token…' }).waitFor();
  });

  it('pestañas: Cuenta y Repositorios (roles, aria-selected y flechas); sin API explica por qué', async () => {
    const tabs = panel().locator('section [role=tablist] [role=tab]');
    assert.deepEqual((await tabs.allInnerTexts()).map((t) => t.trim()), ['Cuenta', 'Repositorios']);
    assert.equal(await tabs.nth(0).getAttribute('aria-selected'), 'true');
    assert.equal(await panel().locator('[role=tabpanel]').count(), 1);
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await waitFor(async () => (await tabs.nth(1).getAttribute('aria-selected')) === 'true', 'segunda pestaña');
    assert.equal(await tabs.nth(1).evaluate((el) => el === document.activeElement), true, 'el foco acompaña');
    await panel().getByText('El listado de repositorios y los pull requests no están disponibles para esta cuenta.').count()
      .then((n) => assert.equal(n, 0, 'ana sí tiene API'));
    await panel().getByRole('button', { name: 'Clonar desde esta cuenta…' }).waitFor();
    await select('deploy');
    await panel().getByText('El listado de repositorios y los pull requests no están disponibles para esta cuenta.').waitFor();
    assert.equal(await panel().getByRole('button', { name: 'Clonar desde esta cuenta…' }).count(), 0);
    await page.keyboard.press('Tab');
    await tabs.nth(1).focus();
    await page.keyboard.press('ArrowLeft');
    await waitFor(async () => (await tabs.nth(0).getAttribute('aria-selected')) === 'true', 'vuelve a Cuenta');
  });

  it('«Clonar desde esta cuenta…» abre «Clonar desde mi cuenta» con esa cuenta elegida; Escape solo cierra ese diálogo', async () => {
    await select('erin');
    await panel().getByRole('tab', { name: 'Repositorios', exact: true }).click();
    await panel().getByRole('button', { name: 'Clonar desde esta cuenta…' }).click();
    await page.getByRole('heading', { name: 'Clonar desde mi cuenta' }).waitFor();
    assert.equal(await page.locator('select').last().inputValue(), 'ok');
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Clonar desde mi cuenta' }).waitFor({ state: 'detached' });
    assert.equal(await panel().getByRole('option').count(), 6, 'Ajustes sigue abierto');
    await panel().getByRole('tab', { name: 'Cuenta', exact: true }).click();
  });

  it('teclado en la lista: flechas, Inicio y Fin cambian la selección y el foco, con límites', async () => {
    await select('ana');
    await opt('ana').focus();
    const focusedId = () => page.evaluate(() => document.activeElement?.id ?? '');
    await page.keyboard.press('ArrowDown');
    await waitSelected('deploy');
    await waitFor(async () => (await focusedId()) === 'acc-opt-ssh', 'foco en deploy');
    await page.keyboard.press('ArrowDown');
    await waitSelected('carol');
    await page.keyboard.press('ArrowUp');
    await waitSelected('deploy');
    await page.keyboard.press('End');
    await waitSelected('fran');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    await waitSelected('fran');
    await page.keyboard.press('Home');
    await waitSelected('ana');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
    await waitSelected('ana');
    assert.equal(await panel().locator('[role=option][tabindex="0"]').count(), 1, 'un solo elemento tabulable');
  });

  it('cuenta con token: el diálogo de edición permite cambiar de método, no muestra el token y exige uno nuevo', async () => {
    await select('ana');
    await panel().getByRole('button', { name: 'Actualizar token…' }).click();
    await top().getByRole('heading', { name: /Editar cuenta: ana@gitlab.com/ }).waitFor();
    assert.equal(await page.locator('#a-secret').inputValue(), '', 'el token actual nunca se muestra');
    await waitFor(() => page.locator('#a-secret').evaluate((el) => el === document.activeElement), 'foco en el token');
    assert.equal(await top().getByRole('radio', { name: 'Token' }).isChecked(), true);
    for (const m of ['Contraseña', 'OAuth', 'Clave SSH']) {
      assert.equal(await top().getByRole('radio', { name: m }).isEnabled(), true, `${m} se puede elegir al editar`);
    }
    assert.equal(await page.locator('#a-server').evaluate((el) => (el as HTMLInputElement).readOnly), true);
    assert.equal(await top().getByRole('button', { name: 'Atrás' }).count(), 0, 'la edición no tiene paso de plataforma');
    const submit = top().getByRole('button', { name: 'Guardar cambios' });
    assert.equal(await submit.isDisabled(), true, 'sin token nuevo no se puede guardar');
    await page.locator('#a-secret').fill('glpat-nuevo');
    assert.equal(await submit.isDisabled(), false);
  });

  it('Cancelar cierra el diálogo y no cambia nada; el foco vuelve al botón que lo abrió', async () => {
    const before = JSON.stringify(saved());
    await top().getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('heading', { name: /Editar cuenta/ }).waitFor({ state: 'detached' });
    assert.equal(JSON.stringify(saved()), before);
    await waitFor(
      () => page.evaluate(() => document.activeElement?.textContent?.includes('Actualizar token') ?? false),
      'foco de vuelta en «Actualizar token…»',
    );
  });

  it('cuenta SSH: se cambia la ruta de la clave, se conserva el id, no se duplica y el detalle la muestra', async () => {
    await select('deploy');
    await panel().getByRole('button', { name: 'Cambiar clave…' }).click();
    await top().getByRole('heading', { name: /Editar cuenta: deploy@git.acme.com/ }).waitFor();
    assert.equal(await key().inputValue(), keyA, 'la ruta actual sí se muestra (no es un secreto)');
    assert.equal(await page.locator('#a-user').evaluate((el) => (el as HTMLInputElement).readOnly), true, 'el usuario queda fijo');
    await key().fill(keyB);
    await top().getByRole('button', { name: 'Guardar cambios' }).click();
    await page.getByRole('heading', { name: /Editar cuenta/ }).waitFor({ state: 'detached' });
    const accs = saved();
    assert.equal(accs.length, 6, 'no se crea una cuenta nueva');
    const ssh = accs.find((a) => a['id'] === 'ssh');
    assert.ok(ssh, 'conserva el id');
    assert.equal(ssh['sshKeyPath'], keyB);
    await waitSelected('deploy');
    await panel().locator('[role=tabpanel]').getByText(keyB).waitFor();
  });

  it('una ruta de clave inválida se rechaza dentro del diálogo y la cuenta no cambia', async () => {
    await panel().getByRole('button', { name: 'Cambiar clave…' }).click();
    await key().fill(path.join(base, 'no-existe'));
    await top().getByRole('button', { name: 'Guardar cambios' }).click();
    await top().getByRole('alert').waitFor();
    assert.equal(saved().find((a) => a['id'] === 'ssh')?.['sshKeyPath'], keyB);
    await top().getByRole('button', { name: 'Cancelar' }).click();
    await page.getByRole('heading', { name: /Editar cuenta/ }).waitFor({ state: 'detached' });
  });

  it('quitar con confirmación: cancelar conserva la cuenta; confirmar la quita y selecciona la vecina', async () => {
    await select('fran');
    const minus = panel().getByRole('button', { name: 'Quitar cuenta' });
    await minus.click();
    await top().getByText(/¿Quitar la cuenta fran@github.com\?/).waitFor();
    await top().getByRole('button', { name: 'Cancelar' }).click();
    await page.waitForTimeout(250);
    assert.equal(saved().length, 6, 'cancelar no quita nada');
    assert.equal(await panel().getByRole('option').count(), 6);
    await minus.click();
    await top().getByRole('button', { name: 'Quitar', exact: true }).click();
    await waitFor(() => saved().length === 5, 'cuenta quitada de settings.json');
    await opt('fran').waitFor({ state: 'detached' });
    // editar la cuenta SSH la dejó al final de la lista: la vecina de fran es deploy
    await waitSelected('deploy');
    assert.equal(saved().some((a) => a['id'] === 'slow'), false);
  });

  it('quitar la primera selecciona la siguiente', async () => {
    await select('ana');
    await panel().getByRole('button', { name: 'Quitar cuenta' }).click();
    await top().getByRole('button', { name: 'Quitar', exact: true }).click();
    await waitFor(() => saved().length === 4, 'cuenta quitada');
    await waitSelected('carol');
  });

  it('cambiar de token a clave SSH al editar: la cuenta pasa a SSH, no se duplica y desaparece la de token', async () => {
    await select('carol');
    await panel().getByRole('button', { name: 'Actualizar token…' }).click();
    await top().getByRole('heading', { name: /Editar cuenta: carol@codeberg.org/ }).waitFor();
    await top().getByRole('radio', { name: 'Clave SSH' }).check();
    assert.equal(await key().inputValue(), '', 'no hay clave previa');
    assert.equal(await top().getByRole('button', { name: 'Guardar cambios' }).isDisabled(), true, 'la clave es obligatoria');
    await key().fill(keyB);
    await top().getByRole('button', { name: 'Guardar cambios' }).click();
    await page.getByRole('heading', { name: /Editar cuenta/ }).waitFor({ state: 'detached' });
    const accs = saved();
    assert.equal(accs.length, 4, 'la cuenta de token se reemplaza, no se suma otra');
    assert.equal(accs.some((a) => a['id'] === 'inv'), false, 'desaparece la cuenta de token');
    const carol = accs.filter((a) => a['username'] === 'carol');
    assert.equal(carol.length, 1);
    assert.equal(carol[0]['authMethod'], 'ssh');
    assert.equal(carol[0]['sshKeyPath'], keyB);
    await waitSelected('carol');
    await panel().locator('[role=tabpanel]').getByText(keyB).waitFor();
  });
});

async function waitFor(fn: () => boolean | Promise<boolean>, what: string, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`tiempo agotado: ${what}`);
}
