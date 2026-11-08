import { inject, Service } from '@angular/core';

import { I18n } from '@core/i18n';
import { BridgeService, MenuItem, SettingsService, WorkspaceService } from '@core/services';
import { RepositoryStore } from '@core/store';
import { GitFlows } from '@features/actions/git-flows.service';

export type CommandCategory =
  | 'repository'
  | 'changes'
  | 'commit'
  | 'branch'
  | 'merge'
  | 'remote'
  | 'tag'
  | 'stash'
  | 'submodule'
  | 'flow'
  | 'history'
  | 'tools'
  | 'view'
  | 'platform';

export interface Command {
  id: string;
  category: CommandCategory;
  label: string; // clave i18n (commands.*)
  icon: string;
  shortcut?: string; // "Ctrl+Shift+P" (en Mac se muestra igual; Ctrl = Cmd)
  git?: string; // comando git equivalente, para buscar y como pista
  needsRepo?: boolean;
  when?: (s: RepositoryStore) => boolean;
  run: (s: RepositoryStore | null) => unknown;
}

@Service()
export class Commands {
  private readonly flows = inject(GitFlows);
  private readonly ws = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly bridge = inject(BridgeService);
  private readonly i18n = inject(I18n);

  readonly all: Command[] = this.build();

  private build(): Command[] {
    const f = this.flows;
    const r = (fn: (s: RepositoryStore) => unknown) => (s: RepositoryStore | null) =>
      s ? fn(s) : undefined;
    const inOp = (s: RepositoryStore) => s.operation() !== 'clean';

    return [
      // Repositorio
      {
        id: 'repo.open',
        category: 'repository',
        label: 'commands.openRepo',
        icon: 'folder-open',
        shortcut: 'Ctrl+O',
        run: () => f.openRepo(),
      },
      {
        id: 'repo.clone',
        category: 'repository',
        label: 'commands.cloneRepo',
        icon: 'download',
        git: 'git clone',
        run: () => f.cloneRepo(),
      },
      {
        id: 'repo.init',
        category: 'repository',
        label: 'commands.initRepo',
        icon: 'plus-square',
        git: 'git init',
        run: () => f.initRepo(),
      },
      {
        id: 'repo.close',
        category: 'repository',
        label: 'commands.closeRepo',
        icon: 'x',
        shortcut: 'Ctrl+W',
        needsRepo: true,
        run: r((s) => this.ws.close(s.path())),
      },
      {
        id: 'repo.refresh',
        category: 'repository',
        label: 'commands.refresh',
        icon: 'refresh',
        shortcut: 'F5',
        needsRepo: true,
        git: 'git status',
        run: r((s) => s.refresh()),
      },
      {
        id: 'repo.folder',
        category: 'repository',
        label: 'commands.showInFolder',
        icon: 'folder',
        needsRepo: true,
        run: r((s) => this.bridge.app('showInFolder', s.path())),
      },
      {
        id: 'repo.terminal',
        category: 'repository',
        label: 'commands.openTerminal',
        icon: 'terminal',
        shortcut: 'Ctrl+Alt+T',
        needsRepo: true,
        run: r((s) => this.bridge.app('openTerminal', s.path())),
      },
      {
        id: 'repo.identity',
        category: 'repository',
        label: 'commands.identity',
        icon: 'user',
        needsRepo: true,
        git: 'git config user.name',
        run: r((s) => f.identity(s)),
      },
      {
        id: 'repo.config',
        category: 'repository',
        label: 'commands.gitConfig',
        icon: 'sliders',
        needsRepo: true,
        git: 'git config',
        run: r((s) => f.gitConfig(s)),
      },

      // Cambios y commit
      {
        id: 'changes.stageAll',
        category: 'changes',
        label: 'commands.stageAll',
        icon: 'plus',
        shortcut: 'Ctrl+Shift+A',
        needsRepo: true,
        git: 'git add -A',
        run: r((s) => f.stageAll(s)),
      },
      {
        id: 'changes.unstageAll',
        category: 'changes',
        label: 'commands.unstageAll',
        icon: 'minus',
        needsRepo: true,
        git: 'git reset',
        run: r((s) => f.unstageAll(s)),
      },
      {
        id: 'changes.discardAll',
        category: 'changes',
        label: 'commands.discardAll',
        icon: 'trash',
        needsRepo: true,
        git: 'git reset --hard',
        run: r((s) => f.discardAll(s)),
      },
      {
        id: 'changes.clean',
        category: 'changes',
        label: 'commands.clean',
        icon: 'eraser',
        needsRepo: true,
        git: 'git clean',
        run: r((s) => f.clean(s)),
      },
      {
        id: 'commit.commit',
        category: 'commit',
        label: 'commands.commit',
        icon: 'check',
        needsRepo: true,
        git: 'git commit',
        run: r((s) => s.view.set('changes')),
      },
      {
        id: 'commit.amend',
        category: 'commit',
        label: 'commands.amend',
        icon: 'edit',
        needsRepo: true,
        git: 'git commit --amend',
        run: r((s) => {
          s.view.set('changes');
          window.dispatchEvent(new CustomEvent('gitora:amend'));
        }),
      },
      {
        id: 'commit.undo',
        category: 'commit',
        label: 'commands.undoCommit',
        icon: 'undo',
        needsRepo: true,
        git: 'git reset --soft HEAD~1',
        run: r((s) => f.undoLastCommit(s)),
      },

      // Ramas
      {
        id: 'branch.create',
        category: 'branch',
        label: 'commands.createBranch',
        icon: 'git-branch',
        shortcut: 'Ctrl+Shift+B',
        needsRepo: true,
        git: 'git branch / git checkout -b',
        run: r((s) => f.createBranch(s)),
      },
      {
        id: 'branch.checkout',
        category: 'branch',
        label: 'commands.checkout',
        icon: 'switch',
        shortcut: 'Ctrl+Shift+O',
        needsRepo: true,
        git: 'git checkout / git switch',
        run: r((s) => f.checkout(s)),
      },
      {
        id: 'branch.rename',
        category: 'branch',
        label: 'commands.renameBranch',
        icon: 'edit',
        needsRepo: true,
        git: 'git branch -m',
        run: r((s) => f.renameBranch(s)),
      },
      {
        id: 'branch.delete',
        category: 'branch',
        label: 'commands.deleteBranch',
        icon: 'trash',
        needsRepo: true,
        git: 'git branch -d',
        run: r((s) => f.deleteBranch(s)),
      },

      // Integración
      {
        id: 'merge.merge',
        category: 'merge',
        label: 'commands.merge',
        icon: 'git-merge',
        shortcut: 'Ctrl+Shift+M',
        needsRepo: true,
        git: 'git merge',
        run: r((s) => f.merge(s)),
      },
      {
        id: 'merge.rebase',
        category: 'merge',
        label: 'commands.rebase',
        icon: 'git-rebase',
        needsRepo: true,
        git: 'git rebase',
        run: r((s) => f.rebase(s)),
      },
      {
        id: 'merge.interactive',
        category: 'merge',
        label: 'commands.interactiveRebase',
        icon: 'list',
        needsRepo: true,
        git: 'git rebase -i',
        run: r((s) => f.interactiveRebase(s)),
      },
      {
        id: 'merge.cherryPick',
        category: 'merge',
        label: 'commands.cherryPick',
        icon: 'cherry',
        needsRepo: true,
        git: 'git cherry-pick',
        run: r((s) => f.cherryPickPrompt(s)),
      },
      {
        id: 'merge.revert',
        category: 'merge',
        label: 'commands.revert',
        icon: 'undo',
        needsRepo: true,
        git: 'git revert',
        run: r((s) => f.revertPrompt(s)),
      },
      {
        id: 'merge.reset',
        category: 'merge',
        label: 'commands.reset',
        icon: 'rewind',
        needsRepo: true,
        git: 'git reset',
        run: r((s) => f.reset(s)),
      },
      {
        id: 'merge.continue',
        category: 'merge',
        label: 'commands.continueOp',
        icon: 'play',
        needsRepo: true,
        when: inOp,
        git: 'git rebase/merge --continue',
        run: r((s) => f.continueOp(s)),
      },
      {
        id: 'merge.abort',
        category: 'merge',
        label: 'commands.abortOp',
        icon: 'stop',
        needsRepo: true,
        when: inOp,
        git: 'git rebase/merge --abort',
        run: r((s) => f.abortOp(s)),
      },
      {
        id: 'merge.skip',
        category: 'merge',
        label: 'commands.skipOp',
        icon: 'skip',
        needsRepo: true,
        when: (s) => s.operation().startsWith('rebasing'),
        git: 'git rebase --skip',
        run: r((s) => f.skipOp(s)),
      },

      // Remotos
      {
        id: 'remote.fetchAll',
        category: 'remote',
        label: 'commands.fetchAll',
        icon: 'fetch',
        shortcut: 'Ctrl+Shift+F',
        needsRepo: true,
        git: 'git fetch --all --prune',
        run: r((s) => f.quickFetch(s)),
      },
      {
        id: 'remote.fetch',
        category: 'remote',
        label: 'commands.fetch',
        icon: 'fetch',
        needsRepo: true,
        git: 'git fetch',
        run: r((s) => f.fetch(s)),
      },
      {
        id: 'remote.pull',
        category: 'remote',
        label: 'commands.pull',
        icon: 'pull',
        shortcut: 'Ctrl+Shift+L',
        needsRepo: true,
        git: 'git pull',
        run: r((s) => f.pull(s)),
      },
      {
        id: 'remote.push',
        category: 'remote',
        label: 'commands.push',
        icon: 'push',
        shortcut: 'Ctrl+Shift+K',
        needsRepo: true,
        git: 'git push',
        run: r((s) => f.push(s)),
      },
      {
        id: 'remote.forcePush',
        category: 'remote',
        label: 'commands.forcePush',
        icon: 'push',
        needsRepo: true,
        git: 'git push --force-with-lease',
        run: r((s) => f.push(s, undefined, 'with-lease')),
      },
      {
        id: 'remote.add',
        category: 'remote',
        label: 'commands.addRemote',
        icon: 'globe',
        needsRepo: true,
        git: 'git remote add',
        run: r((s) => f.addRemote(s)),
      },

      // Tags
      {
        id: 'tag.create',
        category: 'tag',
        label: 'commands.createTag',
        icon: 'tag',
        needsRepo: true,
        git: 'git tag',
        run: r((s) => f.createTag(s)),
      },
      {
        id: 'tag.pushAll',
        category: 'tag',
        label: 'commands.pushTags',
        icon: 'push',
        needsRepo: true,
        git: 'git push --tags',
        run: r((s) => f.pushAllTags(s)),
      },

      // Stash
      {
        id: 'stash.save',
        category: 'stash',
        label: 'commands.stashSave',
        icon: 'archive',
        shortcut: 'Ctrl+Shift+S',
        needsRepo: true,
        git: 'git stash push',
        run: r((s) => f.stash(s)),
      },
      {
        id: 'stash.pop',
        category: 'stash',
        label: 'commands.stashPop',
        icon: 'unarchive',
        needsRepo: true,
        when: (s) => s.stashes().length > 0,
        git: 'git stash pop',
        run: r((s) => f.stashPop(s)),
      },
      {
        id: 'stash.clear',
        category: 'stash',
        label: 'commands.stashClear',
        icon: 'trash',
        needsRepo: true,
        when: (s) => s.stashes().length > 0,
        git: 'git stash clear',
        run: r((s) => f.stashClear(s)),
      },

      // Submódulos y worktrees
      {
        id: 'sub.add',
        category: 'submodule',
        label: 'commands.addSubmodule',
        icon: 'box',
        needsRepo: true,
        git: 'git submodule add',
        run: r((s) => f.addSubmodule(s)),
      },
      {
        id: 'sub.update',
        category: 'submodule',
        label: 'commands.updateSubmodules',
        icon: 'refresh',
        needsRepo: true,
        git: 'git submodule update --init --recursive',
        run: r((s) => f.updateSubmodules(s)),
      },
      {
        id: 'sub.sync',
        category: 'submodule',
        label: 'commands.syncSubmodules',
        icon: 'link',
        needsRepo: true,
        git: 'git submodule sync',
        run: r((s) => f.syncSubmodules(s)),
      },
      {
        id: 'wt.add',
        category: 'submodule',
        label: 'commands.addWorktree',
        icon: 'layers',
        needsRepo: true,
        git: 'git worktree add',
        run: r((s) => f.addWorktree(s)),
      },
      {
        id: 'wt.prune',
        category: 'submodule',
        label: 'commands.pruneWorktrees',
        icon: 'eraser',
        needsRepo: true,
        git: 'git worktree prune',
        run: r((s) => f.pruneWorktrees(s)),
      },

      // Git Flow
      {
        id: 'flow.init',
        category: 'flow',
        label: 'menu.repo.flowInit',
        icon: 'git-branch',
        needsRepo: true,
        git: 'git flow init',
        run: r((s) => f.flowInit(s)),
      },
      {
        id: 'flow.feature',
        category: 'flow',
        label: 'menu.repo.flowFeature',
        icon: 'git-branch',
        needsRepo: true,
        git: 'git flow feature start',
        run: r((s) => f.flowStart(s, 'feature')),
      },
      {
        id: 'flow.release',
        category: 'flow',
        label: 'menu.repo.flowRelease',
        icon: 'tag',
        needsRepo: true,
        git: 'git flow release start',
        run: r((s) => f.flowStart(s, 'release')),
      },
      {
        id: 'flow.hotfix',
        category: 'flow',
        label: 'menu.repo.flowHotfix',
        icon: 'zap',
        needsRepo: true,
        git: 'git flow hotfix start',
        run: r((s) => f.flowStart(s, 'hotfix')),
      },
      {
        id: 'flow.deinit',
        category: 'flow',
        label: 'menu.repo.flowDeinit',
        icon: 'x',
        needsRepo: true,
        run: r((s) => f.flowDeinit(s)),
      },

      // Historial
      {
        id: 'history.search',
        category: 'history',
        label: 'commands.searchCommits',
        icon: 'search',
        shortcut: 'Ctrl+F',
        needsRepo: true,
        git: 'git log --grep',
        run: r((s) => {
          s.view.set('history');
          window.dispatchEvent(new CustomEvent('gitora:search'));
        }),
      },
      {
        id: 'history.reflog',
        category: 'history',
        label: 'commands.reflog',
        icon: 'clock',
        needsRepo: true,
        git: 'git reflog',
        run: r((s) => f.reflog(s)),
      },
      {
        id: 'history.file',
        category: 'history',
        label: 'commands.fileHistory',
        icon: 'file',
        needsRepo: true,
        git: 'git log --follow',
        run: r((s) => f.fileHistory(s)),
      },
      {
        id: 'history.blame',
        category: 'history',
        label: 'commands.blame',
        icon: 'user',
        needsRepo: true,
        git: 'git blame',
        run: r((s) => f.blame(s)),
      },
      {
        id: 'history.bisect',
        category: 'history',
        label: 'commands.bisect',
        icon: 'split',
        needsRepo: true,
        git: 'git bisect start',
        run: r((s) => f.bisect(s)),
      },
      {
        id: 'history.bisectGood',
        category: 'history',
        label: 'commands.bisectGood',
        icon: 'check',
        needsRepo: true,
        when: (s) => s.operation() === 'bisecting',
        git: 'git bisect good',
        run: r((s) => f.bisectMark(s, 'good')),
      },
      {
        id: 'history.bisectBad',
        category: 'history',
        label: 'commands.bisectBad',
        icon: 'x',
        needsRepo: true,
        when: (s) => s.operation() === 'bisecting',
        git: 'git bisect bad',
        run: r((s) => f.bisectMark(s, 'bad')),
      },
      {
        id: 'history.bisectReset',
        category: 'history',
        label: 'commands.bisectReset',
        icon: 'stop',
        needsRepo: true,
        when: (s) => s.operation() === 'bisecting',
        git: 'git bisect reset',
        run: r((s) => f.abortOp(s)),
      },

      // Herramientas
      {
        id: 'repo.stats',
        category: 'tools',
        label: 'menu.repo.stats',
        icon: 'database',
        needsRepo: true,
        git: 'git shortlog -sn',
        run: r((s) => f.repoStats(s)),
      },
      {
        id: 'repo.treemap',
        category: 'tools',
        label: 'menu.repo.treemap',
        icon: 'layers',
        needsRepo: true,
        git: 'git ls-tree -r -l',
        run: r((s) => f.repoTreemap(s)),
      },
      {
        id: 'repo.benchmark',
        category: 'tools',
        label: 'menu.repo.benchmark',
        icon: 'clock',
        needsRepo: true,
        run: r((s) => f.repoBenchmark(s)),
      },
      {
        id: 'tools.gc',
        category: 'tools',
        label: 'commands.gc',
        icon: 'zap',
        needsRepo: true,
        git: 'git gc',
        run: r((s) => f.gc(s)),
      },
      {
        id: 'tools.archive',
        category: 'tools',
        label: 'commands.archive',
        icon: 'package',
        needsRepo: true,
        git: 'git archive',
        run: r((s) => f.archive(s)),
      },
      {
        id: 'tools.am',
        category: 'tools',
        label: 'commands.applyPatch',
        icon: 'file-plus',
        needsRepo: true,
        git: 'git am',
        run: r((s) => f.applyPatches(s)),
      },
      {
        id: 'tools.lfsTrack',
        category: 'tools',
        label: 'commands.lfsTrack',
        icon: 'database',
        needsRepo: true,
        git: 'git lfs track',
        run: r((s) => f.lfsTrack(s)),
      },
      {
        id: 'tools.lfsPull',
        category: 'tools',
        label: 'commands.lfsPull',
        icon: 'database',
        needsRepo: true,
        git: 'git lfs pull',
        run: r((s) => f.lfsPull(s)),
      },
      {
        id: 'tools.custom',
        category: 'tools',
        label: 'commands.runCustom',
        icon: 'terminal',
        shortcut: 'Ctrl+Shift+G',
        needsRepo: true,
        git: 'git …',
        run: r((s) => f.customCommand(s)),
      },

      // Plataformas
      {
        id: 'platform.accounts',
        category: 'platform',
        label: 'commands.accounts',
        icon: 'users',
        run: () => f.openSettings('accounts'),
      },
      {
        id: 'platform.cloneAccount',
        category: 'platform',
        label: 'welcome.fromAccount',
        icon: 'download',
        run: () => f.cloneFromAccount(),
      },
      {
        id: 'platform.prs',
        category: 'platform',
        label: 'commands.pullRequests',
        icon: 'git-pull-request',
        needsRepo: true,
        when: (s) => s.remotes().length > 0,
        run: r((s) => f.pullRequests(s)),
      },
      {
        id: 'platform.createPr',
        category: 'platform',
        label: 'commands.createPr',
        icon: 'git-pull-request',
        needsRepo: true,
        when: (s) => s.remotes().length > 0,
        run: r((s) => f.createPullRequest(s)),
      },

      // Vista
      {
        id: 'view.changes',
        category: 'view',
        label: 'commands.viewChanges',
        icon: 'edit',
        shortcut: 'Ctrl+1',
        needsRepo: true,
        run: r((s) => s.view.set('changes')),
      },
      {
        id: 'view.history',
        category: 'view',
        label: 'commands.viewHistory',
        icon: 'git-commit',
        shortcut: 'Ctrl+2',
        needsRepo: true,
        run: r((s) => s.view.set('history')),
      },
      {
        id: 'view.console',
        category: 'view',
        label: 'commands.console',
        icon: 'terminal',
        shortcut: 'Ctrl+`',
        run: () => this.ws.toggleConsole(),
      },
      {
        id: 'view.theme',
        category: 'view',
        label: 'commands.toggleTheme',
        icon: 'moon',
        run: () => this.settings.update({ theme: this.settings.isDark() ? 'light' : 'dark' }),
      },
      {
        id: 'view.language',
        category: 'view',
        label: 'commands.toggleLanguage',
        icon: 'languages',
        run: () => this.settings.update({ language: this.i18n.lang() === 'es' ? 'en' : 'es' }),
      },
      {
        id: 'view.settings',
        category: 'view',
        label: 'commands.settings',
        icon: 'settings',
        shortcut: 'Ctrl+,',
        run: () => f.openSettings(),
      },
    ];
  }

