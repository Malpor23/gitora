import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  decodeOAuthSecret,
  deviceFlowEndpoints,
  encodeOAuthSecret,
  needsRefresh,
  OAuthError,
  pollForToken,
  refreshTokens,
  startDeviceFlow,
  type DeviceAuthorization,
  type DeviceFlowEndpoints,
  type StoredOAuth,
} from '../providers/oauth';

/** Pruebas del flujo OAuth device (sin red): fetch, sleep y now son falsos. */

interface Call {
  url: string;
  init: RequestInit;
}
type Reply = { status?: number; body: unknown } | Error;

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = replies.shift();
    if (!r) throw new Error('sin respuestas');
    if (r instanceof Error) throw r;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

function clock() {
  let t = 1_000_000;
  const delays: number[] = [];
  return {
    delays,
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new OAuthError('aborted', 'x');
      delays.push(ms);
      t += ms;
    },
  };
}

const ep: DeviceFlowEndpoints = {
  deviceCodeUrl: 'https://h.test/device',
  tokenUrl: 'https://h.test/token',
  scope: 'api',
};
const DEVICE = 'dev-secret-123';
const TOKEN = 'tok-secret-456';
const auth: DeviceAuthorization = {
  deviceCode: DEVICE,
  userCode: 'ABCD-1234',
  verificationUri: 'https://h.test/verify',
  expiresIn: 900,
  interval: 5,
};
const pending = { body: { error: 'authorization_pending' } };

async function rejects(p: Promise<unknown>): Promise<OAuthError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof OAuthError, `se esperaba OAuthError, llegó ${String(e)}`);
    return e;
  }
  throw new assert.AssertionError({ message: 'debía rechazar' });
}

describe('deviceFlowEndpoints', () => {
  it('github.com', () => {
    assert.deepEqual(deviceFlowEndpoints('github', 'https://api.github.com'), {
      deviceCodeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scope: 'repo read:user',
    });
  });
  it('GitHub Enterprise usa el origen de apiBase', () => {
    const e = deviceFlowEndpoints('github', 'https://ghe.corp.test/api/v3');
    assert.equal(e.deviceCodeUrl, 'https://ghe.corp.test/login/device/code');
    assert.equal(e.tokenUrl, 'https://ghe.corp.test/login/oauth/access_token');
  });
  it('gitlab.com y autoalojado', () => {
    assert.deepEqual(deviceFlowEndpoints('gitlab', 'https://gitlab.com/api/v4'), {
      deviceCodeUrl: 'https://gitlab.com/oauth/authorize_device',
      tokenUrl: 'https://gitlab.com/oauth/token',
      scope: 'api',
    });
    const s = deviceFlowEndpoints('gitlab', 'https://git.corp.test:8443/api/v4');
    assert.equal(s.tokenUrl, 'https://git.corp.test:8443/oauth/token');
  });
  it('proveedor no soportado', () => {
    assert.throws(
      () => deviceFlowEndpoints('gitea', 'https://gitea.test/api/v1'),
      (e: unknown) =>
        e instanceof OAuthError && e.code === 'unsupported' && /GitHub y GitLab/.test(e.message),
    );
  });
});

