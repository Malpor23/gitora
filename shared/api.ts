import type {
  Account,
  AccountStatus,
  BlameLine,
  BenchmarkResult,
  Branch,
  CloneOptions,
  CommandLogEntry,
  Commit,
  CommitDetails,
  CommitOptions,
  ConflictVersions,
  CreateTagOptions,
  DiffFile,
  ImageBlob,
  FetchOptions,
  FileSize,
  GitFlowConfig,
  GitFlowKind,
  GitIdentity,
  LogOptions,
  MergeOptions,
  NewAccountInput,
  OAuthDeviceCode,
  OAuthStartInput,
  NewPullRequest,
  ProgressEvent,
  PullOptions,
  PullRequest,
  PushOptions,
  RebaseOptions,
  RebaseTodoItem,
  ReflogEntry,
  Remote,
  RemoteLocator,
  RemoteRepository,
  RepoInfo,
  RepoStats,
  RepoStatus,
  ResetMode,
  Settings,
  Stash,
  StashOptions,
  Submodule,
  Tag,
  Worktree,
} from '@core/models';

export interface GitOps {
  // Repositorio
  open(path: string): Promise<RepoInfo>;
  init(path: string, bare: boolean, initialBranch: string): Promise<RepoInfo>;
  clone(_: string, opts: CloneOptions): Promise<RepoInfo>;
  identity(repo: string): Promise<GitIdentity>;
  setIdentity(repo: string, identity: GitIdentity, global: boolean): Promise<void>;
  configList(repo: string, scope: 'local' | 'global'): Promise<Record<string, string>>;
  configSet(repo: string, key: string, value: string, scope: 'local' | 'global'): Promise<void>;
  configUnset(repo: string, key: string, scope: 'local' | 'global'): Promise<void>;

  // Estado y cambios
  status(repo: string): Promise<RepoStatus>;
  diffWorking(
    repo: string,
    path: string,
    staged: boolean,
    context: number,
    ignoreWs: boolean,
  ): Promise<DiffFile | null>;
  stage(repo: string, paths: string[]): Promise<void>;
  stageAll(repo: string): Promise<void>;
  unstage(repo: string, paths: string[]): Promise<void>;
  unstageAll(repo: string): Promise<void>;
  discard(repo: string, paths: string[]): Promise<void>;
  discardAll(repo: string, includeUntracked: boolean): Promise<void>;
  applyPatch(repo: string, patch: string, mode: 'stage' | 'unstage' | 'discard'): Promise<void>;
  ignore(repo: string, pattern: string): Promise<void>;
  clean(repo: string, directories: boolean, ignored: boolean, dryRun: boolean): Promise<string[]>;
  commit(repo: string, opts: CommitOptions): Promise<string>;
  lastCommitMessage(repo: string): Promise<string>;

