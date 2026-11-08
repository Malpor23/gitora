import type { AuthMethod, NewAccountInput, ProviderKind } from '@core/models';

import { PROVIDER_AUTH_METHODS } from '../../../../../shared/auth';

/** Estado del formulario de nueva cuenta. */
export interface AccountFormState {
  provider: ProviderKind;
  method: AuthMethod;
  server: string;
  username: string;
  /** Token o contraseña, según el método. */
  secret: string;
  keyPath: string;
  clientId: string;
}

/** Qué campos muestra un método y cuáles son obligatorios. */
export interface MethodFields {
  server: boolean;
  username: boolean;
  usernameRequired: boolean;
  secret: boolean;
  keyPath: boolean;
  clientId: boolean;
}

const DEFAULT_HOSTS: Partial<Record<ProviderKind, string>> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
  gitea: 'codeberg.org',
};

export function defaultMethod(provider: ProviderKind): AuthMethod {
  return PROVIDER_AUTH_METHODS[provider][0];
}

export function fieldsFor(provider: ProviderKind, method: AuthMethod): MethodFields {
  const hasServer = provider !== 'bitbucket';
  switch (method) {
    case 'token':
      return {
        server: hasServer,
        username: provider === 'bitbucket',
        usernameRequired: provider === 'bitbucket',
        secret: true,
        keyPath: false,
        clientId: false,
      };
    case 'password':
      return {
        server: hasServer,
        username: true,
        usernameRequired: true,
        secret: true,
        keyPath: false,
        clientId: false,
      };
    case 'ssh':
      return {
        server: hasServer,
        username: true,
        usernameRequired: true,
        secret: false,
        keyPath: true,
        clientId: false,
      };
    case 'oauth':
      return {
        server: hasServer,
        username: false,
        usernameRequired: false,
        secret: false,
        keyPath: false,
        clientId: true,
      };
  }
}

export function canSubmit(state: AccountFormState): boolean {
  const f = fieldsFor(state.provider, state.method);
  if (f.usernameRequired && !state.username.trim()) return false;
  if (f.secret && !state.secret.trim()) return false;
  if (f.keyPath && !state.keyPath.trim()) return false;
  if (f.clientId && !state.clientId.trim()) return false;
  return true;
}

function opt(value: string): string | undefined {
  return value.trim() || undefined;
}

/** Formulario -> entrada de `addAccount` (no sirve para OAuth). */
export function toNewAccountInput(state: AccountFormState): NewAccountInput {
  const f = fieldsFor(state.provider, state.method);
  const method = state.method === 'oauth' ? 'token' : state.method;
  const input: NewAccountInput = { provider: state.provider, authMethod: method };
  const baseUrl = f.server ? opt(state.server) : undefined;
  const username = f.username ? opt(state.username) : undefined;
  const token = f.secret ? opt(state.secret) : undefined;
  const sshKeyPath = f.keyPath ? opt(state.keyPath) : undefined;
  if (baseUrl) input.baseUrl = baseUrl;
  if (username) input.username = username;
  if (token) input.token = token;
  if (sshKeyPath) input.sshKeyPath = sshKeyPath;
  return input;
}

/** Clave de `oauthClientIds`: hostname en minúsculas del servidor, o el host por defecto. */
export function hostKey(provider: ProviderKind, baseUrl: string): string {
  const raw = baseUrl.trim();
  if (raw) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.hostname) return url.hostname.toLowerCase();
    } catch {
      // Se usa el valor tal cual, sin esquema ni ruta.
    }
    return raw
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[/:?#]/)[0]
      .toLowerCase();
  }
  return DEFAULT_HOSTS[provider] ?? '';
}

/** Segundos -> `mm:ss` (nunca negativo). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
