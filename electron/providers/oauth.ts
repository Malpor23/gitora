import type { ProviderKind } from '@core/models';

/** Cliente OAuth 2.0 Device Authorization Grant (RFC 8628) para el proceso principal. */

export interface DeviceFlowEndpoints {
  deviceCodeUrl: string;
  tokenUrl: string;
  scope: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; ausente cuando el token no vence */
  expiresAt?: number;
  scope?: string;
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface FlowDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** Secreto guardado (cifrado por quien llama) para una cuenta OAuth. */
export interface StoredOAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  provider: ProviderKind;
  apiBase: string;
}

const GRANT_DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;

export function deviceFlowEndpoints(provider: ProviderKind, apiBase: string): DeviceFlowEndpoints {
  if (provider !== 'github' && provider !== 'gitlab') {
    throw new OAuthError(
      'unsupported',
      'El inicio de sesión desde el navegador solo está disponible para GitHub y GitLab',
    );
  }
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new OAuthError('unsupported', 'La URL de la API del proveedor no es válida');
  }
  if (provider === 'github') {
    const origin = url.hostname === 'api.github.com' ? 'https://github.com' : url.origin;
    return {
      deviceCodeUrl: `${origin}/login/device/code`,
      tokenUrl: `${origin}/login/oauth/access_token`,
      scope: 'repo read:user',
    };
  }
  return {
    deviceCodeUrl: `${url.origin}/oauth/authorize_device`,
    tokenUrl: `${url.origin}/oauth/token`,
    scope: 'api',
  };
}

const abortedError = () => new OAuthError('aborted', 'El inicio de sesión fue cancelado');

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type Json = Record<string, unknown>;

async function postForm(
  url: string,
  form: Record<string, string>,
  deps: FlowDeps,
  signal?: AbortSignal,
): Promise<Json> {
  const doFetch = deps.fetch ?? fetch;
  let text: string;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'Gitora',
      },
      body: new URLSearchParams(form).toString(),
      signal,
    });
    text = await res.text();
  } catch (e) {
    if (signal?.aborted) throw abortedError();
    const msg = e instanceof Error ? e.message : String(e);
    throw new OAuthError('http', `No se pudo contactar al proveedor: ${msg}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OAuthError('invalid_response', 'El proveedor devolvió una respuesta que no es JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OAuthError('invalid_response', 'El proveedor devolvió una respuesta inesperada');
  }
  return parsed as Json;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Convierte un campo `error` del servidor en OAuthError (sin datos secretos). */
function serverError(body: Json): OAuthError | null {
  const code = str(body['error']);
  if (!code) return null;
  const desc = str(body['error_description']);
  switch (code) {
    case 'expired_token':
      return new OAuthError(code, 'El código venció: vuelve a iniciar el inicio de sesión');
    case 'access_denied':
      return new OAuthError(code, 'Rechazaste la autorización');
    case 'invalid_client':
    case 'unauthorized_client':
      return new OAuthError(code, 'El proveedor no reconoce la aplicación: revisa el Client ID');
    default:
      return new OAuthError(code, desc ?? `El proveedor respondió con el error ${code}`);
  }
}

export async function startDeviceFlow(
  ep: DeviceFlowEndpoints,
  clientId: string,
  deps: FlowDeps = {},
): Promise<DeviceAuthorization> {
  const body = await postForm(ep.deviceCodeUrl, { client_id: clientId, scope: ep.scope }, deps);
  const err = serverError(body);
  if (err) throw err;
  const deviceCode = str(body['device_code']);
  const userCode = str(body['user_code']);
  const verificationUri = str(body['verification_uri']);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new OAuthError('invalid_response', 'La respuesta del proveedor está incompleta');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: str(body['verification_uri_complete']),
    expiresIn: num(body['expires_in']) ?? 900,
    interval: num(body['interval']) ?? DEFAULT_INTERVAL_S,
  };
}

function toTokens(body: Json, now: number): OAuthTokens {
  const accessToken = str(body['access_token']);
  if (!accessToken) {
    throw new OAuthError('invalid_response', 'La respuesta del proveedor no incluye un token');
  }
  const expiresIn = num(body['expires_in']);
  return {
    accessToken,
    refreshToken: str(body['refresh_token']),
    expiresAt: expiresIn !== undefined ? now + expiresIn * 1000 : undefined,
    scope: str(body['scope']),
  };
}

export async function pollForToken(
  ep: DeviceFlowEndpoints,
  clientId: string,
  auth: DeviceAuthorization,
  opts: { signal?: AbortSignal } & FlowDeps = {},
): Promise<OAuthTokens> {
  const { signal } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const start = now();
  let interval = auth.interval > 0 ? auth.interval : DEFAULT_INTERVAL_S;

  for (;;) {
    if (signal?.aborted) throw abortedError();
    try {
      await sleep(interval * 1000, signal);
    } catch (e) {
      if (e instanceof OAuthError) throw e;
      throw abortedError();
    }
    if (signal?.aborted) throw abortedError();
    if (now() - start >= auth.expiresIn * 1000) {
      throw new OAuthError(
        'expired_token',
        'El código venció: vuelve a iniciar el inicio de sesión',
      );
    }
    const body = await postForm(
      ep.tokenUrl,
      { client_id: clientId, device_code: auth.deviceCode, grant_type: GRANT_DEVICE },
      opts,
      signal,
    );
    const code = str(body['error']);
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      interval += SLOW_DOWN_S;
      continue;
    }
    const err = serverError(body);
    if (err) throw err;
    return toTokens(body, now());
  }
}

export async function refreshTokens(
  ep: DeviceFlowEndpoints,
  clientId: string,
  refreshToken: string,
  deps: FlowDeps = {},
): Promise<OAuthTokens> {
  const body = await postForm(
    ep.tokenUrl,
    { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken },
    deps,
  );
  const err = serverError(body);
  if (err) throw err;
  return toTokens(body, (deps.now ?? Date.now)());
}

export function encodeOAuthSecret(s: StoredOAuth): string {
  return JSON.stringify(s);
}

export function decodeOAuthSecret(raw: string): StoredOAuth | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Json;
  if (
    typeof o['accessToken'] !== 'string' ||
    typeof o['clientId'] !== 'string' ||
    typeof o['apiBase'] !== 'string' ||
    (o['provider'] !== 'github' &&
      o['provider'] !== 'gitlab' &&
      o['provider'] !== 'bitbucket' &&
      o['provider'] !== 'gitea')
  ) {
    return null;
  }
  if (o['refreshToken'] !== undefined && typeof o['refreshToken'] !== 'string') return null;
  if (o['expiresAt'] !== undefined && typeof o['expiresAt'] !== 'number') return null;
  const out: StoredOAuth = {
    accessToken: o['accessToken'],
    clientId: o['clientId'],
    provider: o['provider'],
    apiBase: o['apiBase'],
  };
  if (typeof o['refreshToken'] === 'string') out.refreshToken = o['refreshToken'];
  if (typeof o['expiresAt'] === 'number') out.expiresAt = o['expiresAt'];
  return out;
}

export function needsRefresh(s: StoredOAuth, now: number, skewMs = 60_000): boolean {
  return s.expiresAt !== undefined && !!s.refreshToken && s.expiresAt - now < skewMs;
}
