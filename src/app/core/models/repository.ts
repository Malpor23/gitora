import { FileChange } from './file';
import { ProviderKind } from './setting';

export type RepoOperationState =
  | 'clean'
  | 'merging'
  | 'rebasing'
  | 'rebasing-interactive'
  | 'cherry-picking'
  | 'reverting'
  | 'bisecting'
  | 'applying';

export interface RepoStatus {
  head: string; // nombre de la rama o hash corto si está "detached"
  oid: string | null; // null en un repo sin commits
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  state: RepoOperationState;
}

export type RefType = 'head' | 'branch' | 'remote' | 'tag' | 'stash';

export interface RefLabel {
  name: string;
  type: RefType;
  current?: boolean;
}

export interface Commit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: string; // ISO 8601
  committer: string;
  committerEmail: string;
  committerDate: string;
  subject: string;
  body: string;
  refs: RefLabel[];
}

export interface CommitDetails extends Commit {
  files: FileChange[];
  stats: { additions: number; deletions: number };
}

export interface Branch {
  name: string; // main, feature/login, origin/main
  fullName: string; // refs/heads/main
  remote: string | null; // nombre del remoto si es rama remota
  current: boolean;
  hash: string;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  subject: string;
  date: string;
  author: string;
}

export interface Tag {
  name: string;
  hash: string; // commit al que apunta (desreferenciado)
  annotated: boolean;
  message: string;
  date: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface Stash {
  index: number;
  ref: string; // stash@{0}
  hash: string;
  message: string;
  date: string;
}

export interface Submodule {
  path: string;
  hash: string;
  status: 'ok' | 'uninitialized' | 'modified' | 'conflict';
  describe: string;
}

export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  main: boolean;
}

export interface ReflogEntry {
  hash: string;
  selector: string; // HEAD@{3}
  action: string;
  date: string;
}

export interface BlameLine {
  hash: string;
  author: string;
  date: string;
  summary: string;
  lineNo: number;
  content: string;
}

export type DiffLineType = 'add' | 'del' | 'ctx' | 'nonewline';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string; // texto tras el segundo @@ (función/contexto)
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  /** Cabecera cruda (diff --git, index, ---/+++), necesaria para reconstruir parches. */
  headerLines: string[];
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

/** Contenido de una imagen del repositorio, listo para mostrarse en el diff. */
export interface ImageBlob {
  mime: string;
  /** Bytes de la imagen en base64. */
  base64: string;
  size: number;
}

export interface ConflictVersions {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  merged: string;
}

export interface CommandLogEntry {
  id: number;
  repo: string;
  args: string[];
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  output: string;
  error: string;
  running: boolean;
}

export interface ProgressEvent {
  id: string; // id de la operación (clone, fetch, push...)
  phase: string; // "Receiving objects", "Resolving deltas"...
  percent: number | null;
  raw: string;
}

/* ───────────── Opciones de operaciones ───────────── */

export interface LogOptions {
  limit?: number;
  skip?: number;
  all?: boolean; // --all (todas las ramas)
  ref?: string; // rama o ref concreta
  search?: string; // busca en mensaje (--grep)
  author?: string;
  path?: string; // historial de un archivo
  hash?: string; // buscar por hash
  firstParent?: boolean;
}

export interface CommitOptions {
  message: string;
  amend?: boolean;
  signoff?: boolean;
  noVerify?: boolean;
  gpgSign?: boolean;
  allowEmpty?: boolean;
  author?: string; // "Nombre <correo>"
  /** Co-autores como "Nombre <correo>"; se añaden al mensaje como trailers `Co-authored-by`. */
  coAuthors?: string[];
}

export interface CloneOptions {
  url: string;
  directory: string;
  branch?: string;
  depth?: number;
  recursive?: boolean;
  bare?: boolean;
  opId: string;
}

export interface PushOptions {
  remote: string;
  branch?: string; // local
  remoteBranch?: string;
  force?: 'none' | 'with-lease' | 'force';
  tags?: boolean;
  setUpstream?: boolean;
  noVerify?: boolean;
  opId?: string;
}

export interface PullOptions {
  remote?: string;
  branch?: string;
  mode?: 'merge' | 'rebase' | 'ff-only';
  autostash?: boolean;
  opId?: string;
}

export interface FetchOptions {
  remote?: string; // undefined = --all
  branch?: string; // solo con remote: trae únicamente esa rama
  prune?: boolean;
  tags?: boolean;
  opId?: string;
}

export interface MergeOptions {
  ref: string;
  strategy?: 'default' | 'no-ff' | 'ff-only' | 'squash';
  message?: string;
  noCommit?: boolean;
}

