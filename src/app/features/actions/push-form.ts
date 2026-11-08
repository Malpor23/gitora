import type { Branch, Remote } from '@core/models';

type LocalBranch = Pick<Branch, 'name' | 'upstream'>;

/** Upstream de una rama local por nombre (`origin/main`) o null si no tiene. */
export function upstreamOf(branches: LocalBranch[], name: string): string | null {
  return branches.find((b) => b.name === name)?.upstream ?? null;
}

/**
 * Remoto por defecto del Push: el del upstream de la rama si existe; si no, `origin`; si no, el
 * primero. (Distinto del Pull, que prefiere siempre `origin`: aquí empujar a otro remoto sin
 * querer es más costoso.)
 */
export function defaultPushRemote(
  remotes: Pick<Remote, 'name'>[],
  upstream: string | null,
): string {
  const names = remotes.map((r) => r.name);
  const fromUpstream = upstream?.split('/')[0];
  if (fromUpstream && names.includes(fromUpstream)) return fromUpstream;
  if (names.includes('origin')) return 'origin';
  return names[0] ?? '';
}

/**
 * Rama remota destino ("To"): si la rama tiene upstream en el remoto elegido se usa ese nombre;
 * en cualquier otro caso, el mismo nombre que la rama local (git la crea si no existe).
 */
export function defaultPushTarget(branch: string, upstream: string | null, remote: string): string {
  return upstream?.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : branch;
}

/** Solo conviene fijar el upstream cuando la rama aún no tiene uno. */
export function shouldSetUpstream(upstream: string | null): boolean {
  return !upstream;
}

export type ForceMode = 'none' | 'with-lease' | 'force';

/** Clave i18n del mensaje de confirmación de un force push, o null si no hace falta confirmar. */
export function forcePushConfirmKey(force: unknown): string | null {
  if (force === 'force') return 'dialogs.push.confirmForce';
  if (force === 'with-lease') return 'dialogs.push.confirmForceLease';
  return null;
}
