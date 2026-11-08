import type { Branch, PullOptions, Remote } from '@core/models';
import type { FieldOption, FormValues } from '@core/services';

/** Remoto por defecto del Pull: siempre `origin` si existe; si no, el del upstream o el primero. */
export function defaultPullRemote(
  remotes: Pick<Remote, 'name'>[],
  upstream: string | null,
): string {
  const names = remotes.map((r) => r.name);
  if (names.includes('origin')) return 'origin';
  const fromUpstream = upstream?.split('/')[0];
  if (fromUpstream && names.includes(fromUpstream)) return fromUpstream;
  return names[0] ?? '';
}

/** Ramas del remoto elegido (sin el prefijo `origin/` y sin `HEAD`), ordenadas por nombre. */
export function remoteBranchNames(
  branches: Pick<Branch, 'name' | 'remote'>[],
  remote: string,
): string[] {
  const prefix = `${remote}/`;
  return branches
    .filter((b) => b.remote === remote && b.name.startsWith(prefix))
    .map((b) => b.name.slice(prefix.length))
    .filter((n) => n !== 'HEAD')
    .sort((a, b) => a.localeCompare(b));
}

/** Opciones del selector de rama: la primera deja que git use la rama de seguimiento. */
export function pullBranchOptions(
  branches: Pick<Branch, 'name' | 'remote'>[],
  remote: string,
  trackingLabel: string,
): FieldOption[] {
  return [
    { value: '', label: trackingLabel },
    ...remoteBranchNames(branches, remote).map((n) => ({ value: n, label: n })),
  ];
}

/**
 * Rama remota preseleccionada: la del upstream si es del mismo remoto; si no, la que se llama
 * como la rama actual; si no existe, vacío (rama de seguimiento).
 */
export function defaultPullBranch(
  branches: Pick<Branch, 'name' | 'remote'>[],
  remote: string,
  upstream: string | null,
  head: string,
): string {
  const available = remoteBranchNames(branches, remote);
  if (upstream?.startsWith(`${remote}/`)) {
    const b = upstream.slice(remote.length + 1);
    if (available.includes(b)) return b;
  }
  return available.includes(head) ? head : '';
}

/** Traduce las casillas del diálogo al modo de integración de git. */
export function pullModeFromForm(v: FormValues): NonNullable<PullOptions['mode']> {
  if (v['rebase']) return 'rebase';
  return v['ffOnly'] ? 'ff-only' : 'merge';
}
