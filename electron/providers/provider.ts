import {
  Account, NewPullRequest, ProviderKind, PullRequest, RemoteLocator, RemoteRepository,
} from '@core/models';

export interface ProviderContext {
  account: Account;
  token: string;
}

export interface Profile {
  username: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Interfaz común: cada proveedor implementa lo mismo y la UI no sabe cuál es. */
export interface GitProvider {
  readonly kind: ProviderKind;
  readonly defaultApi: string;
  readonly defaultHost: string;
  profile(apiBase: string, token: string, username?: string): Promise<Profile>;
  /**
   * Valida usuario y contraseña contra la API (HTTP Basic). Solo lo implementan los proveedores
   * cuya API acepta contraseñas; en el resto la cuenta se crea sin validar y sin acceso a la API.
   */
  profileWithPassword?(apiBase: string, username: string, password: string): Promise<Profile>;
  listRepositories(ctx: ProviderContext, query: string): Promise<RemoteRepository[]>;
  pullRequests(ctx: ProviderContext, owner: string, repo: string): Promise<PullRequest[]>;
  createPullRequest(ctx: ProviderContext, owner: string, repo: string, pr: NewPullRequest): Promise<PullRequest>;
  /** Credencial para HTTPS: git la envía como cabecera Authorization: Basic. */
  basicCredentials(ctx: ProviderContext): { user: string; password: string };
}

export class ProviderHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function http<T>(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', 'User-Agent': 'Gitora', ...init.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: { message?: string } | string };
      detail = (typeof body.error === 'string' ? body.error : body.error?.message) ?? body.message ?? detail;
    } catch { /* cuerpo no JSON */ }
    if (res.status === 401) detail = `Token inválido o vencido (${detail})`;
    if (res.status === 404) detail = `${detail} — revisa la URL del servidor (${new URL(url).origin})`;
    throw new ProviderHttpError(res.status, `${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Interpreta URLs de remotos:
 *   https://github.com/owner/repo.git
 *   git@gitlab.com:grupo/subgrupo/repo.git
 *   ssh://git@gitea.local:2222/owner/repo.git
 */
export function parseRemoteUrl(url: string): Omit<RemoteLocator, 'provider'> | null {
  const trimmed = url.trim();
  let host = '';
  let pathPart = '';
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1];
    pathPart = scp[2];
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      pathPart = u.pathname;
    } catch {
      return null;
    }
  }
  const segments = pathPart.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/');
  if (segments.length < 2) return null;
  const repo = segments.pop()!;
  return { host: host.toLowerCase(), owner: segments.join('/'), repo };
}

export function guessProvider(host: string): ProviderKind | null {
  if (host === 'github.com' || host.endsWith('.ghe.com')) return 'github';
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  if (host.includes('gitea') || host.includes('codeberg') || host.includes('forgejo')) return 'gitea';
  return null;
}
