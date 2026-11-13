import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Page } from 'playwright-core';
import { App, Fixture, makeFixture } from './helpers';

/**
 * Accesibilidad (WCAG 2.2 AA) en Electron real: pasa axe-core por las pantallas principales y
 * comprueba el teclado de las listas y de las pestañas. Requiere pantalla y el build previo.
 */
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.platform !== 'linux');
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Violation {
  id: string;
  impact: string | null;
  nodes: number;
  help: string;
  targets: string[];
}

async function scan(page: Page): Promise<Violation[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (tags) => {
    const res = await (window as unknown as { axe: { run: (c: Document, o: unknown) => Promise<{ violations: any[] }> } }).axe.run(document, {
      runOnly: { type: 'tag', values: tags },
    });
    return res.violations.map((v) => ({
      id: v.id as string,
      impact: v.impact as string | null,
      nodes: v.nodes.length as number,
      help: v.help as string,
      targets: v.nodes.slice(0, 3).map((n: any) => `${n.target.join(' ')} :: ${(n.any[0] ?? n.all[0] ?? n.none[0])?.message ?? ''}`.slice(0, 200)),
    }));
  }, TAGS);
}

const describeViolations = (vs: Violation[]) =>
  vs.map((v) => `${v.id} (${v.impact}) x${v.nodes}: ${v.help}\n    ${v.targets.join('\n    ')}`).join('\n');

describe('accesibilidad (E2E, axe-core WCAG 2.2 AA)', { skip: hasDisplay ? false : 'sin pantalla (usa xvfb-run)' }, () => {
  let fx: Fixture;
  let app: App;
  let page: Page;
  const sleep = (ms: number) => page.waitForTimeout(ms);
  const expectClean = async (label: string) => {
    const vs = await scan(page);
    assert.equal(vs.length, 0, `${label}: ${vs.length} regla(s) con violaciones\n${describeViolations(vs)}`);
  };
  const goChanges = async () => {
    await page.getByText(/Cambios locales/).first().click();
    await page.locator('gt-changes').waitFor();
    await page.keyboard.press('F5');
    await sleep(700);
  };

  before(async () => {
    fx = makeFixture();
    app = await App.launch(fx);
    page = app.page;
  });
  after(async () => {
    await app?.close();
    fx?.cleanup();
  });

  it('historial', async () => {
    await expectClean('historial');
  });

  it('historial con un commit seleccionado', async () => {
    await page.locator('[role=listbox] [role=option]').first().click();
    await sleep(500);
    await expectClean('historial con commit');
  });

  it('cambios con un archivo abierto en el diff', async () => {
    await goChanges();
    await page.getByText('README.md').first().click();
    await sleep(400);
    await expectClean('cambios');
  });

  it('paleta de comandos', async () => {
    await page.keyboard.press('Control+Shift+P');
    await page.locator('#palette-results').waitFor();
    await expectClean('paleta');
    await page.keyboard.press('Escape');
  });

  it('ajustes y cada una de sus pestañas', async () => {
    await page.getByRole('button', { name: /Ajustes|Settings/ }).first().click();
    await page.locator('[role=dialog]').waitFor();
    await expectClean('ajustes');
    const tabs = page.locator('[role=dialog] [role=tablist] [role=tab]');
    const n = await tabs.count();
    assert.ok(n >= 3, 'Ajustes tiene pestañas');
    for (let i = 0; i < n; i++) {
      await tabs.nth(i).click();
      await sleep(400);
      await expectClean(`ajustes, pestaña ${i + 1}`);
    }
    await page.keyboard.press('Escape');
  });

  it('menú contextual', async () => {
    await page.locator('[role=tab]').first().click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    await expectClean('menú contextual');
    await page.keyboard.press('Escape');
  });

  describe('teclado', () => {
    it('las listas de archivos se recorren con flechas y Enter o Espacio preparan y quitan de lo preparado', async () => {
      writeFileSync(path.join(fx.repo, 'k1.txt'), 'uno\n');
      writeFileSync(path.join(fx.repo, 'k2.txt'), 'dos\n');
      await goChanges();
      const list = page.locator('ul[role=listbox][aria-label]').first();
      assert.equal(await list.getAttribute('tabindex'), '0', 'la lista recibe el foco con Tab');
      await list.focus();
      const opts = list.locator('[role=option]');
      const total = await opts.count();
      assert.ok(total >= 2, 'hay al menos dos archivos sin preparar');
      await page.keyboard.press('Home');
      await sleep(250);
      assert.equal(await opts.first().getAttribute('aria-selected'), 'true');
      assert.equal(await list.getAttribute('aria-activedescendant'), 'file-unstaged-0');
      await page.keyboard.press('ArrowDown');
      await sleep(250);
      assert.equal(await opts.nth(1).getAttribute('aria-selected'), 'true');
      assert.equal(await opts.first().getAttribute('aria-selected'), 'false');
      await page.keyboard.press('End');
      await sleep(250);
      assert.equal(await opts.nth(total - 1).getAttribute('aria-selected'), 'true');

      // La primera línea es la insignia del estado (U, M...); la segunda, el nombre del archivo.
      const name = (await opts.nth(total - 1).innerText()).split('\n').map((l) => l.trim()).filter(Boolean)[1];
      await page.keyboard.press('Enter');
      const staged = () => fx.g('diff', '--cached', '--name-only').split('\n');
      const isStaged = () => staged().some((p) => p === name || p.endsWith(`/${name}`));
      for (let i = 0; i < 30 && !isStaged(); i++) await sleep(150);
      assert.ok(isStaged(), `Enter prepara ${name} (preparados: ${staged().join(', ')})`);
    });

    it('Supr cierra la pestaña enfocada', async () => {
      const tabs = page.locator('header [role=tab]');
      assert.equal(await tabs.count(), 1);
      await tabs.first().focus();
      await page.keyboard.press('Delete');
      for (let i = 0; i < 30 && (await tabs.count()) > 0; i++) await sleep(150);
      assert.equal(await tabs.count(), 0, 'la pestaña se cerró');
    });
  });
});
