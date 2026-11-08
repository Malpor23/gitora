import { computed, signal } from '@angular/core';

import { computeGraph } from '@core/graph';
import { I18n } from '@core/i18n';
import {
  Branch,
  Commit,
  Remote,
  RepoInfo,
  RepoStatus,
  Submodule,
  Stash,
  Tag,
  Worktree,
  LogOptions,
} from '@core/models';
import { BridgeService, NotifyService } from '@core/services';

export type RepoView = 'changes' | 'history';

export interface SelectedFile {
  path: string;
  staged: boolean;
  conflicted?: boolean;
}

export interface LogFilter {
  all: boolean;
  search: string;
  author: string;
  path: string | null;
  ref: string | null;
  firstParent: boolean;
}

const PAGE = 400;

export class RepositoryStore {
  readonly info = signal<RepoInfo>({ path: '', name: '', gitDir: '', bare: false });
  readonly path = computed(() => this.info().path);
  readonly name = computed(() => this.info().name);

  readonly status = signal<RepoStatus | null>(null);
  readonly commits = signal<Commit[]>([]);
  readonly hasMore = signal(false);
  readonly branches = signal<Branch[]>([]);
  readonly tags = signal<Tag[]>([]);
  readonly remotes = signal<Remote[]>([]);
  readonly stashes = signal<Stash[]>([]);
  readonly submodules = signal<Submodule[]>([]);
  readonly worktrees = signal<Worktree[]>([]);

  readonly view = signal<RepoView>('history');
  readonly selectedHashes = signal<string[]>([]);
  readonly selectedFile = signal<SelectedFile | null>(null);
  readonly filter = signal<LogFilter>({
    all: true,
    search: '',
    author: '',
    path: null,
    ref: null,
    firstParent: false,
  });
  readonly busy = signal<string | null>(null);
  readonly loadingLog = signal(false);

  readonly graph = computed(() => computeGraph(this.commits()));
  readonly localBranches = computed(() => this.branches().filter((b) => !b.remote));
  readonly remoteBranches = computed(() => this.branches().filter((b) => b.remote));
  readonly currentBranch = computed(
    () => this.branches().find((b) => b.current && !b.remote) ?? null,
  );
  readonly changeCount = computed(() => {
    const s = this.status();
    if (!s) return 0;
    const paths = new Set([...s.staged, ...s.unstaged, ...s.conflicted].map((f) => f.path));
    return paths.size;
  });
  readonly operation = computed(() => this.status()?.state ?? 'clean');
  readonly selectedHash = computed(() => this.selectedHashes()[0] ?? null);

  private refreshing: Promise<void> | null = null;
  private pending = false;

  constructor(
    initial: RepoInfo,
    private readonly bridge: BridgeService,
    private readonly notify: NotifyService,
    private readonly i18n: I18n,
  ) {
    this.info.set(initial);
  }

  /** Refresca estado y referencias; si llegan varias peticiones juntas se agrupan. */
  async refresh(full = true): Promise<void> {
    if (this.refreshing) {
      this.pending = true;
      return this.refreshing;
    }
    this.refreshing = this.doRefresh(full).finally(() => {
      this.refreshing = null;
      if (this.pending) {
        this.pending = false;
        void this.refresh(full);
      }
    });
    return this.refreshing;
  }

  private async doRefresh(full: boolean) {
    const repo = this.path();
    try {
      const status = await this.bridge.git('status', repo);
      this.status.set(status);
      if (!full) return;
      const [branches, tags, remotes, stashes, submodules, worktrees] = await Promise.all([
        this.bridge.git('branches', repo),
        this.bridge.git('tags', repo),
        this.bridge.git('remotes', repo),
        this.bridge.git('stashes', repo),
        this.bridge.git('submodules', repo).catch(() => [] as Submodule[]),
        this.bridge.git('worktrees', repo).catch(() => [] as Worktree[]),
      ]);
      this.branches.set(branches);
      this.tags.set(tags);
      this.remotes.set(remotes);
      this.stashes.set(stashes);
      this.submodules.set(submodules);
      this.worktrees.set(worktrees);
      await this.loadLog(false);
      this.validateSelection();
    } catch (e) {
      this.notify.error(e);
    }
  }

  private logOptions(skip: number): LogOptions {
    const f = this.filter();
    // `autor:nombre` (o `author:nombre`) busca por autor; git no puede combinar mensaje O autor en una sola consulta
    const byAuthor = /^(?:autor|author):\s*(.+)$/i.exec(f.search.trim());
    const search = byAuthor ? '' : f.search.trim();
    const isHash = /^[0-9a-f]{7,40}$/i.test(search);
    return {
      limit: PAGE,
      skip,
      all: f.all && !f.ref && !f.path,
      ref: f.ref ?? undefined,
      search: search && !isHash ? search : undefined,
      hash: isHash ? search : undefined,
      author: byAuthor?.[1].trim() || f.author || undefined,
      path: f.path ?? undefined,
      firstParent: f.firstParent,
    };
  }

  async loadLog(append: boolean) {
    this.loadingLog.set(true);
    try {
      const skip = append ? this.commits().length : 0;
      const page = await this.bridge.git('log', this.path(), this.logOptions(skip));
      this.commits.set(append ? [...this.commits(), ...page] : page);
      this.hasMore.set(page.length === PAGE);
    } catch (e) {
      this.notify.error(e);
    } finally {
      this.loadingLog.set(false);
    }
  }

  setFilter(patch: Partial<LogFilter>) {
    this.filter.update((f) => ({ ...f, ...patch }));
    void this.loadLog(false);
  }

  selectCommit(hash: string, additive = false) {
    this.view.set('history');
    this.selectedHashes.update((sel) =>
      additive ? (sel.includes(hash) ? sel.filter((h) => h !== hash) : [...sel, hash]) : [hash],
    );
  }

  private validateSelection() {
    const sel = this.selectedFile();
    const s = this.status();
    if (sel && s) {
      const list = sel.conflicted ? s.conflicted : sel.staged ? s.staged : s.unstaged;
      if (!list.some((f) => f.path === sel.path)) {
        // Si pasó a la otra lista (p. ej. tras hacer stage) la seguimos
        const other = sel.staged ? s.unstaged : s.staged;
        this.selectedFile.set(
          other.some((f) => f.path === sel.path) ? { path: sel.path, staged: !sel.staged } : null,
        );
      }
    }
  }

  /**
   * Ejecuta una operación con manejo uniforme: estado ocupado, aviso de éxito,
   * detección de conflictos y refresco al terminar.
   */
  async run<T>(
    task: () => Promise<T>,
    opts: {
      busy?: string;
      success?: string;
      successParams?: Record<string, string | number>;
      refresh?: boolean;
      silentError?: boolean;
    } = {},
  ): Promise<T | undefined> {
    if (opts.busy) this.busy.set(this.i18n.t(opts.busy));
    try {
      const result = await task();
      if (opts.success) this.notify.success(opts.success, opts.successParams);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/conflict/i.test(msg)) {
        this.notify.info(this.i18n.t('toast.conflicts'));
        this.view.set('changes');
      } else if (!opts.silentError) {
        this.notify.error(e);
      }
      if (opts.silentError) throw e;
      return undefined;
    } finally {
      this.busy.set(null);
      if (opts.refresh !== false) await this.refresh();
    }
  }
}
