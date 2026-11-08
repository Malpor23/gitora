import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { GitRunner } from '../git/git-runner';
import { GitService } from '../git/git-service';
import { createEditorHelper } from '../git/editor-helper';
import { decodeOAuthSecret, encodeOAuthSecret } from '../providers/oauth';
import { ProviderRegistry } from '../providers/provider-registry';
import { isSshUrl, sshCommandFor, validateSshKeyPath } from '../providers/ssh-key';
import { SettingsStore } from '../settings-store';

/**
 * Autenticación de cuentas: token, usuario y contraseña, clave SSH y OAuth (device flow), contra
 * servidores HTTP falsos locales y sin Electron. `npm run test:core`
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), 'gitora-accounts-'));

/** Cifrado de mentira reversible: permite comprobar que el disco no guarda el secreto en claro. */
const cipher = {
  available: () => true,
  encrypt: (s: string) => 'enc:' + Buffer.from(s).toString('base64'),
  decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString('utf8'),
};

let n = 0;
const freshStore = () => new SettingsStore(path.join(tmp, `store-${++n}`), cipher);
const settingsFile = (dir: string) => readFileSync(path.join(dir, 'settings.json'), 'utf8');

/* ───────────── servidor falso: API tipo GitHub/Gitea + device flow ───────────── */

interface Mock {
  /** Respuestas del endpoint de token, en orden; la última se repite. */
  tokenReplies: Record<string, unknown>[];
  refreshCalls: number;
  tokenCalls: number;
  lastBasic: string | null;
}
const mock: Mock = { tokenReplies: [], refreshCalls: 0, tokenCalls: 0, lastBasic: null };
let server: http.Server;
let base = '';

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const form = (req: http.IncomingMessage) =>
  new Promise<URLSearchParams>((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(new URLSearchParams(raw)));
  });

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const auth = req.headers.authorization ?? '';
    // API tipo GitHub (token Bearer)
    if (url === '/api/v3/user') {
      if (auth === 'Bearer good-token' || auth === 'Bearer oauth-token' || auth === 'Bearer refreshed-token') {
        return json(res, 200, { login: 'ana', name: 'Ana', avatar_url: 'http://x/a.png' });
      }
      return json(res, 401, { message: 'Bad credentials' });
    }
    // Listado de repos: solo acepta el token renovado (prueba que la API usa el token vigente)
    if (url.startsWith('/api/v3/user/repos')) {
      return auth === 'Bearer refreshed-token' ? json(res, 200, []) : json(res, 401, { message: 'Bad credentials' });
    }
    // API tipo Gitea (HTTP Basic con contraseña)
    if (url === '/api/v1/user') {
      mock.lastBasic = auth;
      if (auth === 'Basic ' + Buffer.from('ana:pw').toString('base64')) {
        return json(res, 200, { login: 'ana', full_name: 'Ana', avatar_url: 'http://x/a.png' });
      }
      return json(res, 401, { message: 'invalid credentials' });
    }
    // Device flow
    if (url === '/login/device/code' && req.method === 'POST') {
      await form(req);
      return json(res, 200, {
        device_code: 'DEVICE-SECRET',
        user_code: 'ABCD-1234',
        verification_uri: `${base}/login/device`,
        expires_in: 900,
        interval: 1,
      });
    }
    if (url === '/login/oauth/access_token' && req.method === 'POST') {
      const body = await form(req);
      if (body.get('grant_type') === 'refresh_token') {
        mock.refreshCalls++;
        return json(res, 200, { access_token: 'refreshed-token', refresh_token: 'r2', expires_in: 3600 });
      }
      const reply = mock.tokenReplies[Math.min(mock.tokenCalls, mock.tokenReplies.length - 1)];
      mock.tokenCalls++;
      return json(res, 200, reply);
    }
    json(res, 404, { message: 'no existe' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  mock.tokenReplies = [];
  mock.refreshCalls = 0;
  mock.tokenCalls = 0;
  mock.lastBasic = null;
});