  /**
   * Arma los ítems de un dropdown a partir de ids de comandos, así etiqueta, icono y atajo
   * salen de un solo lugar. '-' es separador y '#clave.i18n' un título de sección.
   * Los comandos que no aplican al estado actual (`when`) se omiten.
   */
  menu(spec: readonly string[], store: RepositoryStore | null): MenuItem[] {
    const out: MenuItem[] = [];
    for (const id of spec) {
      if (id === '-') out.push({ separator: true });
      else if (id.startsWith('#')) out.push({ header: true, label: this.i18n.t(id.slice(1)) });
      else {
        const cmd = this.available(store).find((c) => c.id === id);
        if (cmd)
          out.push({
            label: this.i18n.t(cmd.label),
            icon: cmd.icon,
            shortcut: cmd.shortcut,
            action: () => cmd.run(store),
          });
      }
    }
    // Un título sin ítems debajo no aporta nada
    return out.filter(
      (it, i) => !(it.header && (!out[i + 1] || out[i + 1].separator || out[i + 1].header)),
    );
  }

  /** Ejecuta un comando por id (lo usa el menú nativo); ignora ids desconocidos o no disponibles. */
  execute(id: string, store: RepositoryStore | null): boolean {
    const cmd = this.available(store).find((c) => c.id === id);
    if (!cmd) return false;
    void cmd.run(store);
    return true;
  }

  available(store: RepositoryStore | null): Command[] {
    return this.all.filter((c) => (!c.needsRepo || store) && (!c.when || (store && c.when(store))));
  }

  /** Atajo de teclado → comando. Ctrl y Cmd se tratan igual. */
  handleKey(e: KeyboardEvent, store: RepositoryStore | null): boolean {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    parts.push(key === 'DEAD' ? '`' : key);
    const combo = parts.join('+');
    const cmd = this.available(store).find((c) => c.shortcut === combo);
    if (!cmd) return false;
    e.preventDefault();
    void cmd.run(store);
    return true;
  }
}
