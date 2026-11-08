import { randomUUID } from 'node:crypto';
import type {
  Account, NewAccountInput, NewPullRequest, OAuthDeviceCode, OAuthStartInput, ProviderKind, PullRequest,
  RemoteLocator, RemoteRepository,
} from '@core/models';
import { methodOf, supportsAuthMethod, transportOf, type Transport } from '../../shared/auth';
import { SettingsStore } from '../settings-store';
import { BitbucketProvider } from './bitbucket.provider';
import { GiteaProvider } from './gitea.provider';
import { GitHubProvider } from './github.provider';
import { GitLabProvider } from './gitlab.provider';
import {
  decodeOAuthSecret, deviceFlowEndpoints, encodeOAuthSecret, needsRefresh, OAuthError, pollForToken,
  refreshTokens, startDeviceFlow, type DeviceAuthorization, type DeviceFlowEndpoints,
} from './oauth';
import { GitProvider, guessProvider, parseRemoteUrl, Profile, ProviderContext } from './provider';
import { isSshUrl, sshCommandFor, validateSshKeyPath } from './ssh-key';

/** Una sesión de inicio de sesión OAuth en curso; el `device_code` nunca sale de aquí. */
interface OAuthSession {
  provider: ProviderKind;
  apiBase: string;
  clientId: string;
  endpoints: DeviceFlowEndpoints;
  auth: DeviceAuthorization;
  controller: AbortController;
}

const PROVIDER_NAMES: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  gitea: 'Gitea',
};

export class ProviderRegistry {
  private readonly providers: Record<ProviderKind, GitProvider> = {
    github: new GitHubProvider(),
    gitlab: new GitLabProvider(),
    bitbucket: new BitbucketProvider(),
    gitea: new GiteaProvider(),
  };
  private readonly oauthSessions = new Map<string, OAuthSession>();
  /** Renovaciones de token en curso, para no pedir dos veces el mismo refresh. */
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(private readonly store: SettingsStore) {}

  get(kind: ProviderKind): GitProvider {
    return this.providers[kind];
  }

  /* ───────────── alta de cuentas ───────────── */

  async addAccount(input: NewAccountInput): Promise<Account> {
    const method = input.authMethod ?? 'token';
    if (!supportsAuthMethod(input.provider, method)) {
      throw new Error(`${PROVIDER_NAMES[input.provider]} no admite el método de autenticación "${method}"`);
    }
    const provider = this.get(input.provider);
    const baseUrl = normalizeApi(input.provider, input.baseUrl || provider.defaultApi);
    const username = input.username?.trim() ?? '';
    let profile: Profile;
    let secret: string | null;
    let apiAccess = true;
    let sshKeyPath: string | undefined;

    if (method === 'ssh') {
      if (!username) throw new Error('Indica un nombre de usuario para identificar la cuenta');
      sshKeyPath = await validateSshKeyPath(input.sshKeyPath ?? '');
      profile = { username };
      secret = null;
      apiAccess = false;
    } else if (method === 'password') {
      const password = input.token ?? '';
      if (!username) throw new Error('Indica el nombre de usuario');
      if (!password) throw new Error('Indica la contraseña');
      secret = password;
      if (provider.profileWithPassword) {
        profile = await provider.profileWithPassword(baseUrl, username, password);
      } else {
        // La API de este proveedor no acepta contraseñas: sirve para git por HTTPS, pero no se puede validar.
        profile = { username };
        apiAccess = false;
      }
    } else {
      secret = (input.token ?? '').trim();
      if (!secret) throw new Error('Indica el token de acceso');
      profile = await provider.profile(baseUrl, secret, input.username);
    }

    return this.saveAccount(input.provider, baseUrl, method, profile, secret, apiAccess, sshKeyPath);
  }

  private saveAccount(
    kind: ProviderKind,
    baseUrl: string,
    authMethod: Account['authMethod'],
    profile: Profile,
    secret: string | null,
    apiAccess: boolean,
    sshKeyPath?: string,
  ): Account {
    const host = hostFromApi(kind, baseUrl);
    // Una misma cuenta (proveedor + servidor + usuario) puede tener varios métodos a la vez.
    const existing = this.store
      .get()
      .accounts.find(
        (a) => a.provider === kind && a.host === host && a.username === profile.username && methodOf(a) === authMethod,
      );
    const account: Account = {
      id: existing?.id ?? randomUUID(),
      provider: kind,
      baseUrl,
      host,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      hasToken: secret !== null,
      authMethod,
      sshKeyPath,
      apiAccess,
    };
    this.store.upsertAccount(account, secret);
    return account;
  }

  removeAccount(id: string) {
    this.store.removeAccount(id);
  }