const b64 = (s: string) => Buffer.from(s).toString('base64');
const header = (user: string, pass: string) => `http.http://${new URL(base).host}/.extraHeader=Authorization: Basic ${b64(`${user}:${pass}`)}`;
const repoUrl = () => `${base}/org/repo.git`;

function fakeKey(name = 'id_test', content = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n') {
  const p = path.join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe('cuentas con token', () => {
  it('guarda la cuenta, cifra el token y autentica por HTTPS', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const acc = await reg.addAccount({ provider: 'github', baseUrl: base, token: 'good-token' });
    assert.equal(acc.authMethod, 'token');
    assert.equal(acc.apiAccess, true);
    assert.equal(acc.hasToken, true);
    assert.equal(acc.username, 'ana');
    assert.deepEqual(await reg.authConfigFor(repoUrl()), [header('x-access-token', 'good-token')]);
    assert.ok(!settingsFile(path.join(tmp, `store-${n}`)).includes('good-token'), 'el token no está en claro');
  });

  it('rechaza un token inválido y no guarda nada', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    await assert.rejects(() => reg.addAccount({ provider: 'github', baseUrl: base, token: 'malo' }), /401|inválido/i);
    assert.equal(store.get().accounts.length, 0);
    await assert.rejects(() => reg.addAccount({ provider: 'github', baseUrl: base, token: '   ' }), /token/i);
  });

  it('no envía la cabecera a otro servidor', async () => {
    const reg = new ProviderRegistry(freshStore());
    await reg.addAccount({ provider: 'github', baseUrl: base, token: 'good-token' });
    assert.deepEqual(await reg.authConfigFor('https://otro.example.com/org/repo.git'), []);
  });
});

describe('cuentas con usuario y contraseña', () => {
  it('Gitea: valida contra la API y autentica con usuario:contraseña', async () => {
    const reg = new ProviderRegistry(freshStore());
    const acc = await reg.addAccount({ provider: 'gitea', baseUrl: base, authMethod: 'password', username: 'ana', token: 'pw' });
    assert.equal(acc.authMethod, 'password');
    assert.equal(acc.apiAccess, true);
    assert.deepEqual(await reg.authConfigFor(repoUrl()), [header('ana', 'pw')]);
  });

  it('Gitea: una contraseña incorrecta se rechaza', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    await assert.rejects(
      () => reg.addAccount({ provider: 'gitea', baseUrl: base, authMethod: 'password', username: 'ana', token: 'mal' }),
      /401|inválid/i,
    );
    assert.equal(store.get().accounts.length, 0);
  });

  it('GitLab: sirve para git pero no tiene acceso a la API', async () => {
    const reg = new ProviderRegistry(freshStore());
    const acc = await reg.addAccount({ provider: 'gitlab', baseUrl: base, authMethod: 'password', username: 'ana', token: 'secreto' });
    assert.equal(acc.apiAccess, false);
    assert.deepEqual(await reg.authConfigFor(repoUrl()), [header('ana', 'secreto')]);
    await assert.rejects(() => reg.listRepositories(acc.id, ''), /no tiene acceso a la API/);
    await assert.rejects(() => reg.pullRequests(repoUrl()), /acceso a la API/);
  });

  it('exige usuario y contraseña', async () => {
    const reg = new ProviderRegistry(freshStore());
    await assert.rejects(() => reg.addAccount({ provider: 'gitlab', baseUrl: base, authMethod: 'password', token: 'x' }), /usuario/i);
    await assert.rejects(() => reg.addAccount({ provider: 'gitlab', baseUrl: base, authMethod: 'password', username: 'ana' }), /contraseña/i);
  });

  it('GitHub y Bitbucket no ofrecen contraseña', async () => {
    const reg = new ProviderRegistry(freshStore());
    await assert.rejects(() => reg.addAccount({ provider: 'github', authMethod: 'password', username: 'a', token: 'b' }), /no admite/);
    await assert.rejects(() => reg.addAccount({ provider: 'bitbucket', authMethod: 'password', username: 'a', token: 'b' }), /no admite/);
  });
});

