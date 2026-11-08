import type { GitFlowConfig, GitFlowKind } from '@core/models';

/**
 * Rama por defecto para "Comenzar desde" / rama de producción: `main`, si no `master`, si no la
 * rama actual y, en último caso, la primera que exista.
 */
export function defaultStartBranch(localNames: string[], head: string): string {
  if (localNames.includes('main')) return 'main';
  if (localNames.includes('master')) return 'master';
  if (localNames.includes(head)) return head;
  return localNames[0] ?? head;
}

/** Rama de la que sale cada tipo de rama de Git Flow: los hotfix de producción, el resto de develop. */
export function flowBaseBranch(
  cfg: Pick<GitFlowConfig, 'master' | 'develop'>,
  kind: GitFlowKind,
): string {
  return kind === 'hotfix' ? cfg.master : cfg.develop;
}

/** Nombre completo de la rama que se crea (`feature/login`). */
export function flowBranchName(
  cfg: Pick<GitFlowConfig, GitFlowKind>,
  kind: GitFlowKind,
  name: string,
): string {
  return `${cfg[kind]}${name.trim()}`;
}
