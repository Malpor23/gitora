import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { I18n, RelTimePipe, TPipe } from '@core/i18n/i18n';
import { Icon } from '@shared/components';
import { GraphCell, LANE_W, ROW_H } from '../graph-cell/graph-cell';

/** Ancho mínimo (px) de la columna del grafo: cabe la etiqueta «Grafo». */
const MIN_GRAPH_COL = 48;
import { DiffViewer } from '@features/diff-viewer';
import {
  BridgeService,
  ContextMenuService,
  NotifyService,
  SettingsService,
  WorkspaceService,
} from '@core/services';
import { GitFlows } from '@features/actions';
import { Commit, CommitDetails, DiffFile, FileChange } from '@core/models';
import { authorHue, initials } from '@shared/utils/avatar';

const OVERSCAN = 12;

@Component({
  imports: [TPipe, RelTimePipe, Icon, GraphCell, DiffViewer],
  selector: 'gt-viewer',
  host: { class: 'block h-full min-h-0' },
  templateUrl: './viewer.html',
})
export class Viewer {
  private readonly ws = inject(WorkspaceService);
  private readonly bridge = inject(BridgeService);
  private readonly menu = inject(ContextMenuService);
  private readonly notify = inject(NotifyService);
  private readonly i18n = inject(I18n);
  readonly flows = inject(GitFlows);
  readonly settings = inject(SettingsService);

  readonly store = computed(() => this.ws.active()!);
  readonly rowH = ROW_H;
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');
  readonly scrollTop = signal(0);
  readonly viewport = signal(600);
  readonly searchText = signal('');

  readonly details = signal<CommitDetails | null>(null);
  readonly selectedFile = signal<FileChange | null>(null);
  readonly fileDiff = signal<DiffFile | null>(null);

  readonly maxLanes = computed(() =>
    Math.min(
      this.store()
        .graph()
        .reduce((m, r) => Math.max(m, r.width), 1),
      18,
    ),
  );

  /** Ancho de la columna del grafo: mínimo para que quepa la cabecera, igual en cabecera y filas. */
  readonly graphColWidth = computed(() => Math.max(this.maxLanes() * LANE_W + 6, MIN_GRAPH_COL));
  readonly headHash = computed(() => this.store().status()?.oid ?? null);
  readonly window = computed(() => {
    const commits = this.store().commits();
    const start = Math.max(0, Math.floor(this.scrollTop() / ROW_H) - OVERSCAN);
    const end = Math.min(
      commits.length,
      Math.ceil((this.scrollTop() + this.viewport()) / ROW_H) + OVERSCAN,
    );
    return { start, end, items: commits.slice(start, end) };
  });