describe('cuentas con clave SSH', () => {
  it('guarda solo la ruta y usa la clave en los remotos SSH de ese servidor', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const key = fakeKey();
    const acc = await reg.addAccount({ provider: 'github', authMethod: 'ssh', username: 'ana', sshKeyPath: key });
    assert.equal(acc.authMethod, 'ssh');
    assert.equal(acc.sshKeyPath, key);
    assert.equal(acc.apiAccess, false);
    assert.equal(acc.hasToken, false);
    assert.equal(acc.host, 'github.com');
    const expected = [`core.sshCommand=${sshCommandFor(key)}`];
    assert.deepEqual(await reg.authConfigFor('git@github.com:org/repo.git'), expected);
    assert.deepEqual(await reg.authConfigFor('ssh://git@github.com/org/repo.git'), expected);
    // otro servidor y HTTPS no se tocan
    assert.deepEqual(await reg.authConfigFor('git@gitlab.com:org/repo.git'), []);
    assert.deepEqual(await reg.authConfigFor('https://github.com/org/repo.git'), []);
    // ningún secreto: el contenido de la clave no se guarda
    assert.ok(!settingsFile(path.join(tmp, `store-${n}`)).includes('OPENSSH'));
    await assert.rejects(() => reg.listRepositories(acc.id, ''), /acceso a la API/);
  });

  it('el comando fuerza la clave y no espera contraseñas', () => {
    const cmd = sshCommandFor('/home/a/.ssh/id_x');
    assert.match(cmd, /^ssh -i "\/home\/a\/\.ssh\/id_x" /);
    assert.match(cmd, /IdentitiesOnly=yes/);
    assert.match(cmd, /BatchMode=yes/);
  });

  it('reconoce los remotos SSH', () => {
    assert.ok(isSshUrl('git@github.com:org/repo.git'));
    assert.ok(isSshUrl('ssh://git@host:2222/org/repo.git'));
    assert.ok(!isSshUrl('https://github.com/org/repo.git'));
    assert.ok(!isSshUrl('/ruta/local/repo'));
  });

  it('valida la ruta de la clave', async () => {
    await assert.rejects(() => validateSshKeyPath(''), /ruta/i);
    await assert.rejects(() => validateSshKeyPath('relativa/clave'), /absoluta/);
    await assert.rejects(() => validateSshKeyPath(path.join(tmp, 'no-existe')), /No existe/);
    await assert.rejects(() => validateSshKeyPath(fakeKey('id.pub', 'ssh-ed25519 AAAA ana@x')), /pública/);
    await assert.rejects(() => validateSshKeyPath(fakeKey('sin-pub-ext', 'ssh-ed25519 AAAA ana@x')), /pública/);
    await assert.rejects(() => validateSshKeyPath(fakeKey('basura', 'hola mundo')), /no parece/);
    await assert.rejects(() => validateSshKeyPath(path.join(tmp, 'a"b')), /no permitidos/);
    assert.equal(await validateSshKeyPath(fakeKey('buena')), path.join(tmp, 'buena'));
  });

  it('expande ~ al directorio personal', async () => {
    const home = mkdtempSync(path.join(tmp, 'home-'));
    writeFileSync(path.join(home, 'k'), '-----BEGIN RSA PRIVATE KEY-----\nx\n');
    assert.equal(await validateSshKeyPath('~/k', home), path.join(home, 'k'));
  });

  it('exige usuario y una clave válida', async () => {
    const reg = new ProviderRegistry(freshStore());
    await assert.rejects(() => reg.addAccount({ provider: 'github', authMethod: 'ssh', sshKeyPath: fakeKey('k1') }), /usuario/i);
    await assert.rejects(() => reg.addAccount({ provider: 'github', authMethod: 'ssh', username: 'ana', sshKeyPath: '/no/existe' }), /No existe/);
  });
});

