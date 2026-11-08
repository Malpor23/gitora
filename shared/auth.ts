import type { AuthMethod, ProviderKind } from '@core/models';

/**
 * Métodos de autenticación que ofrece cada proveedor (una sola tabla para el backend y la UI).
 *
 * - token: token de acceso personal (PAT); en Bitbucket es la "app password".
 * - password: usuario y contraseña (HTTPS). GitHub no la acepta desde 2021 y Bitbucket ya cubre
 *   su contraseña de aplicación con "token", por eso no se ofrece en ellos.
 * - oauth: device flow (RFC 8628). Solo GitHub y GitLab lo tienen.
 * - ssh: clave privada por cuenta para los remotos SSH.
 */
export const PROVIDER_AUTH_METHODS: Record<ProviderKind, readonly AuthMethod[]> = {
  github: ['token', 'oauth', 'ssh'],
  gitlab: ['token', 'password', 'oauth', 'ssh'],
  bitbucket: ['token', 'ssh'],
  gitea: ['token', 'password', 'ssh'],
};

export function supportsAuthMethod(provider: ProviderKind, method: AuthMethod): boolean {
  return PROVIDER_AUTH_METHODS[provider].includes(method);
}

/** Los métodos HTTPS envían una cabecera Authorization; 'ssh' usa una clave en los remotos SSH. */
export type Transport = 'https' | 'ssh';

export function transportOf(method: AuthMethod): Transport {
  return method === 'ssh' ? 'ssh' : 'https';
}

/** Cuentas antiguas (guardadas antes de existir `authMethod`) se tratan como token. */
export function methodOf(account: { authMethod?: AuthMethod }): AuthMethod {
  return account.authMethod ?? 'token';
}
