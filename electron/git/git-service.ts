import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitOps } from '../../shared/api';
import type {
  BenchmarkResult, BlameLine, Branch, CloneOptions, Commit, CommitDetails, CommitOptions, ConflictVersions,
  CreateTagOptions, DiffFile, FetchOptions, FileChange, FileSize, GitFlowConfig, GitFlowKind, GitIdentity, LogOptions, MergeOptions,
  PullOptions, PushOptions, RebaseOptions, RebaseTodoItem, ReflogEntry, Remote, RepoInfo,
  RepoOperationState, RepoStats, RepoStatus, ResetMode, Stash, StashOptions, Submodule, Tag, Worktree,
} from '@core/models';
import * as flow from './git-flow';
import { GitError, GitRunner, RunOptions } from './git-runner';
import * as insights from './repo-insights';
import { parseDiff } from './parsers/diff.parser';
import { LOG_FORMAT, parseLog } from './parsers/log.parser';
import {
  BRANCH_FORMAT, parseBlame, parseBranches, parseNameStatus, parseNumstatTotals, parseReflog,
  parseRemotes, parseStashes, parseSubmodules, parseTags, parseWorktrees, REFLOG_FORMAT,
  STASH_FORMAT, TAG_FORMAT,
} from './parsers/refs.parser';
import { kindFromCode, parseStatusV2 } from './parsers/status.parser';

/**
 * Devuelve configuración `-c` extra para autenticarse contra un remoto
 * (cabecera HTTP con el token de la cuenta del proveedor), o [] si no aplica.
 */
export type AuthResolver = (url: string) => string[] | Promise<string[]>;

export interface EditorHelper {
  /** Comando que git ejecutará como GIT_SEQUENCE_EDITOR / GIT_EDITOR. */
  command: string;
  /** Variables de entorno que el script necesita para trabajar. */
  env(todoFile?: string, messagesFile?: string): Record<string, string>;
}

export class GitService implements GitOps {
  private remoteCache = new Map<string, { at: number; remotes: Remote[] }>();

  constructor(
    private readonly runner: GitRunner,
    private readonly auth: AuthResolver,
    private readonly editor: EditorHelper,
    private readonly tmpDir: string,
  ) {}

  /* ───────────── utilidades ───────────── */

  private git(repo: string, args: string[], opts: Partial<RunOptions> = {}): Promise<string> {
    return this.runner.run(args, { cwd: repo, ...opts });
  }

  /** Para operaciones que no deben abrir un editor interactivo. */
  private get noEditorEnv(): Record<string, string> {
    return { GIT_EDITOR: this.editor.command, GIT_SEQUENCE_EDITOR: this.editor.command, ...this.editor.env() };
  }

  private async remoteAuth(repo: string, remote?: string): Promise<string[]> {
    const remotes = await this.cachedRemotes(repo);
    const targets = remote ? remotes.filter((r) => r.name === remote) : remotes;
    const lists = await Promise.all(targets.flatMap((r) => [this.auth(r.fetchUrl), this.auth(r.pushUrl)]));
    let config = [...new Set(lists.flat())];
    // `core.sshCommand` es global: con claves distintas para varios remotos no se puede elegir una sin
    // equivocarse, así que se omite y ssh usa su configuración habitual.
    if (config.filter((c) => c.startsWith('core.sshCommand=')).length > 1) {
      config = config.filter((c) => !c.startsWith('core.sshCommand='));
    }
    return config;
  }

  private async cachedRemotes(repo: string): Promise<Remote[]> {
    const c = this.remoteCache.get(repo);
    if (c && Date.now() - c.at < 10_000) return c.remotes;
    const remotes = await this.remotes(repo);
    return remotes;
  }

  private async gitDir(repo: string): Promise<string> {
    return (await this.git(repo, ['rev-parse', '--absolute-git-dir'], { silent: true })).trim();
  }

  /* ───────────── repositorio ───────────── */

  async open(dir: string): Promise<RepoInfo> {
    if (!existsSync(dir)) throw new Error(`La carpeta no existe: ${dir}`);
    const out = await this.git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--is-bare-repository'], { silent: true })
      .catch(async (e: GitError) => {
        if (e.exitCode === null) throw e; // git no se pudo ejecutar: mostrar ese error real
        // Repositorio bare: --show-toplevel falla
        const bare = await this.git(dir, ['rev-parse', '--absolute-git-dir', '--is-bare-repository'], { silent: true }).catch(() => null);
        if (bare) return `${dir}\n${bare}`;
        throw new Error(`No es un repositorio git: ${dir}`);
      });
    const [top, gitDir, bare] = out.trim().split('\n');
    const root = path.normalize(top);
    return { path: root, name: path.basename(root), gitDir, bare: bare === 'true' };
  }