describe('una cuenta con varios métodos en el mismo servidor', () => {
  it('HTTPS usa el token y SSH usa la clave', async () => {
    const reg = new ProviderRegistry(freshStore());
    const key = fakeKey('k-multi');
    const token = await reg.addAccount({ provider: 'github', baseUrl: base, token: 'good-token' });
    const ssh = await reg.addAccount({ provider: 'github', baseUrl: base, authMethod: 'ssh', username: 'ana', sshKeyPath: key });
    assert.notEqual(token.id, ssh.id, 'son cuentas distintas aunque el usuario y el servidor coincidan');
    const host = new URL(base).hostname;
    assert.deepEqual(await reg.authConfigFor(repoUrl()), [header('x-access-token', 'good-token')]);
    assert.deepEqual(await reg.authConfigFor(`git@${host}:org/repo.git`), [`core.sshCommand=${sshCommandFor(key)}`]);
  });

  it('volver a añadir el mismo método actualiza la cuenta en vez de duplicarla', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const a = await reg.addAccount({ provider: 'github', baseUrl: base, token: 'good-token' });
    const b = await reg.addAccount({ provider: 'github', baseUrl: base, token: 'good-token' });
    assert.equal(a.id, b.id);
    assert.equal(store.get().accounts.length, 1);
  });

  it('cuentas de proveedores distintos conviven', async () => {
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    await reg.addAccount({ provider: 'github', baseUrl: base, token: 'good-token' });
    const key = fakeKey('k-prov');
    await reg.addAccount({ provider: 'gitlab', authMethod: 'ssh', username: 'ana', sshKeyPath: key });
    await reg.addAccount({ provider: 'bitbucket', authMethod: 'ssh', username: 'ana', sshKeyPath: key });
    assert.deepEqual(
      store.get().accounts.map((a) => a.provider).sort(),
      ['bitbucket', 'github', 'gitlab'],
    );
  });
});

describe('OAuth (device flow)', () => {
  it('inicia, espera la autorización y crea la cuenta sin exponer el device_code', async () => {
    mock.tokenReplies = [{ error: 'authorization_pending' }, { access_token: 'oauth-token' }];
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const code = await reg.oauthStart({ provider: 'github', baseUrl: base, clientId: 'mi-client-id' });
    assert.equal(code.userCode, 'ABCD-1234');
    assert.equal(code.verificationUri, `${base}/login/device`);
    assert.ok(code.sessionId);
    assert.ok(!JSON.stringify(code).includes('DEVICE-SECRET'), 'el device_code no llega al renderer');

    const acc = await reg.oauthComplete(code.sessionId);
    assert.equal(acc.authMethod, 'oauth');
    assert.equal(acc.apiAccess, true);
    assert.equal(acc.username, 'ana');
    assert.equal(mock.tokenCalls, 2, 'una espera pendiente y luego el token');
    assert.deepEqual(await reg.authConfigFor(repoUrl()), [header('x-access-token', 'oauth-token')]);
    const disk = settingsFile(path.join(tmp, `store-${n}`));
    assert.ok(!disk.includes('oauth-token'), 'el token OAuth se guarda cifrado');
    // la sesión se consumió
    await assert.rejects(() => reg.oauthComplete(code.sessionId), /ya no existe/);
  });

  it('renueva el token vencido con el refresh token y guarda el nuevo', async () => {
    mock.tokenReplies = [{ access_token: 'oauth-token', refresh_token: 'r1', expires_in: 3600 }];
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const code = await reg.oauthStart({ provider: 'github', baseUrl: base, clientId: 'cid' });
    const acc = await reg.oauthComplete(code.sessionId);
    // se simula que el token venció hace un minuto
    const stored = decodeOAuthSecret(store.token(acc.id) as string);
    assert.ok(stored?.refreshToken === 'r1' && stored.expiresAt);
    store.setSecret(acc.id, encodeOAuthSecret({ ...stored, expiresAt: Date.now() - 60_000 }));

    const [a, b] = await Promise.all([reg.authConfigFor(repoUrl()), reg.authConfigFor(repoUrl())]);
    assert.deepEqual(a, [header('x-access-token', 'refreshed-token')]);
    assert.deepEqual(b, a);
    assert.equal(mock.refreshCalls, 1, 'dos peticiones simultáneas comparten una sola renovación');
    assert.equal(decodeOAuthSecret(store.token(acc.id) as string)?.accessToken, 'refreshed-token');
    // y la API también usa el token renovado (con el viejo daría 401)
    assert.deepEqual(await reg.listRepositories(acc.id, ''), []);
  });

  it('cancelar aborta la espera', async () => {
    mock.tokenReplies = [{ error: 'authorization_pending' }];
    const reg = new ProviderRegistry(freshStore());
    const code = await reg.oauthStart({ provider: 'github', baseUrl: base, clientId: 'cid' });
    const pending = reg.oauthComplete(code.sessionId);
    setTimeout(() => reg.oauthCancel(code.sessionId), 100);
    await assert.rejects(() => pending, /cancel|abort/i);
  });

  it('si el usuario rechaza, no se crea la cuenta', async () => {
    mock.tokenReplies = [{ error: 'access_denied' }];
    const store = freshStore();
    const reg = new ProviderRegistry(store);
    const code = await reg.oauthStart({ provider: 'github', baseUrl: base, clientId: 'cid' });
    await assert.rejects(() => reg.oauthComplete(code.sessionId), /Rechazaste|denied/i);
    assert.equal(store.get().accounts.length, 0);
  });

  it('valida el proveedor y el Client ID', async () => {
    const reg = new ProviderRegistry(freshStore());
    await assert.rejects(() => reg.oauthStart({ provider: 'bitbucket', clientId: 'x' }), /no admite/);
    await assert.rejects(() => reg.oauthStart({ provider: 'gitea', clientId: 'x' }), /no admite/);
    await assert.rejects(() => reg.oauthStart({ provider: 'github', baseUrl: base, clientId: '  ' }), /Client ID/);
  });

  it('un token en texto plano nunca se confunde con un secreto OAuth', () => {
    assert.equal(decodeOAuthSecret('good-token'), null);
  });
});