  constructor() {
    // Detalle del commit seleccionado
    effect(() => {
      const s = this.store();
      const hash = s.selectedHash();
      this.selectedFile.set(null);
      this.fileDiff.set(null);
      if (!hash) {
        this.details.set(null);
        return;
      }
      void this.bridge
        .git('show', s.path(), hash)
        .then((d) => {
          this.details.set(d);
          if (d.files.length) this.openFile(d.files[0]);
        })
        .catch((e) => this.notify.error(e));
    });

    effect(() => this.searchText.set(this.store().filter().search));

    const focusSearch = () => this.searchInput()?.nativeElement.focus();
    window.addEventListener('gitora:search', focusSearch);
    const ro = new ResizeObserver(() => {
      const el = this.scroller()?.nativeElement;
      if (el) this.viewport.set(el.clientHeight);
    });
    effect(() => {
      const el = this.scroller()?.nativeElement;
      if (el) ro.observe(el);
    });
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('gitora:search', focusSearch);
      ro.disconnect();
    });
  }

  onScroll(e: Event) {
    const el = e.target as HTMLElement;
    this.scrollTop.set(el.scrollTop);
    const s = this.store();
    if (
      s.hasMore() &&
      !s.loadingLog() &&
      el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 20
    ) {
      void s.loadLog(true);
    }
  }

  onSearch(value: string) {
    this.searchText.set(value);
  }

  submitSearch() {
    this.store().setFilter({ search: this.searchText() });
  }

  select(e: MouseEvent, c: Commit) {
    this.store().selectCommit(c.hash, e.ctrlKey || e.metaKey);
  }

  /** Navegación con flechas en la lista */
  onKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const s = this.store();
    const commits = s.commits();
    const idx = commits.findIndex((c) => c.hash === s.selectedHash());
    const next = Math.min(commits.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    if (commits[next]) {
      s.selectCommit(commits[next].hash);
      const el = this.scroller()?.nativeElement;
      if (el) {
        const top = next * ROW_H;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_H > el.scrollTop + el.clientHeight)
          el.scrollTop = top + ROW_H - el.clientHeight;
      }
    }
  }

  openFile(f: FileChange) {
    const s = this.store();
    const d = this.details();
    if (!d) return;
    this.selectedFile.set(f);
    const settings = this.settings.settings();
    void this.bridge
      .git(
        'diffCommit',
        s.path(),
        d.hash,
        f.path,
        settings?.diffContext ?? 3,
        settings?.ignoreWhitespace ?? false,
      )
      .then((files) =>
        this.fileDiff.set(
          files.find((x) => x.newPath === f.path || x.oldPath === f.path) ?? files[0] ?? null,
        ),
      )
      .catch((e) => this.notify.error(e));
  }

  /** Etiquetas de ramas: el borde usa el color del carril, así la rama se reconoce en el grafo. */
  refClass(type: string, current?: boolean) {
    const lane = 'var(--lane,var(--line))';
    if (current) return 'bg-[var(--lane,var(--accent))] text-on-lane border-transparent';
    const tint = 'bg-[color-mix(in_srgb,var(--lane,var(--line))_16%,transparent)]';
    switch (type) {
      case 'remote':
        return `border-dashed border-[color:${lane}] text-muted ${tint}`;
      case 'tag':
        return 'border-tag text-fg bg-[color-mix(in_srgb,var(--tag)_16%,transparent)]';
      case 'stash':
      case 'head':
        return `border-faint text-fg ${tint}`;
      default:
        return `border-[color:${lane}] text-fg ${tint}`;
    }
  }

  kindClass(kind: string) {
    switch (kind) {
      case 'added':
        return 'bg-st-added';
      case 'modified':
      case 'typechange':
        return 'bg-st-modified';
      case 'deleted':
        return 'bg-st-deleted';
      case 'renamed':
      case 'copied':
        return 'bg-st-renamed';
      default:
        return '';
    }
  }

  readonly initials = initials;
  /** Color estable por autor para el avatar de iniciales. */
  readonly authorHue = authorHue;

  openMenu(e: MouseEvent, c: Commit) {
    const s = this.store();
    if (!s.selectedHashes().includes(c.hash)) s.selectCommit(c.hash);
    // Orden del historial (más nuevo primero), no el orden de clic: cherry-pick, revert y parche dependen de él
    const picked = new Set(s.selectedHashes());
    const inLog = s.commits().map((x) => x.hash).filter((h) => picked.has(h));
    const selected = inLog.length === picked.size ? inLog : s.selectedHashes();
    const multi = selected.length > 1;
    const t = (k: string) => this.i18n.t(k);
    const branchRefs = c.refs.filter((r) => r.type === 'branch' && !r.current);
    const remoteRefs = c.refs.filter((r) => r.type === 'remote');
    const current = s.status()?.head ?? 'HEAD';
    this.menu.open(e, [
      ...branchRefs.map((r) => ({
        label: `${t('ctx.checkout')} ${r.name}`,
        icon: 'switch',
        action: () => this.flows.checkout(s, r.name),
      })),
      ...remoteRefs
        .slice(0, 2)
        .map((r) => ({
          label: `${t('ctx.checkout')} ${r.name}`,
          icon: 'switch',
          action: () => this.flows.checkout(s, r.name),
        })),
      !multi && {
        label: t('ctx.checkoutCommit'),
        icon: 'git-commit',
        action: () => this.flows.checkoutCommit(s, c.hash),
      },
      { separator: true },
      !multi && {
        label: t('ctx.createBranchHere'),
        icon: 'git-branch',
        action: () => this.flows.createBranch(s, c.hash),
      },
      !multi && {
        label: t('ctx.createTagHere'),
        icon: 'tag',
        action: () => this.flows.createTag(s, c.hash),
      },
      { separator: true },
      ...branchRefs
        .slice(0, 1)
        .map((r) => ({
          label: `${t('ctx.mergeInto')}: ${r.name} → ${current}`,
          icon: 'git-merge',
          action: () => this.flows.merge(s, r.name),
        })),
      !multi && {
        label: t('ctx.rebaseOnto'),
        icon: 'git-rebase',
        action: () => this.flows.rebase(s, branchRefs[0]?.name ?? c.hash),
      },
      !multi && {
        label: t('ctx.interactiveRebase'),
        icon: 'list',
        action: () => this.flows.interactiveRebase(s, c.parents[0] ?? '--root'),
      },
      {
        label: t('ctx.cherryPick'),
        icon: 'cherry',
        action: () => this.flows.cherryPick(s, [...selected].reverse()),
      },
      { label: t('ctx.revert'), icon: 'undo', action: () => this.flows.revert(s, selected) },
      !multi && {
        label: t('ctx.resetTo'),
        icon: 'rewind',
        danger: true,
        action: () => this.flows.reset(s, c.hash),
      },
      { separator: true },
      { label: t('ctx.copyHash'), icon: 'copy', action: () => this.flows.copy(selected.join(' ')) },
      !multi && {
        label: t('ctx.copyMessage'),
        action: () => this.flows.copy(c.body ? `${c.subject}\n\n${c.body}` : c.subject),
      },
      { label: t('ctx.savePatch'), icon: 'file', action: () => this.flows.savePatch(s, selected) },
      !multi &&
        s.remotes().length > 0 && {
          label: t('ctx.openInBrowser'),
          icon: 'external',
          action: () => this.flows.openCommitInBrowser(s, c),
        },
    ]);
  }

  openFileMenu(e: MouseEvent, f: FileChange) {
    const s = this.store();
    const d = this.details();
    if (!d) return;
    const t = (k: string) => this.i18n.t(k);
    this.menu.open(e, [
      {
        label: t('changes.fileHistory'),
        icon: 'clock',
        action: () => this.flows.fileHistory(s, f.path),
      },
      f.kind !== 'deleted' && {
        label: t('changes.blame'),
        icon: 'user',
        action: () => this.flows.blame(s, f.path, d.hash),
      },
      f.kind !== 'deleted' && {
        label: `${t('ctx.checkout')} (${d.shortHash})`,
        icon: 'switch',
        action: () => s.run(() => this.bridge.git('checkoutFiles', s.path(), d.hash, [f.path])),
      },
      { label: t('changes.copyPath'), icon: 'copy', action: () => this.flows.copy(f.path) },
    ]);
  }

  letter(f: FileChange) {
    return {
      added: 'A',
      modified: 'M',
      deleted: 'D',
      renamed: 'R',
      copied: 'C',
      untracked: 'U',
      conflicted: '!',
      typechange: 'T',
      ignored: 'I',
    }[f.kind];
  }

  setDiffMode(mode: 'unified' | 'split') {
    void this.settings.update({ diffViewMode: mode });
  }
}