  // Conflictos
  conflictVersions(repo: string, path: string): Promise<ConflictVersions>;
  resolveWith(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void>;
  saveResolution(repo: string, path: string, content: string): Promise<void>;
  markResolved(repo: string, paths: string[]): Promise<void>;
  mergetool(repo: string, path: string, tool: string): Promise<void>;

  // Historial
  log(repo: string, opts: LogOptions): Promise<Commit[]>;
  show(repo: string, hash: string): Promise<CommitDetails>;
  diffCommit(
    repo: string,
    hash: string,
    path: string | null,
    context: number,
    ignoreWs: boolean,
  ): Promise<DiffFile[]>;
  diffRange(repo: string, from: string, to: string, path: string | null): Promise<DiffFile[]>;
  fileAt(repo: string, rev: string, path: string): Promise<string>;
  /**
   * Imagen de un archivo para el diff. `rev`: null = árbol de trabajo, '' = índice,
   * otro valor = commit o referencia. Devuelve null si no es imagen, no existe o es muy grande.
   */
  imageBlob(repo: string, rev: string | null, path: string): Promise<ImageBlob | null>;
  blame(repo: string, path: string, rev: string | null): Promise<BlameLine[]>;
  reflog(repo: string, limit: number): Promise<ReflogEntry[]>;
  formatPatch(repo: string, hashes: string[], outDir: string): Promise<string[]>;
  applyMailbox(repo: string, files: string[]): Promise<void>;

  // Ramas
  branches(repo: string): Promise<Branch[]>;
  createBranch(repo: string, name: string, startPoint: string, checkout: boolean): Promise<void>;
  checkout(repo: string, ref: string, opts: { force?: boolean; track?: boolean }): Promise<void>;
  checkoutFiles(repo: string, rev: string, paths: string[]): Promise<void>;
  renameBranch(repo: string, oldName: string, newName: string): Promise<void>;
  deleteBranch(repo: string, name: string, force: boolean): Promise<void>;
  deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void>;
  setUpstream(repo: string, branch: string, upstream: string | null): Promise<void>;
  mergeBase(repo: string, a: string, b: string): Promise<string>;

  // Integración
  merge(repo: string, opts: MergeOptions): Promise<void>;
  mergeAbort(repo: string): Promise<void>;
  mergeContinue(repo: string): Promise<void>;
  rebase(repo: string, opts: RebaseOptions): Promise<void>;
  rebaseInteractive(
    repo: string,
    base: string,
    todo: RebaseTodoItem[],
    autostash: boolean,
  ): Promise<void>;
  rebaseContinue(repo: string): Promise<void>;
  rebaseSkip(repo: string): Promise<void>;
  rebaseAbort(repo: string): Promise<void>;
  cherryPick(repo: string, hashes: string[], noCommit: boolean): Promise<void>;
  cherryPickContinue(repo: string): Promise<void>;
  cherryPickAbort(repo: string): Promise<void>;
  revert(repo: string, hashes: string[], noCommit: boolean): Promise<void>;
  revertContinue(repo: string): Promise<void>;
  revertAbort(repo: string): Promise<void>;
  reset(repo: string, target: string, mode: ResetMode): Promise<void>;

  // Remotos
  remotes(repo: string): Promise<Remote[]>;
  addRemote(repo: string, name: string, url: string): Promise<void>;
  removeRemote(repo: string, name: string): Promise<void>;
  renameRemote(repo: string, oldName: string, newName: string): Promise<void>;
  setRemoteUrl(repo: string, name: string, url: string, push: boolean): Promise<void>;
  fetch(repo: string, opts: FetchOptions): Promise<void>;
  pull(repo: string, opts: PullOptions): Promise<void>;
  push(repo: string, opts: PushOptions): Promise<void>;
  pruneRemote(repo: string, name: string): Promise<void>;

  // Tags
  tags(repo: string): Promise<Tag[]>;
  createTag(repo: string, opts: CreateTagOptions): Promise<void>;
  deleteTag(repo: string, name: string): Promise<void>;
  pushTag(repo: string, remote: string, name: string): Promise<void>;
  deleteRemoteTag(repo: string, remote: string, name: string): Promise<void>;

  // Stash
  stashes(repo: string): Promise<Stash[]>;
  stashSave(repo: string, opts: StashOptions): Promise<void>;
  stashApply(repo: string, index: number, restoreIndex: boolean): Promise<void>;
  stashPop(repo: string, index: number): Promise<void>;
  stashDrop(repo: string, index: number): Promise<void>;
  stashClear(repo: string): Promise<void>;
  stashBranch(repo: string, index: number, branch: string): Promise<void>;
  stashDiff(repo: string, index: number): Promise<DiffFile[]>;

  // Submódulos y worktrees
  submodules(repo: string): Promise<Submodule[]>;
  submoduleAdd(repo: string, url: string, path: string, branch: string | null): Promise<void>;
  submoduleUpdate(repo: string, init: boolean, recursive: boolean, remote: boolean): Promise<void>;
  submoduleSync(repo: string): Promise<void>;
  submoduleDeinit(repo: string, path: string, force: boolean): Promise<void>;
  worktrees(repo: string): Promise<Worktree[]>;
  worktreeAdd(
    repo: string,
    path: string,
    branch: string,
    newBranch: boolean,
    startPoint?: string,
  ): Promise<void>;
  worktreeRemove(repo: string, path: string, force: boolean): Promise<void>;
  worktreePrune(repo: string): Promise<void>;

  /** Git Flow nativo: null si el repositorio no está inicializado. */
  flowStatus(repo: string): Promise<GitFlowConfig | null>;
  flowInit(repo: string, cfg: GitFlowConfig): Promise<void>;
  /** Crea `<prefijo><nombre>` desde develop (feature, release) o producción (hotfix) y lo activa. */
  flowStart(repo: string, kind: GitFlowKind, name: string): Promise<string>;
  flowDeinit(repo: string): Promise<void>;

  repoStats(repo: string): Promise<RepoStats>;
  fileSizes(repo: string): Promise<FileSize[]>;
  benchmark(repo: string): Promise<BenchmarkResult[]>;

  // Bisect
  bisectStart(repo: string, bad: string, good: string): Promise<string>;
  bisectMark(repo: string, verdict: 'good' | 'bad' | 'skip'): Promise<string>;
  bisectReset(repo: string): Promise<void>;

  // LFS y mantenimiento
  lfsInstalled(repo: string): Promise<boolean>;
  lfsTrack(repo: string, pattern: string): Promise<void>;
  lfsPull(repo: string): Promise<void>;
  gc(repo: string, aggressive: boolean): Promise<void>;
  archive(repo: string, ref: string, output: string, format: 'zip' | 'tar.gz'): Promise<void>;

  // Consola: ejecuta un comando git arbitrario (escrito por el usuario).
  raw(repo: string, args: string[]): Promise<string>;
}

export type GitOpName = keyof GitOps;

/** Lista para validar en el proceso principal qué operaciones se permiten por IPC. */
export const GIT_OP_NAMES: GitOpName[] = [
  'open',
  'init',
  'clone',
  'identity',
  'setIdentity',
  'configList',
  'configSet',
  'configUnset',
  'status',
  'diffWorking',
  'stage',
  'stageAll',
  'unstage',
  'unstageAll',
  'discard',
  'discardAll',
  'applyPatch',
  'ignore',
  'clean',
  'commit',
  'lastCommitMessage',
  'conflictVersions',
  'resolveWith',
  'saveResolution',
  'markResolved',
  'mergetool',
  'log',
  'show',
  'diffCommit',
  'diffRange',
  'fileAt',
  'imageBlob',
  'blame',
  'reflog',
  'formatPatch',
  'applyMailbox',
  'branches',
  'createBranch',
  'checkout',
  'checkoutFiles',
  'renameBranch',
  'deleteBranch',
  'deleteRemoteBranch',
  'setUpstream',
  'mergeBase',
  'merge',
  'mergeAbort',
  'mergeContinue',
  'rebase',
  'rebaseInteractive',
  'rebaseContinue',
  'rebaseSkip',
  'rebaseAbort',
  'cherryPick',
  'cherryPickContinue',
  'cherryPickAbort',
  'revert',
  'revertContinue',
  'revertAbort',
  'reset',
  'remotes',
  'addRemote',
  'removeRemote',
  'renameRemote',
  'setRemoteUrl',
  'fetch',
  'pull',
  'push',
  'pruneRemote',
  'tags',
  'createTag',
  'deleteTag',
  'pushTag',
  'deleteRemoteTag',
  'stashes',
  'stashSave',
  'stashApply',
  'stashPop',
  'stashDrop',
  'stashClear',
  'stashBranch',
  'stashDiff',
  'submodules',
  'submoduleAdd',
  'submoduleUpdate',
  'submoduleSync',
  'submoduleDeinit',
  'worktrees',
  'worktreeAdd',
  'worktreeRemove',
  'worktreePrune',
  'flowStatus',
  'flowInit',
  'flowStart',
  'flowDeinit',
  'repoStats',
  'fileSizes',
  'benchmark',
  'bisectStart',
  'bisectMark',
  'bisectReset',
  'lfsInstalled',
  'lfsTrack',
  'lfsPull',
  'gc',
  'archive',
  'raw',
];

/** Operaciones de la aplicación (no git): ajustes, diálogos, ventana, cuentas. */
export interface AppOps {
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  gitVersion(): Promise<string | null>;
  pickDirectory(title: string): Promise<string | null>;
  pickFiles(title: string): Promise<string[]>;
  pickSavePath(title: string, defaultName: string): Promise<string | null>;
  showInFolder(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openTerminal(dir: string): Promise<void>;
  openInEditor(path: string): Promise<void>;
  watchRepo(repo: string): Promise<void>;
  unwatchRepo(repo: string): Promise<void>;
  setTitleBarTheme(dark: boolean): Promise<void>;
  /** Habilita o deshabilita las entradas del menú Repository según haya un repo activo. */
  setRepoActive(active: boolean): Promise<void>;
  platform(): Promise<string>;
  commandHistory(): Promise<CommandLogEntry[]>;

  // Cuentas y proveedores
  addAccount(input: NewAccountInput): Promise<Account>;
  removeAccount(id: string): Promise<void>;
  /** Comprueba si la credencial de la cuenta sigue funcionando; el secreto nunca sale del proceso principal. */
  checkAccount(id: string): Promise<AccountStatus>;
  /**
   * Inicio de sesión OAuth por device flow. `oauthStart` pide el código; `oauthComplete` espera
   * (sondeando) a que el usuario autorice en el navegador y crea la cuenta; `oauthCancel` aborta.
   */
  oauthStart(input: OAuthStartInput): Promise<OAuthDeviceCode>;
  oauthComplete(sessionId: string): Promise<Account>;
  oauthCancel(sessionId: string): Promise<void>;
  listRemoteRepos(accountId: string, query: string): Promise<RemoteRepository[]>;
  locateRemote(url: string): Promise<RemoteLocator>;
  pullRequests(repo: string, remoteName: string): Promise<PullRequest[]>;
  createPullRequest(repo: string, remoteName: string, pr: NewPullRequest): Promise<PullRequest>;
}

export type AppOpName = keyof AppOps;

export const APP_OP_NAMES: AppOpName[] = [
  'getSettings',
  'updateSettings',
  'gitVersion',
  'pickDirectory',
  'pickFiles',
  'pickSavePath',
  'showInFolder',
  'openExternal',
  'openTerminal',
  'openInEditor',
  'watchRepo',
  'unwatchRepo',
  'setTitleBarTheme',
  'setRepoActive',
  'platform',
  'commandHistory',
  'addAccount',
  'removeAccount',
  'checkAccount',
  'oauthStart',
  'oauthComplete',
  'oauthCancel',
  'listRemoteRepos',
  'locateRemote',
  'pullRequests',
  'createPullRequest',
];

/** Eventos que el proceso principal empuja al renderer. */
export interface MainEvents {
  'command-log': CommandLogEntry;
  progress: ProgressEvent;
  'repo-changed': { repo: string; gitOnly: boolean };
  'window-focus': { focused: boolean };
  /** Una entrada del menú nativo pidió ejecutar el comando con este id. */
  'menu-command': { id: string };
}

export type Unwrap<T> = T extends Promise<infer U> ? U : T;
