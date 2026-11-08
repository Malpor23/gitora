import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { I18n, TPipe } from '@core/i18n/i18n';
import { DiffFile, FileChange } from '@core/models';
import {
  BridgeService,
  ContextMenuService,
  DialogService,
  MenuItem,
  NotifyService,
  SettingsService,
  WorkspaceService,
} from '@core/services';
import { GitFlows } from '@features/actions';
import { DiffViewer, HunkActionEvent } from '@features/diff-viewer';
import { Icon } from '@shared/components';
import { buildHunkPatch } from '../../../../shared/patch';

type ListKind = 'unstaged' | 'staged' | 'conflicted';

@Component({
  imports: [FormsModule, NgTemplateOutlet, TPipe, Icon, DiffViewer],
  selector: 'gt-changes',
  host: { class: 'block h-full min-h-0' },
  templateUrl: './changes.html',
})
export class Changes {
  private readonly ws = inject(WorkspaceService);
  private readonly bridge = inject(BridgeService);
  readonly flows = inject(GitFlows);
  private readonly dialogs = inject(DialogService);
  private readonly menu = inject(ContextMenuService);
  private readonly notify = inject(NotifyService);
  private readonly i18n = inject(I18n);
  readonly settings = inject(SettingsService);

  readonly store = computed(() => this.ws.active()!);
  readonly status = computed(() => this.store().status());
  readonly diff = signal<DiffFile | null>(null);
  readonly multi = signal<Set<string>>(new Set());

  // Caja de commit
  readonly subject = signal('');
  readonly body = signal('');
  readonly amend = signal(false);
  readonly signoff = signal(false);
  readonly noVerify = signal(false);
  readonly committing = signal(false);

  readonly stagedCount = computed(() => this.status()?.staged.length ?? 0);
  readonly canCommit = computed(
    () => !!this.subject().trim() && (this.stagedCount() > 0 || this.amend()) && !this.committing(),
  );