  /* ───────────── OAuth (device flow) ───────────── */

  async oauthStart(input: OAuthStartInput): Promise<OAuthDeviceCode> {
    if (!supportsAuthMethod(input.provider, 'oauth')) {
      throw new OAuthError('unsupported', `${PROVIDER_NAMES[input.provider]} no admite inicio de sesión con OAuth`);
    }
    const clientId = input.clientId.trim();
    if (!clientId) throw new Error('Indica el Client ID de tu OAuth App');
    const apiBase = normalizeApi(input.provider, input.baseUrl || this.get(input.provider).defaultApi);
    const endpoints = deviceFlowEndpoints(input.provider, apiBase);
    const auth = await startDeviceFlow(endpoints, clientId);
    const sessionId = randomUUID();
    this.oauthSessions.set(sessionId, {
      provider: input.provider,
      apiBase,
      clientId,
      endpoints,
      auth,
      controller: new AbortController(),
    });
    return {
      sessionId,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      expiresIn: auth.expiresIn,
    };
  }

  /** Espera a que el usuario autorice en el navegador y crea la cuenta. */
  async oauthComplete(sessionId: string): Promise<Account> {
    const session = this.oauthSessions.get(sessionId);
    if (!session) throw new Error('La sesión de inicio de sesión ya no existe: vuelve a empezar');
    try {
      const tokens = await pollForToken(session.endpoints, session.clientId, session.auth, {
        signal: session.controller.signal,
      });
      const profile = await this.get(session.provider).profile(session.apiBase, tokens.accessToken);
      const secret = encodeOAuthSecret({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId: session.clientId,
        provider: session.provider,
        apiBase: session.apiBase,
      });
      return this.saveAccount(session.provider, session.apiBase, 'oauth', profile, secret, true);
    } finally {
      this.oauthSessions.delete(sessionId);
    }
  }

  oauthCancel(sessionId: string) {
    this.oauthSessions.get(sessionId)?.controller.abort();
    this.oauthSessions.delete(sessionId);
  }

  /* ───────────── credenciales ───────────── */

  /**
   * Token de acceso listo para usar. Las cuentas OAuth guardan un JSON con el token y, si vence,
   * se renueva con el refresh token (solo una renovación a la vez por cuenta).
   */
  private async accessToken(account: Account): Promise<string | null> {
    const raw = this.store.token(account.id);
    if (!raw) return null;
    if (methodOf(account) !== 'oauth') return raw;
    const stored = decodeOAuthSecret(raw);
    if (!stored) return null;
    if (!needsRefresh(stored, Date.now())) return stored.accessToken;

    let pending = this.refreshing.get(account.id);
    if (!pending) {
      pending = (async () => {
        try {
          const refreshed = await refreshTokens(
            deviceFlowEndpoints(stored.provider, stored.apiBase),
            stored.clientId,
            stored.refreshToken as string,
          );
          this.store.setSecret(
            account.id,
            encodeOAuthSecret({
              ...stored,
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken ?? stored.refreshToken,
              expiresAt: refreshed.expiresAt,
            }),
          );
          return refreshed.accessToken;
        } catch {
          return null; // refresh vencido o revocado: hay que iniciar sesión de nuevo
        } finally {
          this.refreshing.delete(account.id);
        }
      })();
      this.refreshing.set(account.id, pending);
    }
    return pending;
  }

  private async context(accountId: string): Promise<{ provider: GitProvider; ctx: ProviderContext }> {
    const account = this.store.account(accountId);
    if (!account) throw new Error('La cuenta ya no existe');
    if (!account.apiAccess) {
      throw new Error('Esta cuenta no tiene acceso a la API del proveedor (solo sirve para git)');
    }
    const token = await this.accessToken(account);
    if (!token) {
      throw new Error(
        methodOf(account) === 'oauth'
          ? 'La sesión OAuth venció o fue revocada: vuelve a iniciar sesión'
          : 'No se pudo leer el token de la cuenta (¿llavero del sistema bloqueado?)',
      );
    }
    return { provider: this.get(account.provider), ctx: { account, token } };
  }

  async listRepositories(accountId: string, query: string): Promise<RemoteRepository[]> {
    const { provider, ctx } = await this.context(accountId);
    return provider.listRepositories(ctx, query);
  }

  locate(url: string): RemoteLocator {
    const parsed = parseRemoteUrl(url);
    if (!parsed) return { provider: null, host: '', owner: '', repo: '' };
    const account = this.store.get().accounts.find((a) => a.host === parsed.host.toLowerCase());
    return { ...parsed, provider: account?.provider ?? guessProvider(parsed.host) };
  }