describe('startDeviceFlow', () => {
  it('envía la petición correcta y mapea la respuesta', async () => {
    const f = fakeFetch([
      {
        body: {
          device_code: DEVICE,
          user_code: 'ABCD-1234',
          verification_uri: 'https://h.test/verify',
          verification_uri_complete: 'https://h.test/verify?c=ABCD-1234',
          expires_in: 600,
          interval: 7,
        },
      },
    ]);
    const a = await startDeviceFlow(ep, 'cid', { fetch: f.fn });
    assert.deepEqual(a, {
      deviceCode: DEVICE,
      userCode: 'ABCD-1234',
      verificationUri: 'https://h.test/verify',
      verificationUriComplete: 'https://h.test/verify?c=ABCD-1234',
      expiresIn: 600,
      interval: 7,
    });
    const c = f.calls[0];
    assert.equal(c.url, 'https://h.test/device');
    assert.equal(c.init.method, 'POST');
    const h = c.init.headers as Record<string, string>;
    assert.equal(h['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(h['Accept'], 'application/json');
    assert.equal(h['User-Agent'], 'Gitora');
    assert.equal(c.init.body, 'client_id=cid&scope=api');
  });
  it('usa intervalo 5 por defecto', async () => {
    const f = fakeFetch([
      {
        body: {
          device_code: 'd',
          user_code: 'u',
          verification_uri: 'https://h.test/v',
          expires_in: 60,
        },
      },
    ]);
    assert.equal((await startDeviceFlow(ep, 'cid', { fetch: f.fn })).interval, 5);
  });
  it('error estilo GitLab (400) y respuestas inválidas', async () => {
    const e1 = await rejects(
      startDeviceFlow(ep, 'cid', {
        fetch: fakeFetch([
          { status: 400, body: { error: 'invalid_client', error_description: 'x' } },
        ]).fn,
      }),
    );
    assert.equal(e1.code, 'invalid_client');
    assert.match(e1.message, /Client ID/);
    const e2 = await rejects(
      startDeviceFlow(ep, 'cid', { fetch: fakeFetch([{ body: 'no es json' }]).fn }),
    );
    assert.equal(e2.code, 'invalid_response');
    const e3 = await rejects(
      startDeviceFlow(ep, 'cid', { fetch: fakeFetch([{ body: { user_code: 'u' } }]).fn }),
    );
    assert.equal(e3.code, 'invalid_response');
  });
  it('fallo de red -> http', async () => {
    const e = await rejects(
      startDeviceFlow(ep, 'cid', { fetch: fakeFetch([new Error('ECONNREFUSED')]).fn }),
    );
    assert.equal(e.code, 'http');
    assert.match(e.message, /ECONNREFUSED/);
  });
});

describe('pollForToken', () => {
  it('éxito tras dos authorization_pending, con petición correcta y expires_in', async () => {
    const f = fakeFetch([
      pending,
      pending,
      { body: { access_token: TOKEN, refresh_token: 'r1', expires_in: 7200, scope: 'api' } },
    ]);
    const c = clock();
    const t = await pollForToken(ep, 'cid', auth, { fetch: f.fn, sleep: c.sleep, now: c.now });
    assert.equal(t.accessToken, TOKEN);
    assert.equal(t.refreshToken, 'r1');
    assert.equal(t.scope, 'api');
    assert.equal(t.expiresAt, c.now() + 7_200_000);
    assert.deepEqual(c.delays, [5000, 5000, 5000]);
    assert.equal(f.calls.length, 3);
    const body = new URLSearchParams(String(f.calls[0].init.body));
    assert.equal(body.get('client_id'), 'cid');
    assert.equal(body.get('device_code'), DEVICE);
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(f.calls[0].url, 'https://h.test/token');
  });
  it('token sin expires_in ni refresh_token no vence', async () => {
    const f = fakeFetch([{ body: { access_token: TOKEN } }]);
    const c = clock();
    const t = await pollForToken(ep, 'cid', auth, { fetch: f.fn, sleep: c.sleep, now: c.now });
    assert.equal(t.expiresAt, undefined);
    assert.equal(t.refreshToken, undefined);
  });
  it('slow_down suma 5 s de forma permanente', async () => {
    const f = fakeFetch([
      pending,
      { body: { error: 'slow_down' } },
      pending,
      { body: { access_token: TOKEN } },
    ]);
    const c = clock();
    await pollForToken(ep, 'cid', auth, { fetch: f.fn, sleep: c.sleep, now: c.now });
    assert.deepEqual(c.delays, [5000, 5000, 10000, 10000]);
  });
  it('access_denied (GitHub 200 con error)', async () => {
    const f = fakeFetch([{ body: { error: 'access_denied' } }]);
    const c = clock();
    const e = await rejects(
      pollForToken(ep, 'cid', auth, { fetch: f.fn, sleep: c.sleep, now: c.now }),
    );
    assert.equal(e.code, 'access_denied');
    assert.match(e.message, /Rechazaste/);
  });
  it('expired_token del servidor (GitLab 400)', async () => {
    const f = fakeFetch([
      { status: 400, body: { error: 'expired_token', error_description: 'x' } },
    ]);
    const c = clock();
    const e = await rejects(
      pollForToken(ep, 'cid', auth, { fetch: f.fn, sleep: c.sleep, now: c.now }),
    );
    assert.equal(e.code, 'expired_token');
    assert.match(e.message, /venció/);
  });
  it('invalid_client y otros errores con su descripción', async () => {
    const c = clock();
    const e1 = await rejects(
      pollForToken(ep, 'cid', auth, {
        fetch: fakeFetch([{ body: { error: 'unauthorized_client' } }]).fn,
        sleep: c.sleep,
        now: c.now,
      }),
    );
    assert.equal(e1.code, 'unauthorized_client');
    assert.match(e1.message, /Client ID/);
    const e2 = await rejects(
      pollForToken(ep, 'cid', auth, {
        fetch: fakeFetch([{ body: { error: 'weird', error_description: 'detalle' } }]).fn,
        sleep: c.sleep,
        now: c.now,
      }),
    );
    assert.equal(e2.code, 'weird');
    assert.equal(e2.message, 'detalle');
  });
  it('vence localmente según expiresIn aunque el servidor siga pendiente', async () => {
    const f = fakeFetch(Array.from({ length: 10 }, () => pending));
    const c = clock();
    const short = { ...auth, expiresIn: 12 };
    const e = await rejects(
      pollForToken(ep, 'cid', short, { fetch: f.fn, sleep: c.sleep, now: c.now }),
    );
    assert.equal(e.code, 'expired_token');
    assert.ok(f.calls.length < 10);
  });
  it('aborta antes de empezar', async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fakeFetch([]);
    const c = clock();
    const e = await rejects(
      pollForToken(ep, 'cid', auth, { fetch: f.fn, sleep: c.sleep, now: c.now, signal: ac.signal }),
    );
    assert.equal(e.code, 'aborted');
    assert.equal(f.calls.length, 0);
  });
  it('aborta mientras duerme (sleep real)', async () => {
    const ac = new AbortController();
    const f = fakeFetch([]);
    const p = pollForToken(ep, 'cid', auth, { fetch: f.fn, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const e = await rejects(p);
    assert.equal(e.code, 'aborted');
    assert.equal(f.calls.length, 0);
  });
  it('aborta durante la petición', async () => {
    const ac = new AbortController();
    const c = clock();
    const hanging = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('abortado')));
        setTimeout(() => ac.abort(), 5);
      })) as unknown as typeof fetch;
    const e = await rejects(
      pollForToken(ep, 'cid', auth, {
        fetch: hanging,
        sleep: c.sleep,
        now: c.now,
        signal: ac.signal,
      }),
    );
    assert.equal(e.code, 'aborted');
  });
  it('respuesta sin token ni error -> invalid_response; red caída -> http', async () => {
    const c = clock();
    const e1 = await rejects(
      pollForToken(ep, 'cid', auth, {
        fetch: fakeFetch([{ body: { foo: 1 } }]).fn,
        sleep: c.sleep,
        now: c.now,
      }),
    );
    assert.equal(e1.code, 'invalid_response');
    const e2 = await rejects(
      pollForToken(ep, 'cid', auth, {
        fetch: fakeFetch([new Error('boom')]).fn,
        sleep: c.sleep,
        now: c.now,
      }),
    );
    assert.equal(e2.code, 'http');
  });
  it('ningún mensaje de error contiene el código de dispositivo ni el token', async () => {
    const c = clock();
    const cases: Reply[] = [
      { body: { error: 'access_denied' } },
      { body: { error: 'expired_token' } },
      { body: { error: 'invalid_client' } },
      { body: { foo: DEVICE } },
      { body: `no json ${DEVICE}` },
    ];
    for (const r of cases) {
      const e = await rejects(
        pollForToken(ep, 'cid', auth, { fetch: fakeFetch([r]).fn, sleep: c.sleep, now: c.now }),
      );
      assert.ok(!e.message.includes(DEVICE) && !e.message.includes(TOKEN), e.message);
    }
    const f = fakeFetch(Array.from({ length: 5 }, () => pending));
    const e = await rejects(
      pollForToken(
        ep,
        'cid',
        { ...auth, expiresIn: 6 },
        { fetch: f.fn, sleep: c.sleep, now: c.now },
      ),
    );
    assert.ok(!e.message.includes(DEVICE));
  });
});

