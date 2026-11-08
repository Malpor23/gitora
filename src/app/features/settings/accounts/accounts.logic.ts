import type { Account, AccountStatus, AuthMethod, NewAccountInput, ProviderKind } from '@core/models';

import { methodOf, PROVIDER_AUTH_METHODS } from '../../../../../shared/auth';

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
  /** El servidor es obligatorio (GitHub Enterprise, GitLab propio). */
  serverRequired?: boolean;
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

/**
 * Formulario precargado para editar una cuenta existente. El secreto nunca llega al renderer, así que
 * queda vacío: hay que escribir el nuevo. El servidor se deja vacío cuando es el de por defecto.
 */
export function formFromAccount(a: Account): AccountFormState {
  return {
    provider: a.provider,
    method: methodOf(a),
    server: a.host.toLowerCase() === DEFAULT_HOSTS[a.provider] ? '' : a.host,
    username: a.username,
    secret: '',
    keyPath: a.sshKeyPath ?? '',
    clientId: '',
  };
}

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
  if (f.server && state.serverRequired && !state.server.trim()) return false;
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

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  gitea: 'Gitea / Forgejo',
};

/** Una casilla del selector de plataforma del diálogo «Agregar cuenta». */
export interface ProviderTile {
  id: 'bitbucket' | 'gitea' | 'github' | 'github-enterprise' | 'gitlab' | 'gitlab-self';
  provider: ProviderKind;
  /** Enterprise y autoalojado son el mismo proveedor, pero exigen indicar el servidor. */
  serverRequired: boolean;
}

export const PROVIDER_TILES: readonly ProviderTile[] = [
  { id: 'bitbucket', provider: 'bitbucket', serverRequired: false },
  { id: 'gitea', provider: 'gitea', serverRequired: false },
  { id: 'github', provider: 'github', serverRequired: false },
  { id: 'github-enterprise', provider: 'github', serverRequired: true },
  { id: 'gitlab', provider: 'gitlab', serverRequired: false },
  { id: 'gitlab-self', provider: 'gitlab', serverRequired: true },
];

/** Estado visual de una cuenta: tono del indicador y clave i18n del texto. */
export type StatusTone = 'success' | 'danger' | 'warning' | 'muted' | 'busy';

export function statusView(status: AccountStatus | 'checking'): { tone: StatusTone; key: string } {
  switch (status) {
    case 'online':
      return { tone: 'success', key: 'accounts.status.online' };
    case 'offline':
      return { tone: 'danger', key: 'accounts.status.offline' };
    case 'invalid':
      return { tone: 'warning', key: 'accounts.status.invalid' };
    case 'unverifiable':
      return { tone: 'muted', key: 'accounts.status.unverifiable' };
    case 'checking':
      return { tone: 'busy', key: 'accounts.status.checking' };
  }
}

/** Clave i18n del botón que cambia la credencial, según el método de la cuenta. */
export function updateLabelKey(method: AuthMethod): string {
  return `accounts.update.${method}`;
}

/** Enlace al servidor de la cuenta. */
export function serverUrl(a: Pick<Account, 'host'>): string {
  return `https://${a.host}`;
}

/** Id de la cuenta que queda seleccionada al quitar la de `removedIndex` (la vecina; null si no queda ninguna). */
export function selectionAfterRemoval(ids: readonly string[], removedIndex: number): string | null {
  const rest = ids.filter((_, i) => i !== removedIndex);
  return rest[Math.min(removedIndex, rest.length - 1)] ?? null;
}

/** Posición a la que lleva una tecla de navegación en una lista de `count` elementos (null = otra tecla). */
export function navigateIndex(key: string, current: number, count: number): number | null {
  if (!count) return null;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'ArrowUp':
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
