import { Component, computed, inject, signal } from '@angular/core';

import { I18n, TPipe } from '@core/i18n/i18n';
import { Branch, Stash, Submodule, Tag, Worktree } from '@core/models';
import { BridgeService, ContextMenuService, WorkspaceService } from '@core/services';
import { GitFlows } from '@features/actions';
import { Icon } from '@shared/components';

interface TreeNode {
  key: string;
  label: string;
  depth: number;
  folder: boolean;
  branch?: Branch;
}

type Section = 'branches' | 'remotes' | 'tags' | 'stashes' | 'submodules' | 'worktrees';

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-sidebar',
  host: { class: 'block h-full min-h-0' },
  templateUrl: './sidebar.html',
})
export class Sidebar {
  readonly ws = inject(WorkspaceService);
  private readonly menu = inject(ContextMenuService);
  private readonly i18n = inject(I18n);
  private readonly bridge = inject(BridgeService);
  readonly flows = inject(GitFlows);

  readonly store = computed(() => this.ws.active()!);
  readonly query = signal('');
  readonly collapsed = signal<Set<string>>(new Set(['tags', 'worktrees']));

  /** Color de carril de cada rama (el del commit al que apunta en el grafo). */
  readonly laneOf = computed(() => {
    const map = new Map<string, number>();
    const s = this.store();
    const graph = s.graph();
    s.commits().forEach((c, i) => {
      for (const r of c.refs)
        if ((r.type === 'branch' || r.type === 'remote') && !map.has(r.name))
          map.set(r.name, graph[i]?.color ?? 0);
    });
    return map;
  });

  private match(text: string) {
    const q = this.query().trim().toLowerCase();
    return !q || text.toLowerCase().includes(q);
  }

  readonly localTree = computed(() =>
    this.tree(
      this.store()
        .localBranches()
        .filter((b) => this.match(b.name)),
      'l',
      (b) => b.name,
    ),
  );

  readonly remoteGroups = computed(() =>
    this.store()
      .remotes()
      .map((r) => ({
        remote: r,
        nodes: this.tree(
          this.store()
            .remoteBranches()
            .filter((b) => b.remote === r.name && this.match(b.name)),
          `r:${r.name}`,
          (b) => b.name.slice(r.name.length + 1),
          1,
        ),
      })),
  );

  readonly tags = computed(() =>
    this.store()
      .tags()
      .filter((t) => this.match(t.name)),
  );
  readonly stashes = computed(() =>
    this.store()
      .stashes()
      .filter((s) => this.match(s.message)),
  );

  /** Convierte nombres con "/" en un árbol aplanado con carpetas plegables. */
  private tree(
    branches: Branch[],
    prefix: string,
    label: (b: Branch) => string,
    baseDepth = 0,
  ): TreeNode[] {
    const sorted = [...branches].sort((a, b) => label(a).localeCompare(label(b)));
    const nodes: TreeNode[] = [];
    const seen = new Set<string>();
    const collapsed = this.collapsed();
    for (const b of sorted) {
      const parts = label(b).split('/');
      let path = '';
      let hidden = false;
      for (let i = 0; i < parts.length - 1; i++) {
        path += parts[i] + '/';
        const key = `${prefix}:${path}`;
        if (!seen.has(key)) {
          seen.add(key);
          if (!hidden) nodes.push({ key, label: parts[i], depth: baseDepth + i, folder: true });
        }
        if (collapsed.has(key)) hidden = true;
      }
      if (!hidden)
        nodes.push({
          key: `${prefix}:${label(b)}`,
          label: parts[parts.length - 1],
          depth: baseDepth + parts.length - 1,
          folder: false,
          branch: b,
        });
    }
    return nodes;
  }

