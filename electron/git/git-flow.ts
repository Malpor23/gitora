import type { GitFlowConfig, GitFlowKind } from '../../src/app/core/models';

/** Ejecuta git en el repositorio y devuelve stdout (lanza si el código de salida no es 0). */
export type Exec = (args: string[], opts?: { silent?: boolean }) => Promise<string>;

/**
 * Git Flow nativo: guarda la configuración en las mismas claves `gitflow.*` que usa git-flow-avh
 * (compatible con repos que ya lo usan) y crea las ramas con git puro, sin depender de que el
 * comando `git flow` esté instalado.
 */
const KEYS = {
  master: 'gitflow.branch.master',
  develop: 'gitflow.branch.develop',
  feature: 'gitflow.prefix.feature',
  release: 'gitflow.prefix.release',
  hotfix: 'gitflow.prefix.hotfix',
  versionTag: 'gitflow.prefix.versiontag',
} as const;

export const FLOW_DEFAULT_PREFIXES = {
  feature: 'feature/',
  release: 'release/',
  hotfix: 'hotfix/',
  versionTag: '',
} as const;

export async function flowStatus(git: Exec): Promise<GitFlowConfig | null> {
  const out = await git(['config', '--local', '--get-regexp', '^gitflow\\.'], {
    silent: true,
  }).catch(() => '');
  const cfg = new Map<string, string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(' ');
    cfg.set(i < 0 ? line : line.slice(0, i), i < 0 ? '' : line.slice(i + 1));
  }
  const master = cfg.get(KEYS.master);
  const develop = cfg.get(KEYS.develop);
  if (!master || !develop) return null;
  return {
    master,
    develop,
    feature: cfg.get(KEYS.feature) || FLOW_DEFAULT_PREFIXES.feature,
    release: cfg.get(KEYS.release) || FLOW_DEFAULT_PREFIXES.release,
    hotfix: cfg.get(KEYS.hotfix) || FLOW_DEFAULT_PREFIXES.hotfix,
    versionTag: cfg.get(KEYS.versionTag) ?? FLOW_DEFAULT_PREFIXES.versionTag,
  };
}

async function branchExists(git: Exec, name: string): Promise<boolean> {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { silent: true }).then(
    () => true,
    () => false,
  );
}

async function assertRefName(git: Exec, name: string, label: string): Promise<void> {
  if (!name.trim()) throw new Error(`${label}: el nombre no puede estar vacío`);
  await git(['check-ref-format', '--branch', name], { silent: true }).catch(() => {
    throw new Error(`${label}: "${name}" no es un nombre de rama válido`);
  });
}

export async function flowInit(git: Exec, cfg: GitFlowConfig): Promise<void> {
  const master = cfg.master.trim();
  const develop = cfg.develop.trim();
  await assertRefName(git, master, 'Rama de producción');
  await assertRefName(git, develop, 'Rama de desarrollo');
  if (master === develop)
    throw new Error('Las ramas de producción y desarrollo deben ser distintas');
  for (const [label, prefix] of [
    ['Prefijo de features', cfg.feature],
    ['Prefijo de releases', cfg.release],
    ['Prefijo de hotfixes', cfg.hotfix],
  ] as const) {
    await assertRefName(git, `${prefix.trim()}x`, label);
  }
  if (!(await branchExists(git, master))) {
    throw new Error(`La rama de producción "${master}" no existe`);
  }
  if (!(await branchExists(git, develop))) await git(['branch', develop, master]);

  const set = (key: string, value: string) => git(['config', '--local', key, value]);
  await set(KEYS.master, master);
  await set(KEYS.develop, develop);
  await set(KEYS.feature, cfg.feature.trim());
  await set(KEYS.release, cfg.release.trim());
  await set(KEYS.hotfix, cfg.hotfix.trim());
  await set(KEYS.versionTag, cfg.versionTag.trim());
}

/** Crea `<prefijo><nombre>` desde develop (feature, release) o producción (hotfix) y la activa. */
export async function flowStart(git: Exec, kind: GitFlowKind, name: string): Promise<string> {
  const cfg = await flowStatus(git);
  if (!cfg) throw new Error('Git Flow no está inicializado en este repositorio');
  const clean = name.trim();
  if (!clean) throw new Error('Nombre: no puede estar vacío');
  const branch = `${cfg[kind]}${clean}`;
  await assertRefName(git, branch, 'Nombre');
  if (await branchExists(git, branch)) throw new Error(`La rama "${branch}" ya existe`);
  const base = kind === 'hotfix' ? cfg.master : cfg.develop;
  if (!(await branchExists(git, base))) throw new Error(`La rama base "${base}" no existe`);
  await git(['checkout', '-b', branch, base]);
  return branch;
}

/** Quita la configuración `gitflow.*`; no borra ninguna rama. */
export async function flowDeinit(git: Exec): Promise<void> {
  for (const section of ['gitflow.branch', 'gitflow.prefix', 'gitflow']) {
    await git(['config', '--local', '--remove-section', section], { silent: true }).catch(
      () => undefined,
    );
  }
}