describe('migración y varias claves SSH', () => {
  it('las cuentas guardadas antes de existir los métodos pasan a ser de token', () => {
    const dir = path.join(tmp, 'legacy');
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        settings: {
          accounts: [{ id: 'viejo', provider: 'github', baseUrl: 'https://api.github.com', host: 'github.com', username: 'ana', hasToken: true }],
        },
        tokens: { viejo: { value: 'enc:' + b64('tok'), encrypted: true } },
      }),
    );
    const store = new SettingsStore(dir, cipher);
    const [acc] = store.get().accounts;
    assert.equal(acc.authMethod, 'token');
    assert.equal(acc.apiAccess, true);
    assert.equal(store.token('viejo'), 'tok');
    assert.deepEqual(store.get().oauthClientIds, {});
  });

  it('con claves distintas para varios remotos no se fuerza ninguna', async () => {
    const dir = path.join(tmp, 'multi-ssh');
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['remote', 'add', 'uno', 'git@a.example:o/r.git'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'dos', 'git@b.example:o/r.git'], { cwd: dir });
    execFileSync('git', ['remote', 'add', 'tres', 'git@a.example:o/otro.git'], { cwd: dir });
    const resolver = (url: string) => [`core.sshCommand=ssh -i "/k/${url.includes('b.example') ? 'b' : 'a'}"`];
    const git = new GitService(new GitRunner('git'), resolver, createEditorHelper(tmp, process.execPath), path.join(tmp, 'work'));
    const remoteAuth = (r?: string) => (git as unknown as { remoteAuth(repo: string, remote?: string): Promise<string[]> }).remoteAuth(dir, r);
    assert.deepEqual(await remoteAuth('uno'), ['core.sshCommand=ssh -i "/k/a"']);
    assert.deepEqual(await remoteAuth('dos'), ['core.sshCommand=ssh -i "/k/b"']);
    assert.deepEqual(await remoteAuth('tres'), ['core.sshCommand=ssh -i "/k/a"'], 'misma clave: se conserva');
    assert.deepEqual(await remoteAuth(), [], 'a.example y b.example usan claves distintas: ninguna');
  });
});