  async init(dir: string, bare: boolean, initialBranch: string): Promise<RepoInfo> {
    await fs.mkdir(dir, { recursive: true });
    const args = ['init'];
    if (bare) args.push('--bare');
    if (initialBranch) args.push('--initial-branch', initialBranch);
    await this.git(dir, args);
    return this.open(dir);
  }

  async clone(_: string, opts: CloneOptions): Promise<RepoInfo> {
    const parent = path.dirname(opts.directory);
    await fs.mkdir(parent, { recursive: true });
    const args = ['clone', '--progress'];
    if (opts.branch) args.push('--branch', opts.branch);
    if (opts.depth) args.push('--depth', String(opts.depth));
    if (opts.recursive) args.push('--recurse-submodules');
    if (opts.bare) args.push('--bare');
    args.push('--', opts.url, opts.directory);
    const config = await this.auth(opts.url);
    try {
      await this.runner.run(args, { cwd: parent, progressId: opts.opId, config });
    } catch (e) {
      // Sin credenciales git no puede preguntar (los prompts están desactivados): decir qué falta.
      if (e instanceof GitError && !config.length && /terminal prompts disabled|could not read (Username|Password)/i.test(e.stderr)) {
        throw new GitError(
          'El repositorio requiere autenticación y no hay una cuenta para ese servidor. Agrega una en Ajustes > Cuentas (token, contraseña o clave SSH) y vuelve a clonar.',
          e.args, e.exitCode, e.stderr, e.stdout,
        );
      }
      throw e;
    }
    return this.open(opts.directory);
  }

  async identity(repo: string): Promise<GitIdentity> {
    const get = (k: string) => this.git(repo, ['config', '--get', k], { silent: true, okCodes: [1] }).then((s) => s.trim());
    return { name: await get('user.name'), email: await get('user.email') };
  }

  async setIdentity(repo: string, id: GitIdentity, global: boolean): Promise<void> {
    const scope = global ? '--global' : '--local';
    await this.git(repo, ['config', scope, 'user.name', id.name]);
    await this.git(repo, ['config', scope, 'user.email', id.email]);
  }

  async configList(repo: string, scope: 'local' | 'global'): Promise<Record<string, string>> {
    const out = await this.git(repo, ['config', `--${scope}`, '--list', '-z'], { silent: true, okCodes: [1, 128] });
    const map: Record<string, string> = {};
    for (const entry of out.split('\0').filter(Boolean)) {
      const nl = entry.indexOf('\n');
      if (nl === -1) map[entry] = '';
      else map[entry.slice(0, nl)] = entry.slice(nl + 1);
    }
    return map;
  }

  async configSet(repo: string, key: string, value: string, scope: 'local' | 'global'): Promise<void> {
    await this.git(repo, ['config', `--${scope}`, key, value]);
  }

  async configUnset(repo: string, key: string, scope: 'local' | 'global'): Promise<void> {
    await this.git(repo, ['config', `--${scope}`, '--unset', key], { okCodes: [5] });
  }

  /* ───────────── estado y cambios ───────────── */

  async status(repo: string): Promise<RepoStatus> {
    const out = await this.git(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { silent: true });
    const parsed = parseStatusV2(out);
    return { ...parsed, state: await this.operationState(repo) };
  }

  private async operationState(repo: string): Promise<RepoOperationState> {
    const dir = await this.gitDir(repo);
    const has = (p: string) => existsSync(path.join(dir, p));
    if (has('rebase-merge')) return has('rebase-merge/interactive') ? 'rebasing-interactive' : 'rebasing';
    if (has('rebase-apply')) return has('rebase-apply/applying') ? 'applying' : 'rebasing';
    if (has('MERGE_HEAD')) return 'merging';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-picking';
    if (has('REVERT_HEAD')) return 'reverting';
    if (has('BISECT_LOG')) return 'bisecting';
    return 'clean';
  }

  async diffWorking(repo: string, file: string, staged: boolean, context: number, ignoreWs: boolean): Promise<DiffFile | null> {
    const args = ['diff', '--no-ext-diff', '-M', `-U${context}`];
    if (ignoreWs) args.push('-w');
    if (staged) args.push('--cached');
    args.push('--', file);
    if (staged) {
      // Limitar el diff al archivo nuevo impediría a git detectar el renombrado: se añade también la ruta de origen
      const names = await this.git(repo, ['diff', '--cached', '-M', '-z', '--name-status'], { silent: true });
      const orig = parseNameStatus(names).find((f) => f.path === file)?.origPath;
      if (orig) args.push(orig);
    }
    let out = await this.git(repo, args, { silent: true });

    if (!out.trim() && !staged && !(await this.git(repo, ['ls-files', '--', file], { silent: true })).trim()) {
      // Archivo sin seguimiento (no está en el índice): se compara contra /dev/null
      const abs = path.join(repo, file);
      if (existsSync(abs) && (await fs.stat(abs)).isFile()) {
        out = await this.git(repo, ['diff', '--no-ext-diff', '--no-index', `-U${context}`, '--', nullDevice(), file], { silent: true, okCodes: [1] });
      }
    }
    const files = parseDiff(out);
    if (files[0]) return files[0];
    // Archivo con seguimiento cuyo diff queda vacío (p. ej. solo espacios con -w): se muestra «sin diferencias», no «elige un archivo»
    if (ignoreWs && (await this.git(repo, ['ls-files', '--', file], { silent: true })).trim()) {
      return { oldPath: file, newPath: file, headerLines: [], isNew: false, isDeleted: false, isRename: false, isBinary: false, additions: 0, deletions: 0, hunks: [] };
    }
    return null;
  }