describe('refreshTokens', () => {
  it('camino feliz', async () => {
    const f = fakeFetch([{ body: { access_token: TOKEN, refresh_token: 'r2', expires_in: 3600 } }]);
    const c = clock();
    const t = await refreshTokens(ep, 'cid', 'r1', { fetch: f.fn, now: c.now });
    assert.equal(t.accessToken, TOKEN);
    assert.equal(t.refreshToken, 'r2');
    assert.equal(t.expiresAt, c.now() + 3_600_000);
    const body = new URLSearchParams(String(f.calls[0].init.body));
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'r1');
    assert.equal(body.get('client_id'), 'cid');
    assert.equal(f.calls[0].url, 'https://h.test/token');
  });
  it('fallo invalid_grant sin filtrar el refresh token', async () => {
    const f = fakeFetch([
      { status: 400, body: { error: 'invalid_grant', error_description: 'revocado' } },
    ]);
    const e = await rejects(refreshTokens(ep, 'cid', 'refresh-secret', { fetch: f.fn }));
    assert.equal(e.code, 'invalid_grant');
    assert.ok(!e.message.includes('refresh-secret'));
  });
});

describe('secreto OAuth almacenado', () => {
  const s: StoredOAuth = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 5_000_000,
    clientId: 'cid',
    provider: 'gitlab',
    apiBase: 'https://gitlab.com/api/v4',
  };
  it('ida y vuelta', () => {
    assert.deepEqual(decodeOAuthSecret(encodeOAuthSecret(s)), s);
    const min: StoredOAuth = {
      accessToken: 'a',
      clientId: 'c',
      provider: 'github',
      apiBase: 'https://api.github.com',
    };
    assert.deepEqual(decodeOAuthSecret(encodeOAuthSecret(min)), min);
  });
  it('cadena simple, JSON malformado o de otra forma -> null', () => {
    assert.equal(decodeOAuthSecret('ghp_plaintoken123'), null);
    assert.equal(decodeOAuthSecret('{"accessToken":'), null);
    assert.equal(decodeOAuthSecret('"texto"'), null);
    assert.equal(decodeOAuthSecret('[]'), null);
    assert.equal(decodeOAuthSecret('{"accessToken":"a"}'), null);
    assert.equal(decodeOAuthSecret(JSON.stringify({ ...s, provider: 'otro' })), null);
    assert.equal(decodeOAuthSecret(JSON.stringify({ ...s, expiresAt: 'x' })), null);
  });
  it('needsRefresh', () => {
    const now = 1_000_000;
    assert.equal(needsRefresh({ ...s, expiresAt: undefined }, now), false);
    assert.equal(needsRefresh({ ...s, expiresAt: now + 3_600_000 }, now), false);
    assert.equal(needsRefresh({ ...s, expiresAt: now + 30_000 }, now), true);
    assert.equal(needsRefresh({ ...s, expiresAt: now - 1 }, now), true);
    assert.equal(
      needsRefresh({ ...s, expiresAt: now + 30_000, refreshToken: undefined }, now),
      false,
    );
    assert.equal(needsRefresh({ ...s, expiresAt: now + 30_000 }, now, 10_000), false);
  });
});