  constructor() {
    // Cargar el diff cuando cambia la selección o el estado del repo
    effect(() => {
      const s = this.store();
      const sel = s.selectedFile();
      s.status();
      const settings = this.settings.settings();
      if (!sel) {
        this.diff.set(null);
        return;
      }
      void this.bridge
        .git(
          'diffWorking',
          s.path(),
          sel.path,
          sel.staged,
          settings?.diffContext ?? 3,
          settings?.ignoreWhitespace ?? false,
        )
        .then((d) => this.diff.set(d))
        .catch((e) => this.notify.error(e));
    });

    // Al activar "Enmendar" se recupera el mensaje del último commit
    effect(() => {
      if (this.amend() && !this.subject()) {
        void this.bridge.git('lastCommitMessage', this.store().path()).then((m) => {
          const [first, ...rest] = m.split('\n');
          this.subject.set(first);
          this.body.set(rest.join('\n').trim());
        });
      }
    });

    const onAmend = () => this.amend.set(true);
    window.addEventListener('gitora:amend', onAmend);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('gitora:amend', onAmend));
  }

  kindLabel(f: FileChange) {
    return this.i18n.t(`changes.kind.${f.kind}`);
  }

  letter(f: FileChange): string {
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

  split(path: string) {
    const i = path.lastIndexOf('/');
    return i === -1
      ? { dir: '', name: path }
      : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
  }

  key(kind: ListKind, path: string) {
    return `${kind}:${path}`;
  }

  isSelected(kind: ListKind, path: string): boolean {
    const sel = this.store().selectedFile();
    return (
      this.multi().has(this.key(kind, path)) ||
      (!!sel &&
        sel.path === path &&
        (kind === 'conflicted'
          ? !!sel.conflicted
          : sel.staged === (kind === 'staged') && !sel.conflicted))
    );
  }

  select(e: MouseEvent, kind: ListKind, f: FileChange) {
    const k = this.key(kind, f.path);
    if (e.ctrlKey || e.metaKey) {
      this.multi.update((m) => {
        const n = new Set(m);
        if (n.has(k)) n.delete(k);
        else n.add(k);
        return n;
      });
      return;
    }
    this.multi.set(new Set());
    this.store().selectedFile.set({
      path: f.path,
      staged: kind === 'staged',
      conflicted: kind === 'conflicted',
    });
  }

  private targets(kind: ListKind, f: FileChange): string[] {
    const sel = [...this.multi()]
      .filter((k) => k.startsWith(kind + ':'))
      .map((k) => k.slice(kind.length + 1));
    return sel.includes(f.path) ? sel : [f.path];
  }

  async stage(paths: string[]) {
    const s = this.store();
    await s.run(() => this.bridge.git('stage', s.path(), paths));
    this.multi.set(new Set());
  }

  async unstage(paths: string[]) {
    const s = this.store();
    await s.run(() => this.bridge.git('unstage', s.path(), paths));
    this.multi.set(new Set());
  }

  onDblClick(kind: ListKind, f: FileChange) {
    if (kind === 'unstaged') void this.stage([f.path]);
    else if (kind === 'staged') void this.unstage([f.path]);
    else void this.flows.resolveConflict(this.store(), f.path);
  }

  async onHunk(e: HunkActionEvent) {
    const s = this.store();
    const d = this.diff();
    if (!d) return;
    if (e.mode === 'discard' && !(await this.confirmDiscardPart())) return;
    // unstage (-R sobre el índice) y descartar (-R sobre el árbol de trabajo) comparten la forma del parche: las líneas '+' no seleccionadas siguen presentes y deben quedar como contexto
    const direction = e.mode === 'stage' ? 'forward' : 'reverse';
    const patch = buildHunkPatch(d, e.hunkIndex, e.lines, direction);
    // Un archivo sin seguimiento se añade completo (git apply --cached necesita que exista en el índice)
    const sel = s.selectedFile();
    const untracked = s.status()?.unstaged.find((f) => f.path === sel?.path)?.kind === 'untracked';
    if (untracked && e.mode === 'stage' && e.lines === null) {
      await this.stage([d.newPath]);
      return;
    }
    if (untracked && e.mode === 'stage') {
      await s.run(async () => {
        await this.bridge.git('raw', s.path(), ['add', '-N', '--', d.newPath]);
        const fresh = await this.bridge.git(
          'diffWorking',
          s.path(),
          d.newPath,
          false,
          this.settings.value.diffContext,
          false,
        );
        if (fresh)
          await this.bridge.git(
            'applyPatch',
            s.path(),
            buildHunkPatch(fresh, e.hunkIndex, e.lines, 'forward'),
            'stage',
          );
      });
      return;
    }
    await s.run(() => this.bridge.git('applyPatch', s.path(), patch, e.mode));
  }

  private confirmDiscardPart() {
    return this.dialogs.confirm(this.i18n.t('changes.confirmDiscard', { n: 1 }), {
      danger: true,
      confirmLabel: this.i18n.t('changes.discard'),
    });
  }

  openMenu(e: MouseEvent, kind: ListKind, f: FileChange) {
    const s = this.store();
    const paths = this.targets(kind, f);
    const abs = `${s.path()}/${f.path}`;
    const ext = /\.([^./]+)$/.exec(f.path)?.[1];
    const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : null;
    const t = (k: string, p?: Record<string, string | number>) => this.i18n.t(k, p);
    const items: (MenuItem | false)[] = [
      kind === 'unstaged' && {
        label: t('changes.stage'),
        icon: 'plus',
        action: () => this.stage(paths),
      },
      kind === 'staged' && {
        label: t('changes.unstage'),
        icon: 'minus',
        action: () => this.unstage(paths),
      },
      kind === 'conflicted' && {
        label: t('changes.resolveEditor'),
        icon: 'edit',
        action: () => this.flows.resolveConflict(s, f.path),
      },
      kind === 'conflicted' && {
        label: t('changes.resolveOurs'),
        action: () => s.run(() => this.bridge.git('resolveWith', s.path(), f.path, 'ours')),
      },
      kind === 'conflicted' && {
        label: t('changes.resolveTheirs'),
        action: () => s.run(() => this.bridge.git('resolveWith', s.path(), f.path, 'theirs')),
      },
      kind === 'conflicted' && {
        label: t('changes.markResolved'),
        icon: 'check',
        action: () => s.run(() => this.bridge.git('markResolved', s.path(), paths)),
      },
      kind === 'conflicted' && {
        label: t('changes.openMergeTool'),
        action: () =>
          s.run(() =>
            this.bridge.git('mergetool', s.path(), f.path, this.settings.value.externalMergeTool),
          ),
      },
      kind !== 'staged' && {
        label: t('changes.discard'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.discard(s, paths),
      },
      { label: t('changes.stashFiles'), icon: 'archive', action: () => this.flows.stash(s, paths) },
      { separator: true },
      {
        label: t('changes.openFile'),
        icon: 'external',
        action: () => this.bridge.app('openInEditor', abs),
      },
      {
        label: t('changes.showInFolder'),
        icon: 'folder',
        action: () => this.bridge.app('showInFolder', abs),
      },
      { label: t('changes.copyPath'), icon: 'copy', action: () => this.flows.copy(f.path) },
      { separator: true },
      f.kind === 'untracked' && {
        label: t('changes.ignore'),
        action: () => this.flows.ignore(s, f.path),
      },
      f.kind === 'untracked' &&
        !!ext && {
          label: t('changes.ignoreExt', { ext: ext! }),
          action: () => this.flows.ignore(s, `*.${ext}`),
        },
      f.kind === 'untracked' &&
        !!folder && {
          label: t('changes.ignoreFolder', { folder: folder! }),
          action: () => this.flows.ignore(s, folder!),
        },
      f.kind !== 'untracked' &&
        f.kind !== 'added' && {
          label: t('changes.fileHistory'),
          icon: 'clock',
          action: () => this.flows.fileHistory(s, f.path),
        },
      f.kind !== 'untracked' &&
        f.kind !== 'added' && {
          label: t('changes.blame'),
          icon: 'user',
          action: () => this.flows.blame(s, f.path),
        },
    ];
    this.menu.open(e, items);
  }

  async commit(push = false) {
    if (!this.canCommit()) return;
    const s = this.store();
    const message = this.body().trim()
      ? `${this.subject().trim()}\n\n${this.body().trim()}`
      : this.subject().trim();
    this.committing.set(true);
    const hash = await s.run(() =>
      this.bridge.git('commit', s.path(), {
        message,
        amend: this.amend(),
        signoff: this.signoff(),
        noVerify: this.noVerify(),
      }),
    );
    this.committing.set(false);
    if (hash) {
      this.notify.success('changes.committed', { hash: hash.slice(0, 8) });
      this.subject.set('');
      this.body.set('');
      this.amend.set(false);
      if (push) await this.flows.quickPush(s);
    }
  }

  onCommitKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this.commit(e.shiftKey);
    }
  }

  setDiffMode(mode: 'unified' | 'split') {
    void this.settings.update({ diffViewMode: mode });
  }
}