  async stage(repo: string, paths: string[]): Promise<void> {
    await this.git(repo, ['add', '-A', '--', ...paths]);
  }

  async stageAll(repo: string): Promise<void> {
    await this.git(repo, ['add', '-A']);
  }

  async unstage(repo: string, paths: string[]): Promise<void> {
    const hasHead = await this.hasHead(repo);
    if (hasHead) await this.git(repo, ['reset', '-q', 'HEAD', '--', ...paths]);
    else await this.git(repo, ['rm', '--cached', '-r', '-q', '--', ...paths]);
  }

  async unstageAll(repo: string): Promise<void> {
    if (await this.hasHead(repo)) await this.git(repo, ['reset', '-q', 'HEAD']);
    else await this.git(repo, ['rm', '--cached', '-r', '-q', '.']);
  }

  async discard(repo: string, paths: string[]): Promise<void> {
    const st = await this.status(repo);
    const untracked = new Set(st.unstaged.filter((f) => f.kind === 'untracked').map((f) => f.path));
    const conflicted = new Set(st.conflicted.map((f) => f.path));
    const toClean = paths.filter((p) => untracked.has(p));
    const toRestore = paths.filter((p) => !untracked.has(p) && !conflicted.has(p));
    // `git checkout -- <ruta>` se niega sobre rutas sin fusionar: se restauran desde HEAD (versión propia)
    const toHead = paths.filter((p) => conflicted.has(p));
    if (toRestore.length) await this.git(repo, ['checkout', '--', ...toRestore]);
    if (toHead.length) await this.git(repo, ['checkout', 'HEAD', '--', ...toHead]);
    if (toClean.length) await this.git(repo, ['clean', '-f', '-d', '--', ...toClean]);
  }

  async discardAll(repo: string, includeUntracked: boolean): Promise<void> {
    if (await this.hasHead(repo)) await this.git(repo, ['reset', '--hard', '-q', 'HEAD']);
    if (includeUntracked) await this.git(repo, ['clean', '-f', '-d']);
  }

  async applyPatch(repo: string, patch: string, mode: 'stage' | 'unstage' | 'discard'): Promise<void> {
    if (!patch.trim()) return;
    const args = ['apply', '--whitespace=nowarn', '--recount'];
    if (mode === 'stage') args.push('--cached');
    if (mode === 'unstage') args.push('--cached', '-R');
    if (mode === 'discard') args.push('-R');
    args.push('-');
    await this.git(repo, args, { input: patch });
  }

  async ignore(repo: string, pattern: string): Promise<void> {
    const file = path.join(repo, '.gitignore');
    const current = existsSync(file) ? await fs.readFile(file, 'utf8') : '';
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    await fs.writeFile(file, current + sep + pattern + '\n', 'utf8');
  }

  async clean(repo: string, directories: boolean, ignored: boolean, dryRun: boolean): Promise<string[]> {
    const args = ['clean', dryRun ? '-n' : '-f'];
    if (directories) args.push('-d');
    if (ignored) args.push('-x');
    const out = await this.git(repo, args);
    return out.split('\n').filter(Boolean).map((l) => l.replace(/^Would remove |^Removing /, ''));
  }

  async commit(repo: string, o: CommitOptions): Promise<string> {
    const args = ['commit', '--cleanup=strip', '-F', '-'];
    if (o.amend) args.push('--amend');
    if (o.signoff) args.push('--signoff');
    if (o.noVerify) args.push('--no-verify');
    if (o.gpgSign) args.push('-S');
    if (o.allowEmpty) args.push('--allow-empty');
    if (o.author) args.push('--author', o.author);
    await this.git(repo, args, { input: o.message, env: this.noEditorEnv });
    return (await this.git(repo, ['rev-parse', 'HEAD'], { silent: true })).trim();
  }

  async lastCommitMessage(repo: string): Promise<string> {
    if (!(await this.hasHead(repo))) return '';
    return (await this.git(repo, ['log', '-1', '--format=%B'], { silent: true })).trim();
  }

