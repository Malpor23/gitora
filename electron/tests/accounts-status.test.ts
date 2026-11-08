import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Account } from '@core/models';
import { ProviderRegistry } from '../providers/provider-registry';
import { SettingsStore } from '../settings-store';

/**
 * Comprobación del estado de una cuenta (`checkAccount`) contra un servidor falso en 127.0.0.1.
 * `npm run test:core`
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), 'gitora-status-'));
const cipher = {
  available: () => true,
  encrypt: (s: string) => 'enc:' + Buffer.from(s).toString('base64'),
  decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString('utf8'),
};
let n = 0;
const freshStore = () => new SettingsStore(path.join(tmp, `store-${++n}`), cipher);

let server: http.Server;
let base = '';
let hits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    const auth = req.headers.authorization ?? '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/v3/user') {
      if (auth === 'Bearer good') return json(200, { login: 'ana', name: 'Ana', avatar_url: '' });
      if (auth === 'Bearer forbidden') return json(403, { message: 'forbidden' });
      if (auth === 'Bearer broken') return json(500, { message: 'boom' });
      if (auth === 'Bearer slow') return; // nunca responde
      return json(401, { message: 'Bad credentials' });
    }
    json(404, { message: 'no existe' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v3`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function seed(store: SettingsStore, patch: Partial<Account>, secret: string | null): Account {
  const account: Account = {
    id: `acc-${++n}`,
    provider: 'github',
    baseUrl: base,
    host: '127.0.0.1',
    username: 'ana',
    hasToken: secret !== null,
    authMethod: 'token',
    apiAccess: true,
    ...patch,
  };
  store.upsertAccount(account, secret);
  return account;
}

describe('estado de la cuenta', () => {
  it('online con una credencial válida', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    assert.equal(await reg.checkAccount(seed(store, {}, 'good').id), 'online');
  });

  it('invalid con 401 y con 403', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    assert.equal(await reg.checkAccount(seed(store, {}, 'revoked').id), 'invalid');
    assert.equal(await reg.checkAccount(seed(store, {}, 'forbidden').id), 'invalid');
  });

  it('offline si el servidor no responde (puerto cerrado), da error 5xx o se agota el tiempo', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    assert.equal(await reg.checkAccount(seed(store, { baseUrl: 'http://127.0.0.1:9/api/v3' }, 'good').id), 'offline');
    assert.equal(await reg.checkAccount(seed(store, {}, 'broken').id), 'offline');
    const started = Date.now();
    assert.equal(await reg.checkAccount(seed(store, {}, 'slow').id, 150), 'offline');
    assert.ok(Date.now() - started < 3000, 'respeta el tiempo máximo');
  });

  it('unverifiable (SSH o sin API) sin tocar la red', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const ssh = seed(store, { authMethod: 'ssh', apiAccess: false, sshKeyPath: '/tmp/key' }, null);
    const noApi = seed(store, { authMethod: 'password', apiAccess: false }, 'pw');
    hits = 0;
    assert.equal(await reg.checkAccount(ssh.id), 'unverifiable');
    assert.equal(await reg.checkAccount(noApi.id), 'unverifiable');
    assert.equal(hits, 0);
  });

  it('invalid sin secreto guardado, y error si la cuenta no existe', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    assert.equal(await reg.checkAccount(seed(store, {}, null).id), 'invalid');
    await assert.rejects(() => reg.checkAccount('no-existe'), /ya no existe/);
  });

  it('el secreto no aparece en el resultado ni en el disco en claro', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const acc = seed(store, {}, 'good');
    const result = await reg.checkAccount(acc.id);
    assert.ok(!JSON.stringify(result).includes('good'));
    assert.ok(!readFileSync(path.join(tmp, `store-${n - 1}`, 'settings.json'), 'utf8').includes('"good"'));
  });
});