  /**
   * Cuenta para un servidor y un transporte: las de HTTPS (token, contraseña, OAuth) y las de SSH
   * (clave) conviven en el mismo servidor. Con varias del mismo transporte gana la primera.
   */
  accountForHost(host: string, transport: Transport): Account | undefined {
    const h = host.toLowerCase();
    return this.store.get().accounts.find((a) => a.host === h && transportOf(methodOf(a)) === transport);
  }

  /** Cuenta con acceso a la API para un servidor (las claves SSH no la tienen). */
  private apiAccountForHost(host: string): Account | undefined {
    const h = host.toLowerCase();
    return this.store.get().accounts.find((a) => a.host === h && a.apiAccess);
  }

  async pullRequests(remoteUrl: string): Promise<PullRequest[]> {
    const { provider, ctx, loc } = await this.forRemote(remoteUrl);
    return provider.pullRequests(ctx, loc.owner, loc.repo);
  }

  async createPullRequest(remoteUrl: string, pr: NewPullRequest): Promise<PullRequest> {
    const { provider, ctx, loc } = await this.forRemote(remoteUrl);
    return provider.createPullRequest(ctx, loc.owner, loc.repo, pr);
  }

  private async forRemote(remoteUrl: string) {
    const loc = this.locate(remoteUrl);
    const account = this.apiAccountForHost(loc.host);
    if (!account) {
      throw new Error(
        `No hay una cuenta con acceso a la API para ${loc.host || remoteUrl} (las claves SSH no la tienen)`,
      );
    }
    return { ...(await this.context(account.id)), loc };
  }

  /**
   * Configuración `-c` para autenticar a git contra un remoto:
   * - HTTPS: cabecera `Authorization: Basic` limitada a la URL del host (http.<url>.extraHeader), así
   *   nunca se envía a otro servidor. Sirve para token, contraseña y OAuth.
   * - SSH: `core.sshCommand` con la clave de la cuenta de ese servidor.
   */
  async authConfigFor(url: string): Promise<string[]> {
    if (isSshUrl(url)) {
      const host = parseRemoteUrl(url)?.host;
      const account = host ? this.accountForHost(host, 'ssh') : undefined;
      return account?.sshKeyPath ? [`core.sshCommand=${sshCommandFor(account.sshKeyPath)}`] : [];
    }
    if (!/^https?:\/\//i.test(url)) return [];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    const host = parsed.host.toLowerCase();
    const account = this.accountForHost(host.replace(/:\d+$/, ''), 'https');
    if (!account) return [];
    const secret = await this.accessToken(account);
    if (!secret) return [];
    const { user, password } =
      methodOf(account) === 'password'
        ? { user: account.username, password: secret }
        : this.get(account.provider).basicCredentials({ account, token: secret });
    const basic = Buffer.from(`${user}:${password}`).toString('base64');
    return [`http.${parsed.protocol}//${host}/.extraHeader=Authorization: Basic ${basic}`];
  }
}

/** Ruta de API ya presente en la URL (GitHub Enterprise, GitLab, Gitea, Bitbucket). */
const API_PATH = /\/(api\/v\d+|2\.0)(\/|$)/;

export function normalizeApi(kind: ProviderKind, url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(u)) u = 'https://' + u;
  const { pathname, origin, hostname } = new URL(u);
  // Servicios en la nube: la API siempre vive en un host fijo, sin importar qué ruta pegó el usuario
  // (p. ej. https://github.com/usuario daba 404 al pedir /user).
  if (kind === 'github' && hostname === 'github.com') return 'https://api.github.com';
  if (kind === 'bitbucket' && (hostname === 'bitbucket.org' || hostname === 'api.bitbucket.org')) {
    return 'https://api.bitbucket.org/2.0';
  }
  if (kind === 'gitlab' && hostname === 'gitlab.com') return 'https://gitlab.com/api/v4';
  if (API_PATH.test(pathname)) return u;
  // Autoalojados: se completa la ruta de la API detrás del prefijo que haya escrito el usuario.
  const base = pathname && pathname !== '/' ? u : origin;
  switch (kind) {
    case 'github': return `${base}/api/v3`;
    case 'gitlab': return `${base}/api/v4`;
    case 'bitbucket': return 'https://api.bitbucket.org/2.0';
    case 'gitea': return `${base}/api/v1`;
  }
}

function hostFromApi(kind: ProviderKind, api: string): string {
  const host = new URL(api).hostname.toLowerCase();
  if (kind === 'github' && host === 'api.github.com') return 'github.com';
  if (kind === 'bitbucket' && host === 'api.bitbucket.org') return 'bitbucket.org';
  return host;
}