  private async hasHead(repo: string): Promise<boolean> {
    return this.git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { silent: true, okCodes: [1] })
      .then((s) => !!s.trim())
      .catch(() => false);
  }

  /* ───────────── conflictos ───────────── */

  async conflictVersions(repo: string, file: string): Promise<ConflictVersions> {
    const stage = (n: number) =>
      this.git(repo, ['show', `:${n}:${file}`], { silent: true }).catch(() => null);
    const merged = await fs.readFile(path.join(repo, file), 'utf8').catch(() => '');
    return { base: await stage(1), ours: await stage(2), theirs: await stage(3), merged };
  }

  async resolveWith(repo: string, file: string, side: 'ours' | 'theirs'): Promise<void> {
    await this.git(repo, ['checkout', `--${side}`, '--', file]);
    await this.git(repo, ['add', '--', file]);
  }

  async saveResolution(repo: string, file: string, content: string): Promise<void> {
    await fs.writeFile(path.join(repo, file), content, 'utf8');
    await this.git(repo, ['add', '--', file]);
  }

  async markResolved(repo: string, paths: string[]): Promise<void> {
    await this.git(repo, ['add', '--', ...paths]);
  }

  async mergetool(repo: string, file: string, tool: string): Promise<void> {
    const args = ['mergetool', '--no-prompt'];
    if (tool) args.push(`--tool=${tool}`);
    args.push('--', file);
    await this.git(repo, args);
  }

  /* ───────────── historial ───────────── */

  async log(repo: string, o: LogOptions): Promise<Commit[]> {
    if (!(await this.hasHead(repo)) && !o.all) return [];
    const args = ['log', `--format=${LOG_FORMAT}`, '--topo-order', '--decorate=short'];
    args.push(`--max-count=${o.limit ?? 300}`);
    if (o.skip) args.push(`--skip=${o.skip}`);
    if (o.firstParent) args.push('--first-parent');
    if (o.search) args.push(`--grep=${o.search}`, '-i', '--all-match');
    if (o.author) args.push(`--author=${o.author}`, '-i');
    if (o.all && !o.hash) args.push('--branches', '--remotes', '--tags', 'HEAD');
    if (o.ref) args.push(o.ref);
    if (o.hash) args.push(o.hash, '--max-count=1');
    if (o.path) args.push('--follow', '--', o.path);
    const out = await this.git(repo, args, { silent: true });
    const remotes = (await this.cachedRemotes(repo)).map((r) => r.name);
    return parseLog(out, remotes);
  }

  async show(repo: string, hash: string): Promise<CommitDetails> {
    const [commit] = await this.log(repo, { hash, limit: 1 });
    if (!commit) throw new Error(`Commit no encontrado: ${hash}`);
    const isRoot = commit.parents.length === 0;
    const diffArgs = isRoot ? ['--root'] : [];
    const firstParent = commit.parents.length > 1 ? ['-m', '--first-parent'] : [];
    const ns = await this.git(repo, ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', ...diffArgs, ...firstParent, hash], { silent: true });
    const num = await this.git(repo, ['diff-tree', '-r', '-M', '--numstat', '--no-commit-id', ...diffArgs, ...firstParent, hash], { silent: true });
    const files: FileChange[] = parseNameStatus(ns).map((f) => ({
      path: f.path,
      origPath: f.origPath,
      kind: kindFromCode(f.code),
      code: f.code,
    }));
    return { ...commit, files, stats: parseNumstatTotals(num) };
  }

  async diffCommit(repo: string, hash: string, file: string | null, context: number, ignoreWs: boolean): Promise<DiffFile[]> {
    const parents = (await this.git(repo, ['rev-list', '--parents', '-n', '1', hash], { silent: true })).trim().split(' ').slice(1);
    const args = parents.length
      ? ['diff', '--no-ext-diff', '-M', `-U${context}`, `${parents[0]}`, hash]
      : ['show', '--no-ext-diff', '--format=', '-M', `-U${context}`, hash];
    if (ignoreWs) args.push('-w');
    // Sin pathspec: limitar el diff al archivo nuevo impediría a git detectar el renombrado.
    const files = parseDiff(await this.git(repo, args, { silent: true }));
    return file ? files.filter((d) => d.newPath === file || d.oldPath === file) : files;
  }

  async diffRange(repo: string, from: string, to: string, file: string | null): Promise<DiffFile[]> {
    const args = ['diff', '--no-ext-diff', '-M', `${from}..${to}`];
    if (file) args.push('--', file);
    return parseDiff(await this.git(repo, args, { silent: true }));
  }

  async fileAt(repo: string, rev: string, file: string): Promise<string> {
    return this.git(repo, ['show', `${rev}:${file}`], { silent: true });
  }

  async blame(repo: string, file: string, rev: string | null): Promise<BlameLine[]> {
    const args = ['blame', '--porcelain', '-w'];
    if (rev) args.push(rev);
    args.push('--', file);
    return parseBlame(await this.git(repo, args, { silent: true }));
  }

  async reflog(repo: string, limit: number): Promise<ReflogEntry[]> {
    return parseReflog(await this.git(repo, ['reflog', `--format=${REFLOG_FORMAT}`, `-n${limit}`], { silent: true, okCodes: [128] }));
  }

  async formatPatch(repo: string, hashes: string[], outDir: string): Promise<string[]> {
    const files: string[] = [];
    for (const h of hashes) {
      const out = await this.git(repo, ['format-patch', '-1', h, '-o', outDir]);
      files.push(...out.split('\n').filter(Boolean));
    }
    return files;
  }

  async applyMailbox(repo: string, files: string[]): Promise<void> {
    await this.git(repo, ['am', '--3way', ...files], { env: this.noEditorEnv });
  }

  /* ───────────── ramas ───────────── */

  async branches(repo: string): Promise<Branch[]> {
    const out = await this.git(repo, ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'], { silent: true });
    return parseBranches(out);
  }

  async createBranch(repo: string, name: string, startPoint: string, checkout: boolean): Promise<void> {
    if (checkout) await this.git(repo, ['checkout', '-b', name, ...(startPoint ? [startPoint] : [])]);
    else await this.git(repo, ['branch', name, ...(startPoint ? [startPoint] : [])]);
  }

  async checkout(repo: string, ref: string, o: { force?: boolean; track?: boolean }): Promise<void> {
    const args = ['checkout'];
    if (o.force) args.push('--force');
    if (o.track) {
      // Rama remota → crea la local con seguimiento (origin/feature → feature)
      const local = ref.split('/').slice(1).join('/');
      const exists = await this.git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${local}`], { silent: true, okCodes: [1] });
      if (exists.trim()) args.push(local);
      else args.push('--track', ref);
    } else {
      args.push(ref);
    }
    await this.git(repo, args);
  }

  async checkoutFiles(repo: string, rev: string, paths: string[]): Promise<void> {
    await this.git(repo, ['checkout', rev, '--', ...paths]);
  }

  async renameBranch(repo: string, oldName: string, newName: string): Promise<void> {
    await this.git(repo, ['branch', '-m', oldName, newName]);
  }

  async deleteBranch(repo: string, name: string, force: boolean): Promise<void> {
    await this.git(repo, ['branch', force ? '-D' : '-d', name]);
  }

  async deleteRemoteBranch(repo: string, remote: string, name: string): Promise<void> {
    await this.git(repo, ['push', remote, '--delete', name], { config: await this.remoteAuth(repo, remote) });
  }

  async setUpstream(repo: string, branch: string, upstream: string | null): Promise<void> {
    if (upstream) await this.git(repo, ['branch', `--set-upstream-to=${upstream}`, branch]);
    else await this.git(repo, ['branch', '--unset-upstream', branch]);
  }

  async mergeBase(repo: string, a: string, b: string): Promise<string> {
    return (await this.git(repo, ['merge-base', a, b], { silent: true })).trim();
  }

  /* ───────────── integración ───────────── */

  async merge(repo: string, o: MergeOptions): Promise<void> {
    const args = ['merge'];
    switch (o.strategy) {
      case 'no-ff': args.push('--no-ff'); break;
      case 'ff-only': args.push('--ff-only'); break;
      case 'squash': args.push('--squash'); break;
    }
    if (o.noCommit) args.push('--no-commit');
    if (o.message) args.push('-m', o.message);
    else args.push('--no-edit');
    args.push(o.ref);
    await this.git(repo, args, { env: this.noEditorEnv });
  }

  async mergeAbort(repo: string): Promise<void> {
    await this.git(repo, ['merge', '--abort']);
  }

  async mergeContinue(repo: string): Promise<void> {
    await this.git(repo, ['commit', '--no-edit'], { env: this.noEditorEnv });
  }

  async rebase(repo: string, o: RebaseOptions): Promise<void> {
    const args = ['rebase'];
    if (o.autostash) args.push('--autostash');
    if (o.preserveMerges) args.push('--rebase-merges');
    args.push(o.onto);
    await this.git(repo, args, { env: this.noEditorEnv });
  }

  /**
   * Rebase interactivo sin terminal: escribimos el "todo" que el usuario armó en la
   * interfaz y un script hace de GIT_SEQUENCE_EDITOR copiándolo. Para "reword" y
   * "squash" el mismo script hace de GIT_EDITOR y escribe los mensajes en orden.
   */
  async rebaseInteractive(repo: string, base: string, todo: RebaseTodoItem[], autostash: boolean): Promise<void> {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const stamp = Date.now();
    const todoFile = path.join(this.tmpDir, `rebase-todo-${stamp}`);
    const msgFile = path.join(this.tmpDir, `rebase-msgs-${stamp}.json`);

    // git aplica el todo de arriba hacia abajo = del más antiguo al más reciente
    const lines = todo.map((t) => `${t.action} ${t.hash} ${t.subject}`);
    await fs.writeFile(todoFile, lines.join('\n') + '\n', 'utf8');

    const messages: string[] = [];
    todo.forEach((t, i) => {
      if (t.action === 'reword') messages.push(t.message ?? t.subject);
      // Al terminar un grupo de squash git abre el editor una vez con el mensaje combinado
      const next = todo[i + 1];
      if (t.action === 'squash' && (!next || next.action !== 'squash') && t.message) messages.push(t.message);
    });
    await fs.writeFile(msgFile, JSON.stringify(messages), 'utf8');

    const args = ['rebase', '-i'];
    if (autostash) args.push('--autostash');
    args.push(base);
    try {
      await this.git(repo, args, {
        env: {
          GIT_SEQUENCE_EDITOR: this.editor.command,
          GIT_EDITOR: this.editor.command,
          ...this.editor.env(todoFile, msgFile),
        },
      });
    } finally {
      await fs.rm(todoFile, { force: true });
      await fs.rm(msgFile, { force: true });
    }
  }

  async rebaseContinue(repo: string): Promise<void> {
    await this.git(repo, ['rebase', '--continue'], { env: this.noEditorEnv });
  }

  async rebaseSkip(repo: string): Promise<void> {
    await this.git(repo, ['rebase', '--skip'], { env: this.noEditorEnv });
  }

  async rebaseAbort(repo: string): Promise<void> {
    await this.git(repo, ['rebase', '--abort']);
  }

  async cherryPick(repo: string, hashes: string[], noCommit: boolean): Promise<void> {
    const args = ['cherry-pick'];
    if (noCommit) args.push('--no-commit');
    await this.git(repo, [...args, ...hashes], { env: this.noEditorEnv });
  }

  async cherryPickContinue(repo: string): Promise<void> {
    await this.git(repo, ['cherry-pick', '--continue'], { env: this.noEditorEnv });
  }

  async cherryPickAbort(repo: string): Promise<void> {
    await this.git(repo, ['cherry-pick', '--abort']);
  }

  async revert(repo: string, hashes: string[], noCommit: boolean): Promise<void> {
    const args = ['revert', '--no-edit'];
    if (noCommit) args.push('--no-commit');
    await this.git(repo, [...args, ...hashes], { env: this.noEditorEnv });
  }

  async revertContinue(repo: string): Promise<void> {
    await this.git(repo, ['revert', '--continue'], { env: this.noEditorEnv });
  }

  async revertAbort(repo: string): Promise<void> {
    await this.git(repo, ['revert', '--abort']);
  }

  async reset(repo: string, target: string, mode: ResetMode): Promise<void> {
    await this.git(repo, ['reset', `--${mode}`, target]);
  }

  /* ───────────── remotos ───────────── */

  async remotes(repo: string): Promise<Remote[]> {
    const remotes = parseRemotes(await this.git(repo, ['remote', '-v'], { silent: true }));
    this.remoteCache.set(repo, { at: Date.now(), remotes });
    return remotes;
  }

  async addRemote(repo: string, name: string, url: string): Promise<void> {
    await this.git(repo, ['remote', 'add', name, url]);
    this.remoteCache.delete(repo);
  }

  async removeRemote(repo: string, name: string): Promise<void> {
    await this.git(repo, ['remote', 'remove', name]);
    this.remoteCache.delete(repo);
  }

  async renameRemote(repo: string, oldName: string, newName: string): Promise<void> {
    await this.git(repo, ['remote', 'rename', oldName, newName]);
    this.remoteCache.delete(repo);
  }

  async setRemoteUrl(repo: string, name: string, url: string, push: boolean): Promise<void> {
    await this.git(repo, ['remote', 'set-url', ...(push ? ['--push'] : []), name, url]);
    this.remoteCache.delete(repo);
  }

  async fetch(repo: string, o: FetchOptions): Promise<void> {
    const args = ['fetch', '--progress'];
    if (o.remote) args.push(o.remote, ...(o.branch ? [o.branch] : []));
    else args.push('--all');
    if (o.prune) args.push('--prune');
    if (o.tags) args.push('--tags');
    await this.git(repo, args, { progressId: o.opId, config: await this.remoteAuth(repo, o.remote) });
  }

  async pull(repo: string, o: PullOptions): Promise<void> {
    const args = ['pull', '--progress'];
    if (o.mode === 'rebase') args.push('--rebase');
    else if (o.mode === 'ff-only') args.push('--ff-only');
    else args.push('--no-rebase');
    if (o.autostash) args.push('--autostash');
    if (o.remote) args.push(o.remote);
    if (o.remote && o.branch) args.push(o.branch);
    await this.git(repo, args, { progressId: o.opId, env: this.noEditorEnv, config: await this.remoteAuth(repo, o.remote) });
  }

  async push(repo: string, o: PushOptions): Promise<void> {
    const args = ['push', '--progress'];
    if (o.force === 'with-lease') args.push('--force-with-lease');
    if (o.force === 'force') args.push('--force');
    if (o.tags) args.push('--tags');
    if (o.setUpstream) args.push('--set-upstream');
    if (o.noVerify) args.push('--no-verify');
    args.push(o.remote);
    if (o.branch) args.push(o.remoteBranch ? `${o.branch}:${o.remoteBranch}` : o.branch);
    await this.git(repo, args, { progressId: o.opId, config: await this.remoteAuth(repo, o.remote) });
  }

  async pruneRemote(repo: string, name: string): Promise<void> {
    await this.git(repo, ['remote', 'prune', name], { config: await this.remoteAuth(repo, name) });
  }

  /* ───────────── tags ───────────── */

  async tags(repo: string): Promise<Tag[]> {
    return parseTags(await this.git(repo, ['for-each-ref', `--format=${TAG_FORMAT}`, '--sort=-creatordate', 'refs/tags'], { silent: true }));
  }

  async createTag(repo: string, o: CreateTagOptions): Promise<void> {
    const args = ['tag'];
    if (o.force) args.push('-f');
    if (o.sign) args.push('-s');
    if (o.message) args.push('-a', '-m', o.message);
    args.push(o.name, o.ref);
    await this.git(repo, args);
  }

  async deleteTag(repo: string, name: string): Promise<void> {
    await this.git(repo, ['tag', '-d', name]);
  }

  async pushTag(repo: string, remote: string, name: string): Promise<void> {
    await this.git(repo, ['push', remote, `refs/tags/${name}`], { config: await this.remoteAuth(repo, remote) });
  }

  async deleteRemoteTag(repo: string, remote: string, name: string): Promise<void> {
    await this.git(repo, ['push', remote, '--delete', `refs/tags/${name}`], { config: await this.remoteAuth(repo, remote) });
  }

  /* ───────────── stash ───────────── */

  async stashes(repo: string): Promise<Stash[]> {
    return parseStashes(await this.git(repo, ['stash', 'list', `--format=${STASH_FORMAT}`], { silent: true }));
  }

  async stashSave(repo: string, o: StashOptions): Promise<void> {
    if (o.stageNew) {
      // Por defecto `git stash` ignora los archivos nuevos hasta que se preparan.
      const out = await this.git(repo, ['ls-files', '--others', '--exclude-standard', '-z', ...(o.paths?.length ? ['--', ...o.paths] : [])], { silent: true });
      const fresh = out.split('\0').filter(Boolean);
      if (fresh.length) await this.git(repo, ['add', '--', ...fresh]);
    }
    const args = ['stash', 'push'];
    if (o.includeUntracked) args.push('--include-untracked');
    if (o.keepIndex) args.push('--keep-index');
    if (o.staged) args.push('--staged');
    if (o.message) args.push('-m', o.message);
    if (o.paths?.length) args.push('--', ...o.paths);
    await this.git(repo, args);
  }

  async stashApply(repo: string, index: number, restoreIndex: boolean): Promise<void> {
    await this.git(repo, ['stash', 'apply', ...(restoreIndex ? ['--index'] : []), `stash@{${index}}`]);
  }

  async stashPop(repo: string, index: number): Promise<void> {
    await this.git(repo, ['stash', 'pop', `stash@{${index}}`]);
  }

  async stashDrop(repo: string, index: number): Promise<void> {
    await this.git(repo, ['stash', 'drop', `stash@{${index}}`]);
  }

  async stashClear(repo: string): Promise<void> {
    await this.git(repo, ['stash', 'clear']);
  }

  async stashBranch(repo: string, index: number, branch: string): Promise<void> {
    await this.git(repo, ['stash', 'branch', branch, `stash@{${index}}`]);
  }

  async stashDiff(repo: string, index: number): Promise<DiffFile[]> {
    const out = await this.git(repo, ['stash', 'show', '-p', '--include-untracked', '--no-ext-diff', `stash@{${index}}`], { silent: true })
      .catch(() => this.git(repo, ['stash', 'show', '-p', '--no-ext-diff', `stash@{${index}}`], { silent: true }));
    return parseDiff(out);
  }

  /* ───────────── submódulos y worktrees ───────────── */

  async submodules(repo: string): Promise<Submodule[]> {
    if (!existsSync(path.join(repo, '.gitmodules'))) return [];
    return parseSubmodules(await this.git(repo, ['submodule', 'status', '--recursive'], { silent: true }));
  }

  async submoduleAdd(repo: string, url: string, sub: string, branch: string | null): Promise<void> {
    await this.git(repo, ['submodule', 'add', ...(branch ? ['-b', branch] : []), '--', url, sub], { config: await this.auth(url) });
  }

  async submoduleUpdate(repo: string, init: boolean, recursive: boolean, remote: boolean): Promise<void> {
    const args = ['submodule', 'update', '--progress'];
    if (init) args.push('--init');
    if (recursive) args.push('--recursive');
    if (remote) args.push('--remote');
    await this.git(repo, args, { config: await this.remoteAuth(repo) });
  }

  async submoduleSync(repo: string): Promise<void> {
    await this.git(repo, ['submodule', 'sync', '--recursive']);
  }

  async submoduleDeinit(repo: string, sub: string, force: boolean): Promise<void> {
    await this.git(repo, ['submodule', 'deinit', ...(force ? ['-f'] : []), '--', sub]);
  }

  async worktrees(repo: string): Promise<Worktree[]> {
    return parseWorktrees(await this.git(repo, ['worktree', 'list', '--porcelain'], { silent: true }));
  }

  async worktreeAdd(repo: string, dir: string, branch: string, newBranch: boolean, startPoint?: string): Promise<void> {
    await this.git(repo, newBranch ? ['worktree', 'add', '-b', branch, dir, ...(startPoint ? [startPoint] : [])] : ['worktree', 'add', dir, branch]);
  }

  async worktreeRemove(repo: string, dir: string, force: boolean): Promise<void> {
    await this.git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  }

  async worktreePrune(repo: string): Promise<void> {
    await this.git(repo, ['worktree', 'prune']);
  }

  /* ───────────── Git Flow, estadísticas y benchmark ───────────── */

  private exec(repo: string): flow.Exec {
    return (args, opts) => this.git(repo, args, opts);
  }

  flowStatus(repo: string): Promise<GitFlowConfig | null> {
    return flow.flowStatus(this.exec(repo));
  }

  flowInit(repo: string, cfg: GitFlowConfig): Promise<void> {
    return flow.flowInit(this.exec(repo), cfg);
  }

  flowStart(repo: string, kind: GitFlowKind, name: string): Promise<string> {
    return flow.flowStart(this.exec(repo), kind, name);
  }

  flowDeinit(repo: string): Promise<void> {
    return flow.flowDeinit(this.exec(repo));
  }

  repoStats(repo: string): Promise<RepoStats> {
    return insights.repoStats(this.exec(repo));
  }

  fileSizes(repo: string): Promise<FileSize[]> {
    return insights.fileSizes(this.exec(repo));
  }

  benchmark(repo: string): Promise<BenchmarkResult[]> {
    return insights.benchmark(this.exec(repo));
  }

  /* ───────────── bisect ───────────── */

  async bisectStart(repo: string, bad: string, good: string): Promise<string> {
    return this.git(repo, ['bisect', 'start', bad, good]);
  }

  async bisectMark(repo: string, verdict: 'good' | 'bad' | 'skip'): Promise<string> {
    return this.git(repo, ['bisect', verdict]);
  }

  async bisectReset(repo: string): Promise<void> {
    await this.git(repo, ['bisect', 'reset']);
  }

  /* ───────────── LFS y mantenimiento ───────────── */

  async lfsInstalled(repo: string): Promise<boolean> {
    return this.git(repo, ['lfs', 'version'], { silent: true }).then(() => true).catch(() => false);
  }

  async lfsTrack(repo: string, pattern: string): Promise<void> {
    await this.git(repo, ['lfs', 'track', pattern]);
  }

  async lfsPull(repo: string): Promise<void> {
    await this.git(repo, ['lfs', 'pull'], { config: await this.remoteAuth(repo) });
  }

  async gc(repo: string, aggressive: boolean): Promise<void> {
    await this.git(repo, ['gc', ...(aggressive ? ['--aggressive'] : []), '--prune=now']);
  }

  async archive(repo: string, ref: string, output: string, format: 'zip' | 'tar.gz'): Promise<void> {
    await this.git(repo, ['archive', `--format=${format}`, '-o', output, ref]);
  }

  /* ───────────── consola ───────────── */

  async raw(repo: string, args: string[]): Promise<string> {
    if (!args.length) return '';
    if (args[0] === 'git') args = args.slice(1);
    return this.git(repo, args, { env: this.noEditorEnv, config: await this.remoteAuth(repo).catch(() => []), timeoutMs: 10 * 60_000 });
  }
}

function nullDevice(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}