export interface RebaseOptions {
  onto: string;
  autostash?: boolean;
  preserveMerges?: boolean; // --rebase-merges
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseTodoItem {
  action: RebaseAction;
  hash: string;
  subject: string;
  /** Nuevo mensaje cuando action = reword (o mensaje final de un squash). */
  message?: string;
}

export interface StashOptions {
  message?: string;
  /** Pasa a stage los archivos nuevos antes de guardar (por defecto el stash los ignora). */
  stageNew?: boolean;
  includeUntracked?: boolean;
  keepIndex?: boolean;
  paths?: string[];
  staged?: boolean;
}

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep' | 'merge';

export interface CreateTagOptions {
  name: string;
  ref: string;
  message?: string; // con mensaje = tag anotado
  force?: boolean;
  sign?: boolean;
}

export interface RepoInfo {
  path: string; // raíz del worktree
  name: string;
  gitDir: string;
  bare: boolean;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** Cómo se autentica una cuenta: token (PAT), usuario y contraseña, OAuth (device flow) o clave SSH. */
export type AuthMethod = 'token' | 'password' | 'oauth' | 'ssh';

export interface Account {
  id: string;
  provider: ProviderKind;
  baseUrl: string;
  host: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  /** El token nunca viaja al renderer: aquí solo se indica si existe. */
  hasToken: boolean;
  /** Método de autenticación. Las cuentas guardadas antes de existir este campo son 'token'. */
  authMethod: AuthMethod;
  /** Solo 'ssh': ruta de la clave privada (el contenido nunca se lee ni se guarda). */
  sshKeyPath?: string;
  /**
   * La API del proveedor (listar repos, pull requests) está disponible. Es false para las claves
   * SSH y para las contraseñas que el proveedor no acepta en su API.
   */
  apiAccess: boolean;
}

/** Resultado de comprobar una cuenta: 'unverifiable' = sin API (clave SSH o sin acceso a la API). */
export type AccountStatus = 'online' | 'offline' | 'invalid' | 'unverifiable';

export interface NewAccountInput {
  provider: ProviderKind;
  baseUrl?: string;
  username?: string;
  /** Por defecto 'token'. 'oauth' no usa este tipo: se inicia con `oauthStart`. */
  authMethod?: Exclude<AuthMethod, 'oauth'>;
  /** Token (PAT) o contraseña / app password según el método; no se usa con 'ssh'. */
  token?: string;
  /** Solo 'ssh': ruta absoluta de la clave privada. */
  sshKeyPath?: string;
}

/** Datos para iniciar el inicio de sesión OAuth por device flow (RFC 8628). */
export interface OAuthStartInput {
  provider: ProviderKind;
  baseUrl?: string;
  /** Client ID de la OAuth App del propio usuario (no hay uno incorporado). */
  clientId: string;
}

/** Lo que el usuario necesita ver para autorizar: el código y dónde escribirlo. */
export interface OAuthDeviceCode {
  /** Identifica la sesión; el `device_code` secreto se queda en el proceso principal. */
  sessionId: string;
  userCode: string;
  verificationUri: string;
  /** Si el proveedor la da, ya incluye el código y evita escribirlo. */
  verificationUriComplete?: string;
  /** Segundos hasta que el código vence. */
  expiresIn: number;
}

export interface RemoteRepository {
  provider: ProviderKind;
  accountId: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  fork: boolean;
  defaultBranch: string;
  cloneUrl: string;
  sshUrl: string;
  webUrl: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  sourceBranch: string;
  targetBranch: string;
  url: string;
  createdAt: string;
  draft: boolean;
}

export interface NewPullRequest {
  title: string;
  body: string;
  source: string;
  target: string;
  draft?: boolean;
}

export interface RemoteLocator {
  provider: ProviderKind | null;
  host: string;
  owner: string;
  repo: string;
}

/* ───────── Git Flow (implementación nativa con la config `gitflow.*`) ───────── */

export type GitFlowKind = 'feature' | 'release' | 'hotfix';

export interface GitFlowConfig {
  /** Rama de producción (main/master) y de desarrollo (develop). */
  master: string;
  develop: string;
  /** Prefijos de ramas, con barra final: `feature/`, `release/`, `hotfix/`. */
  feature: string;
  release: string;
  hotfix: string;
  /** Prefijo de los tags de versión (puede ser vacío). */
  versionTag: string;
}

/* ───────── Estadísticas, treemap y benchmark del repositorio ───────── */

export interface RepoContributor {
  name: string;
  email: string;
  commits: number;
}

export interface RepoStats {
  commits: number;
  branches: number;
  tags: number;
  /** Archivos versionados en HEAD. */
  files: number;
  /** ISO 8601; null si no hay commits. */
  firstCommit: string | null;
  lastCommit: string | null;
  /** Tamaño de la base de datos de git (.git), en KiB. */
  sizeKb: number;
  /** Autores ordenados por commits (máx. 50). */
  contributors: RepoContributor[];
  /** Commits por mes (`YYYY-MM`) de los últimos 12 meses, de más antiguo a más reciente. */
  activity: { month: string; commits: number }[];
}

/** Un archivo versionado en HEAD y su tamaño en bytes (para el treemap). */
export interface FileSize {
  path: string;
  size: number;
}

export interface BenchmarkResult {
  /** Clave i18n del nombre de la prueba. */
  name: string;
  /** Comando git equivalente, para mostrarlo. */
  command: string;
  /** Duración en milisegundos; null si el comando falló. */
  ms: number | null;
}