  toggle(key: string) {
    this.collapsed.update((set) => {
      const n = new Set(set);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  isOpen(key: string) {
    return !this.collapsed().has(key);
  }

  showChanges() {
    this.store().view.set('changes');
  }

  showHistory() {
    const s = this.store();
    s.view.set('history');
    if (s.filter().ref || s.filter().path) s.setFilter({ ref: null, path: null });
  }

  /** Clic en una rama: mostrar su historial y seleccionar su último commit. */
  showBranch(b: Branch) {
    const s = this.store();
    s.view.set('history');
    s.selectCommit(b.hash);
  }

  /* ───────── menús contextuales ───────── */

  branchMenu(e: MouseEvent, b: Branch) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    const current = s.status()?.head ?? '';
    const isRemote = !!b.remote;
    this.menu.open(e, [
      !b.current && {
        label: isRemote ? t('ctx.checkoutTracking') : `${t('ctx.checkout')} ${b.name}`,
        icon: 'switch',
        action: () => this.flows.checkout(s, b.name),
      },
      !b.current && {
        label: `${t('ctx.mergeInto')}: ${b.name} → ${current}`,
        icon: 'git-merge',
        action: () => this.flows.merge(s, b.name),
      },
      !b.current && {
        label: `${t('toolbar.rebase')} ${current} → ${b.name}`,
        icon: 'git-rebase',
        action: () => this.flows.rebase(s, b.name),
      },
      { separator: true },
      {
        label: t('ctx.createBranchHere'),
        icon: 'git-branch',
        action: () => this.flows.createBranch(s, b.name),
      },
      { label: t('ctx.createTagHere'), icon: 'tag', action: () => this.flows.createTag(s, b.name) },
      { separator: true },
      !isRemote && {
        label: t('ctx.pushBranch'),
        icon: 'push',
        action: () => this.flows.push(s, b.name),
      },
      !isRemote &&
        b.current && {
          label: t('ctx.pullBranch'),
          icon: 'pull',
          action: () => this.flows.quickPull(s),
        },
      !isRemote && {
        label: t('ctx.setUpstream'),
        icon: 'link',
        action: () => this.flows.setUpstream(s, b),
      },
      !isRemote &&
        s.remotes().length > 0 && {
          label: t('ctx.createPr'),
          icon: 'git-pull-request',
          action: () => this.flows.createPullRequest(s, b.name),
        },
      { separator: true },
      {
        label: t('commands.fileHistory').replace('…', ''),
        icon: 'clock',
        action: () => {
          s.view.set('history');
          s.setFilter({ ref: b.name, path: null });
        },
      },
      { label: t('ctx.copyHash'), icon: 'copy', action: () => this.flows.copy(b.name) },
      { separator: true },
      !isRemote && {
        label: t('ctx.renameBranch'),
        icon: 'edit',
        action: () => this.flows.renameBranch(s, b.name),
      },
      !isRemote &&
        !b.current && {
          label: t('ctx.deleteBranch'),
          icon: 'trash',
          danger: true,
          action: () => this.flows.deleteBranch(s, b),
        },
      isRemote && {
        label: t('ctx.deleteRemoteBranch'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.deleteRemoteBranch(s, b),
      },
    ]);
  }

  remoteMenu(e: MouseEvent, name: string) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    this.menu.open(e, [
      { label: t('ctx.fetchRemote'), icon: 'fetch', action: () => this.flows.quickFetch(s, name) },
      {
        label: t('ctx.pruneRemote'),
        icon: 'eraser',
        action: () => this.flows.pruneRemote(s, name),
      },
      {
        label: t('commands.pullRequests'),
        icon: 'git-pull-request',
        action: () => this.flows.pullRequests(s),
      },
      { separator: true },
      { label: t('ctx.editRemote'), icon: 'edit', action: () => this.flows.editRemote(s, name) },
      { label: t('ctx.renameRemote'), action: () => this.flows.renameRemote(s, name) },
      {
        label: t('ctx.removeRemote'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.removeRemote(s, name),
      },
    ]);
  }

  tagMenu(e: MouseEvent, tag: Tag) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    this.menu.open(e, [
      {
        label: `${t('ctx.checkout')} ${tag.name}`,
        icon: 'switch',
        action: () => this.flows.checkoutCommit(s, tag.name),
      },
      {
        label: t('ctx.createBranchHere'),
        icon: 'git-branch',
        action: () => this.flows.createBranch(s, tag.name),
      },
      { separator: true },
      s.remotes().length > 0 && {
        label: t('ctx.pushTag'),
        icon: 'push',
        action: () => this.flows.pushTag(s, tag),
      },
      { label: t('ctx.copyHash'), icon: 'copy', action: () => this.flows.copy(tag.name) },
      { separator: true },
      {
        label: t('ctx.deleteTag'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.deleteTag(s, tag),
      },
      s.remotes().length > 0 && {
        label: t('ctx.deleteRemoteTag'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.deleteRemoteTag(s, tag),
      },
    ]);
  }

  stashMenu(e: MouseEvent, st: Stash) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    this.menu.open(e, [
      {
        label: t('ctx.applyStash'),
        icon: 'unarchive',
        action: () => this.flows.stashApply(s, st.index),
      },
      {
        label: t('ctx.popStash'),
        icon: 'unarchive',
        action: () => this.flows.stashPop(s, st.index),
      },
      {
        label: t('ctx.branchFromStash'),
        icon: 'git-branch',
        action: () => this.flows.stashBranch(s, st),
      },
      { separator: true },
      {
        label: t('ctx.dropStash'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.stashDrop(s, st),
      },
    ]);
  }

  submoduleMenu(e: MouseEvent, sm: Submodule) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    this.menu.open(e, [
      {
        label: t('ctx.openSubmodule'),
        icon: 'external',
        action: () => this.ws.open(`${s.path()}/${sm.path}`),
      },
      {
        label: t('ctx.updateSubmodule'),
        icon: 'refresh',
        action: () => this.flows.updateSubmodules(s),
      },
      {
        label: t('ctx.deinitSubmodule'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.deinitSubmodule(s, sm.path),
      },
    ]);
  }

  worktreeMenu(e: MouseEvent, w: Worktree) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    this.menu.open(e, [
      { label: t('ctx.openWorktree'), icon: 'external', action: () => this.ws.open(w.path) },
      {
        label: t('commands.showInFolder'),
        icon: 'folder',
        action: () => this.bridge.app('showInFolder', w.path),
      },
      !w.main && {
        label: t('ctx.removeWorktree'),
        icon: 'trash',
        danger: true,
        action: () => this.flows.removeWorktree(s, w.path),
      },
    ]);
  }

  sectionMenu(e: MouseEvent, section: Section) {
    const s = this.store();
    const t = (k: string) => this.i18n.t(k);
    const items = {
      branches: [
        {
          label: t('commands.createBranch'),
          icon: 'plus',
          action: () => this.flows.createBranch(s),
        },
      ],
      remotes: [
        { label: t('commands.addRemote'), icon: 'plus', action: () => this.flows.addRemote(s) },
        { label: t('commands.fetchAll'), icon: 'fetch', action: () => this.flows.quickFetch(s) },
      ],
      tags: [
        { label: t('commands.createTag'), icon: 'plus', action: () => this.flows.createTag(s) },
        { label: t('commands.pushTags'), icon: 'push', action: () => this.flows.pushAllTags(s) },
      ],
      stashes: [
        { label: t('commands.stashSave'), icon: 'plus', action: () => this.flows.stash(s) },
        {
          label: t('commands.stashClear'),
          icon: 'trash',
          danger: true,
          action: () => this.flows.stashClear(s),
        },
      ],
      submodules: [
        {
          label: t('commands.addSubmodule'),
          icon: 'plus',
          action: () => this.flows.addSubmodule(s),
        },
        {
          label: t('commands.updateSubmodules'),
          icon: 'refresh',
          action: () => this.flows.updateSubmodules(s),
        },
      ],
      worktrees: [
        { label: t('commands.addWorktree'), icon: 'plus', action: () => this.flows.addWorktree(s) },
        {
          label: t('commands.pruneWorktrees'),
          icon: 'eraser',
          action: () => this.flows.pruneWorktrees(s),
        },
      ],
    }[section];
    this.menu.open(e, items);
  }
}
