import { inject, Service } from '@angular/core';

import { I18n } from '@core/i18n';
import { Branch, Commit, GitFlowKind, RebaseTodoItem, ResetMode, Stash, Tag } from '@core/models';
import {
  BridgeService,
  DialogService,
  FieldOption,
  FieldSpec,
  FormValues,
  NotifyService,
  SettingsService,
  WorkspaceService,
} from '@core/services';
import { RepositoryStore } from '@core/store';

import { defaultStartBranch, flowBaseBranch, flowBranchName } from './repo-forms';
import {
  defaultPullBranch,
  defaultPullRemote,
  pullBranchOptions,
  pullModeFromForm,
  remoteBranchNames,
} from './pull-form';
import {
  defaultPushRemote,
  defaultPushTarget,
  forcePushConfirmKey,
  shouldSetUpstream,
  upstreamOf,
} from './push-form';

const BRANCH_NAME = /^(?!\/|.*(?:\/\.|\/\/|\.\.|@\{|\\))[^\s~^:?*[\x00-\x1f\x7f]+(?<![./]|\.lock)$/;

@Service()
export class GitFlows {
  private readonly bridge = inject(BridgeService);
  private readonly dialogs = inject(DialogService);
  private readonly i18n = inject(I18n);
  private readonly notify = inject(NotifyService);
  private readonly settings = inject(SettingsService);
  private readonly ws = inject(WorkspaceService);

  private t(key: string, params?: Record<string, string | number>) {
    return this.i18n.t(key, params);
  }

  /* ───────── helpers ───────── */
  private refOptions(
    s: RepositoryStore,
    opts: { local?: boolean; remote?: boolean; tags?: boolean } = {
      local: true,
      remote: true,
      tags: true,
    },
  ): FieldOption[] {
    const list: FieldOption[] = [];
    if (opts.local) list.push(...s.localBranches().map((b) => ({ value: b.name, label: b.name })));
    if (opts.remote)
      list.push(...s.remoteBranches().map((b) => ({ value: b.name, label: b.name })));
    if (opts.tags) list.push(...s.tags().map((t) => ({ value: t.name, label: `${t.name}` })));
    return list;
  }

  private remoteOptions(s: RepositoryStore): FieldOption[] {
    return s.remotes().map((r) => ({ value: r.name, label: r.name, hint: r.fetchUrl }));
  }

  private head(s: RepositoryStore): string {
    return s.status()?.head ?? 'HEAD';
  }

  private async dangerOk(message?: string, confirmLabel?: string): Promise<boolean> {
    if (!this.settings.value.confirmDangerous) return true;
    return this.dialogs.confirm(message ?? this.t('dialogs.confirmDanger'), {
      danger: true,
      confirmLabel,
    });
  }

  private nameValidator = (v: unknown) =>
    BRANCH_NAME.test(String(v).trim()) ? null : this.t('dialogs.createBranch.invalid');

  /* ───────── repositorio ───────── */
  async openRepo() {
    const dir = await this.bridge.app('pickDirectory', this.t('commands.openRepo'));
    if (dir) await this.ws.open(dir);
  }

  async cloneRepo(url = '', name = '') {
    const parent = this.settings.value.defaultCloneDir;
    const values = await this.dialogs.form({
      title: this.t('dialogs.clone.title'),
      width: 560,
      fields: [
        {
          key: 'url',
          label: this.t('dialogs.clone.url'),
          type: 'text',
          value: url,
          required: true,
          mono: true,
          autofocus: !url,
          placeholder: this.t('dialogs.clone.urlPlaceholder'),
        },
        {
          key: 'parent',
          label: this.t('dialogs.clone.parent'),
          type: 'path',
          value: parent,
          required: true,
        },
        {
          key: 'name',
          label: this.t('dialogs.clone.name'),
          type: 'text',
          value: name || guessRepoName(url),
          required: true,
        },
        {
          key: 'branch',
          label: `${this.t('dialogs.clone.branch')} (${this.t('common.optional')})`,
          type: 'text',
          value: '',
        },
        {
          key: 'depth',
          label: `${this.t('dialogs.clone.depth')} (${this.t('common.optional')})`,
          type: 'number',
          value: '',
        },
        {
          key: 'recursive',
          label: this.t('dialogs.clone.recursive'),
          type: 'checkbox',
          value: true,
        },
      ],
      submitLabel: this.t('welcome.clone'),
    });
    if (!values) return;
    const directory = joinPath(String(values['parent']), String(values['name']));
    const opId = `clone-${Date.now()}`;
    const progress = this.notify.progress(this.t('dialogs.clone.cloning'));
    const off = this.bridge.on('progress', (p) => {
      if (p.id === opId) progress.update(p.phase, p.percent);
    });
    try {
      await this.bridge.git('clone', '', {
        url: String(values['url']).trim(),
        directory,
        branch: String(values['branch'] || '') || undefined,
        depth: Number(values['depth']) || undefined,
        recursive: !!values['recursive'],
        opId,
      });
      this.notify.success('toast.cloned');
      await this.ws.open(directory);
    } catch (e) {
      this.notify.error(e);
    } finally {
      off();
      progress.close();
    }
  }

  async initRepo() {
    const values = await this.dialogs.form({
      title: this.t('dialogs.init.title'),
      fields: [
        {
          key: 'folder',
          label: this.t('dialogs.init.folder'),
          type: 'path',
          value: this.settings.value.defaultCloneDir,
          required: true,
        },
        {
          key: 'branch',
          label: this.t('dialogs.init.branch'),
          type: 'text',
          value: 'main',
          required: true,
        },
        { key: 'bare', label: this.t('dialogs.init.bare'), type: 'checkbox', value: false },
      ],
      run: async (v) =>
        this.bridge.git('init', String(v['folder']), !!v['bare'], String(v['branch'])),
    });
    if (values) await this.ws.open(String(values['folder']));
  }

  async identity(s: RepositoryStore) {
    const current = await this.bridge.git('identity', s.path());
    await this.dialogs.form({
      title: this.t('dialogs.identity.title'),
      fields: [
        {
          key: 'name',
          label: this.t('dialogs.identity.name'),
          type: 'text',
          value: current.name,
          required: true,
        },
        {
          key: 'email',
          label: this.t('dialogs.identity.email'),
          type: 'text',
          value: current.email,
          required: true,
        },
        { key: 'global', label: this.t('dialogs.identity.global'), type: 'checkbox', value: false },
      ],
      run: (v) =>
        this.bridge.git(
          'setIdentity',
          s.path(),
          { name: String(v['name']), email: String(v['email']) },
          !!v['global'],
        ),
    });
  }

  /* ───────── cambios ───────── */
  stageAll(s: RepositoryStore) {
    return s.run(() => this.bridge.git('stageAll', s.path()));
  }

  unstageAll(s: RepositoryStore) {
    return s.run(() => this.bridge.git('unstageAll', s.path()));
  }

  async discard(s: RepositoryStore, paths: string[]) {
    if (
      !(await this.dialogs.confirm(this.t('changes.confirmDiscard', { n: paths.length }), {
        danger: true,
        confirmLabel: this.t('changes.discard'),
      }))
    )
      return;
    await s.run(() => this.bridge.git('discard', s.path(), paths));
  }

  async discardAll(s: RepositoryStore) {
    if (
      !(await this.dialogs.confirm(this.t('changes.confirmDiscardAll'), {
        danger: true,
        confirmLabel: this.t('changes.discardAll'),
      }))
    )
      return;
    await s.run(() => this.bridge.git('discardAll', s.path(), true));
  }

  async clean(s: RepositoryStore) {
    const preview = await this.bridge.git('clean', s.path(), true, false, true);
    await this.dialogs.form({
      title: this.t('dialogs.clean.title'),
      danger: true,
      message: preview.length
        ? `${this.t('dialogs.clean.preview')}\n${preview.slice(0, 40).join('\n')}${preview.length > 40 ? '\n…' : ''}`
        : this.t('dialogs.clean.nothing'),
      fields: [
        { key: 'dirs', label: this.t('dialogs.clean.dirs'), type: 'checkbox', value: true },
        { key: 'ignored', label: this.t('dialogs.clean.ignored'), type: 'checkbox', value: false },
      ],
      submitLabel: this.t('common.delete'),
      run: (v) =>
        s.run(() => this.bridge.git('clean', s.path(), !!v['dirs'], !!v['ignored'], false), {
          silentError: true,
        }),
    });
  }

  ignore(s: RepositoryStore, pattern: string) {
    return s.run(() => this.bridge.git('ignore', s.path(), pattern));
  }

  async undoLastCommit(s: RepositoryStore) {
    await s.run(() => this.bridge.git('reset', s.path(), 'HEAD~1', 'soft'), {
      success: 'toast.opDone',
    });
    s.view.set('changes');
  }

  /* ───────── ramas ───────── */
  async createBranch(s: RepositoryStore, startPoint?: string) {
    const values = await this.dialogs.form({
      title: this.t('dialogs.createBranch.title'),
      fields: [
        {
          key: 'name',
          label: this.t('dialogs.createBranch.name'),
          type: 'text',
          required: true,
          autofocus: true,
          placeholder: this.t('dialogs.createBranch.placeholder'),
          validate: this.nameValidator,
        },
        {
          key: 'start',
          label: this.t('dialogs.createBranch.startPoint'),
          type: 'combo',
          value: startPoint ?? this.head(s),
          options: this.refOptions(s),
          mono: true,
        },
        {
          key: 'checkout',
          label: this.t('dialogs.createBranch.checkout'),
          type: 'checkbox',
          value: true,
        },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git(
              'createBranch',
              s.path(),
              String(v['name']).trim(),
              String(v['start']),
              !!v['checkout'],
            ),
          { silentError: true },
        ),
    });
    if (values) this.notify.success('toast.branchCreated', { name: String(values['name']) });
  }

  async checkout(s: RepositoryStore, ref?: string) {
    if (ref) {
      const remote = s.remoteBranches().find((b) => b.name === ref);
      await s.run(() => this.bridge.git('checkout', s.path(), ref, { track: !!remote }), {
        success: 'toast.checkedOut',
        successParams: { name: remote ? ref.split('/').slice(1).join('/') : ref },
      });
      return;
    }
    await this.dialogs.form({
      title: this.t('dialogs.checkout.title'),
      fields: [
        {
          key: 'ref',
          label: this.t('dialogs.checkout.branch'),
          type: 'combo',
          options: this.refOptions(s, { local: true, remote: true }),
          required: true,
          autofocus: true,
          mono: true,
        },
        { key: 'force', label: this.t('dialogs.checkout.force'), type: 'checkbox', value: false },
      ],
      run: (v) => {
        const target = String(v['ref']);
        const remote = s.remoteBranches().some((b) => b.name === target);
        return s.run(
          () =>
            this.bridge.git('checkout', s.path(), target, { force: !!v['force'], track: remote }),
          { silentError: true, success: 'toast.checkedOut', successParams: { name: target } },
        );
      },
    });
  }

  async checkoutCommit(s: RepositoryStore, hash: string) {
    await s.run(() => this.bridge.git('checkout', s.path(), hash, {}));
  }

  async renameBranch(s: RepositoryStore, name?: string) {
    const old = name ?? s.currentBranch()?.name;
    if (!old) return;
    await this.dialogs.form({
      title: this.t('dialogs.renameBranch.title'),
      fields: [
        {
          key: 'name',
          label: this.t('dialogs.renameBranch.newName'),
          type: 'text',
          value: old,
          required: true,
          autofocus: true,
          validate: this.nameValidator,
        },
      ],
      run: (v) =>
        s.run(() => this.bridge.git('renameBranch', s.path(), old, String(v['name']).trim()), {
          silentError: true,
        }),
    });
  }

  async deleteBranch(s: RepositoryStore, branch?: Branch) {
    if (!branch) {
      const name = await this.pickRef(s, this.t('commands.deleteBranch'), { local: true });
      branch = s.localBranches().find((b) => b.name === name);
      if (!branch) return;
    }
    const b = branch;
    const [upRemote, ...upRest] = (b.upstream ?? '').split('/');
    await this.dialogs.form({
      title: this.t('dialogs.deleteBranch.title'),
      message: this.t('dialogs.deleteBranch.message', { name: b.name }),
      danger: true,
      fields: [
        {
          key: 'force',
          label: this.t('dialogs.deleteBranch.force'),
          type: 'checkbox',
          value: false,
        },
        ...(b.upstream && !b.upstreamGone
          ? [
              {
                key: 'remote',
                label: this.t('dialogs.deleteBranch.remoteToo', { remote: b.upstream }),
                type: 'checkbox',
                value: false,
              } as FieldSpec,
            ]
          : []),
      ],
      submitLabel: this.t('common.delete'),
      run: (v) =>
        s.run(
          async () => {
            await this.bridge.git('deleteBranch', s.path(), b.name, !!v['force']);
            if (v['remote'])
              await this.bridge.git('deleteRemoteBranch', s.path(), upRemote, upRest.join('/'));
          },
          { silentError: true },
        ),
    });
  }

  async deleteRemoteBranch(s: RepositoryStore, b: Branch) {
    const name = b.name.slice((b.remote ?? '').length + 1);
    if (
      !(await this.dialogs.confirm(this.t('dialogs.deleteBranch.message', { name: b.name }), {
        danger: true,
        confirmLabel: this.t('common.delete'),
      }))
    )
      return;
    await s.run(() => this.bridge.git('deleteRemoteBranch', s.path(), b.remote!, name), {
      busy: 'status.pushing',
    });
  }

  async setUpstream(s: RepositoryStore, b: Branch) {
    await this.dialogs.form({
      title: this.t('dialogs.setUpstream.title'),
      fields: [
        {
          key: 'up',
          label: this.t('dialogs.setUpstream.upstream'),
          type: 'select',
          value: b.upstream ?? '',
          options: [
            { value: '', label: this.t('dialogs.setUpstream.none') },
            ...s.remoteBranches().map((r) => ({ value: r.name, label: r.name })),
          ],
        },
      ],
      run: (v) =>
        s.run(() => this.bridge.git('setUpstream', s.path(), b.name, String(v['up']) || null), {
          silentError: true,
        }),
    });
  }

  private async pickRef(
    s: RepositoryStore,
    title: string,
    opts: { local?: boolean; remote?: boolean; tags?: boolean },
  ): Promise<string | undefined> {
    const v = await this.dialogs.form({
      title,
      fields: [
        {
          key: 'ref',
          label: this.t('dialogs.checkout.branch'),
          type: 'combo',
          options: this.refOptions(s, opts),
          required: true,
          autofocus: true,
          mono: true,
        },
      ],
    });
    return v ? String(v['ref']) : undefined;
  }

  /* ───────── integración ───────── */
  async merge(s: RepositoryStore, ref?: string) {
    const current = this.head(s);
    await this.dialogs.form({
      title: this.t('dialogs.merge.title'),
      fields: [
        {
          key: 'ref',
          label: this.t('dialogs.merge.ref', { current }),
          type: 'combo',
          value: ref ?? '',
          options: this.refOptions(s).filter((o) => o.value !== current),
          required: true,
          autofocus: !ref,
          mono: true,
        },
        {
          key: 'strategy',
          label: this.t('dialogs.merge.strategy'),
          type: 'radio',
          value: 'default',
          options: [
            { value: 'default', label: this.t('dialogs.merge.default') },
            { value: 'no-ff', label: this.t('dialogs.merge.noFf') },
            { value: 'ff-only', label: this.t('dialogs.merge.ffOnly') },
            { value: 'squash', label: this.t('dialogs.merge.squash') },
          ],
        },
        {
          key: 'noCommit',
          label: this.t('dialogs.merge.noCommit'),
          type: 'checkbox',
          value: false,
          visibleWhen: (v) => v['strategy'] !== 'squash' && v['strategy'] !== 'ff-only',
        },
        {
          key: 'message',
          label: `${this.t('dialogs.merge.message')} (${this.t('common.optional')})`,
          type: 'text',
          visibleWhen: (v) => v['strategy'] === 'no-ff',
        },
      ],
      submitLabel: this.t('toolbar.merge'),
      run: (v) =>
        s.run(
          () =>
            this.bridge.git('merge', s.path(), {
              ref: String(v['ref']),
              strategy: v['strategy'] as 'default',
              noCommit: !!v['noCommit'],
              message: String(v['message'] || '') || undefined,
            }),
          { busy: 'common.running', success: 'toast.merged' },
        ),
    });
  }

  async rebase(s: RepositoryStore, onto?: string) {
    const current = this.head(s);
    await this.dialogs.form({
      title: this.t('dialogs.rebase.title'),
      fields: [
        {
          key: 'onto',
          label: this.t('dialogs.rebase.onto', { current }),
          type: 'combo',
          value: onto ?? '',
          options: this.refOptions(s).filter((o) => o.value !== current),
          required: true,
          autofocus: !onto,
          mono: true,
        },
        {
          key: 'autostash',
          label: this.t('dialogs.rebase.autostash'),
          type: 'checkbox',
          value: true,
        },
        {
          key: 'merges',
          label: this.t('dialogs.rebase.rebaseMerges'),
          type: 'checkbox',
          value: false,
        },
      ],
      submitLabel: this.t('toolbar.rebase'),
      run: (v) =>
        s.run(
          () =>
            this.bridge.git('rebase', s.path(), {
              onto: String(v['onto']),
              autostash: !!v['autostash'],
              preserveMerges: !!v['merges'],
            }),
          { busy: 'common.running', success: 'toast.rebased' },
        ),
    });
  }

  async interactiveRebase(s: RepositoryStore, base?: string) {
    let baseRef = base;
    if (!baseRef) {
      baseRef = await this.dialogs.prompt(
        this.t('dialogs.interactive.title'),
        this.t('dialogs.rebase.onto', { current: this.head(s) }),
        'HEAD~5',
        true,
      );
      if (!baseRef) return;
    }
    const { InteractiveRebase } = await import('@features/dialogs');
    const todo = await this.dialogs.open<{ todo: RebaseTodoItem[]; autostash: boolean }>(
      InteractiveRebase,
      { store: s, base: baseRef },
      760,
    );
    if (!todo) return;
    await s.run(
      () => this.bridge.git('rebaseInteractive', s.path(), baseRef!, todo.todo, todo.autostash),
      { busy: 'common.running', success: 'toast.rebased' },
    );
  }

  cherryPick(s: RepositoryStore, hashes: string[]) {
    return s.run(() => this.bridge.git('cherryPick', s.path(), hashes, false), {
      success: 'toast.opDone',
    });
  }

  async cherryPickPrompt(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.cherryPick.title'),
      fields: [
        {
          key: 'h',
          label: this.t('dialogs.cherryPick.hashes'),
          type: 'text',
          required: true,
          autofocus: true,
          mono: true,
        },
        { key: 'nc', label: this.t('dialogs.cherryPick.noCommit'), type: 'checkbox', value: false },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git(
              'cherryPick',
              s.path(),
              String(v['h']).split(/\s+/).filter(Boolean),
              !!v['nc'],
            ),
          { silentError: true },
        ),
    });
  }

  revert(s: RepositoryStore, hashes: string[]) {
    return s.run(() => this.bridge.git('revert', s.path(), hashes, false), {
      success: 'toast.opDone',
    });
  }

  async revertPrompt(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.revert.title'),
      fields: [
        {
          key: 'h',
          label: this.t('dialogs.revert.hashes'),
          type: 'text',
          required: true,
          autofocus: true,
          mono: true,
        },
        { key: 'nc', label: this.t('dialogs.revert.noCommit'), type: 'checkbox', value: false },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git(
              'revert',
              s.path(),
              String(v['h']).split(/\s+/).filter(Boolean),
              !!v['nc'],
            ),
          { silentError: true },
        ),
    });
  }

  async reset(s: RepositoryStore, target = 'HEAD') {
    await this.dialogs.form({
      title: this.t('dialogs.reset.title'),
      fields: [
        {
          key: 'target',
          label: this.t('dialogs.reset.target', { current: this.head(s) }),
          type: 'combo',
          value: target,
          options: this.refOptions(s),
          required: true,
          mono: true,
        },
        {
          key: 'mode',
          label: this.t('dialogs.reset.mode'),
          type: 'radio',
          value: 'mixed',
          options: [
            { value: 'soft', label: this.t('dialogs.reset.soft') },
            { value: 'mixed', label: this.t('dialogs.reset.mixed') },
            { value: 'keep', label: this.t('dialogs.reset.keep') },
            { value: 'hard', label: this.t('dialogs.reset.hard') },
          ],
          warnWhen: (v) => (v['mode'] === 'hard' ? this.t('dialogs.reset.hardWarning') : null),
        },
      ],
      submitLabel: 'Reset',
      run: (v) =>
        s.run(
          () => this.bridge.git('reset', s.path(), String(v['target']), v['mode'] as ResetMode),
          { silentError: true },
        ),
    });
  }

  /** Continuar / abortar / omitir la operación en curso (merge, rebase, cherry-pick, revert). */
  async continueOp(s: RepositoryStore) {
    const op = s.operation();
    const p = s.path();
    await s.run(
      () => {
        switch (op) {
          case 'merging':
            return this.bridge.git('mergeContinue', p);
          case 'rebasing':
          case 'rebasing-interactive':
            return this.bridge.git('rebaseContinue', p);
          case 'cherry-picking':
            return this.bridge.git('cherryPickContinue', p);
          case 'reverting':
            return this.bridge.git('revertContinue', p);
          default:
            return Promise.resolve();
        }
      },
      { success: 'toast.opDone' },
    );
  }

  async abortOp(s: RepositoryStore) {
    const op = s.operation();
    const p = s.path();
    if (!(await this.dangerOk())) return;
    await s.run(() => {
      switch (op) {
        case 'merging':
          return this.bridge.git('mergeAbort', p);
        case 'rebasing':
        case 'rebasing-interactive':
          return this.bridge.git('rebaseAbort', p);
        case 'cherry-picking':
          return this.bridge.git('cherryPickAbort', p);
        case 'reverting':
          return this.bridge.git('revertAbort', p);
        case 'bisecting':
          return this.bridge.git('bisectReset', p);
        default:
          return Promise.resolve();
      }
    });
  }

  skipOp(s: RepositoryStore) {
    return s.run(() => this.bridge.git('rebaseSkip', s.path()));
  }

  /* ───────── remotos ───────── */
  private withProgress<T>(
    s: RepositoryStore,
    labelKey: string,
    successKey: string,
    fn: (opId: string) => Promise<T>,
  ) {
    const opId = `${labelKey}-${Date.now()}`;
    const progress = this.notify.progress(this.t(labelKey));
    const off = this.bridge.on('progress', (p) => {
      if (p.id === opId) progress.update(p.phase, p.percent);
    });
    return s
      .run(() => fn(opId), { busy: labelKey, success: successKey })
      .finally(() => {
        off();
        progress.close();
      });
  }

  quickFetch(s: RepositoryStore, remote?: string) {
    return this.withProgress(s, 'status.fetching', 'toast.fetched', (opId) =>
      this.bridge.git('fetch', s.path(), { remote, prune: true, opId }),
    );
  }

  async fetch(s: RepositoryStore) {
    const upstream = s.status()?.upstream ?? null;
    const remoteBranches = s.remoteBranches();
    await this.dialogs.form({
      title: this.t('dialogs.fetch.title'),
      fields: [
        {
          key: 'all',
          label: this.t('dialogs.fetch.fetchAll'),
          type: 'checkbox',
          value: true,
        },
        {
          key: 'remote',
          label: this.t('dialogs.fetch.remote'),
          type: 'select',
          value: defaultPullRemote(s.remotes(), upstream),
          options: this.remoteOptions(s),
          visibleWhen: (v) => !v['all'],
        },
        {
          key: 'branch',
          label: this.t('dialogs.fetch.branch'),
          type: 'combo',
          value: '',
          placeholder: this.t('dialogs.fetch.allBranches'),
          optionsWhen: (v) =>
            remoteBranchNames(remoteBranches, String(v['remote'])).map((n) => ({ value: n, label: n })),
          autoValue: { deps: ['remote'], compute: () => '' },
          hint: this.t('dialogs.fetch.branchHint'),
          visibleWhen: (v) => !v['all'],
          mono: true,
        },
        { key: 'prune', label: this.t('dialogs.fetch.prune'), type: 'checkbox', value: true },
        { key: 'tags', label: this.t('dialogs.fetch.tags'), type: 'checkbox', value: false },
      ],
      submitLabel: 'Fetch',
      run: (v) =>
        this.withProgress(s, 'status.fetching', 'toast.fetched', (opId) =>
          this.bridge.git('fetch', s.path(), {
            remote: v['all'] ? undefined : String(v['remote']) || undefined,
            branch: v['all'] ? undefined : String(v['branch']).trim() || undefined,
            prune: !!v['prune'],
            tags: !!v['tags'],
            opId,
          }),
        ),
    });
  }

  quickPull(s: RepositoryStore) {
    const mode = this.settings.value.pullMode;
    return this.withProgress(s, 'status.pulling', 'toast.pulled', (opId) =>
      this.bridge.git('pull', s.path(), { mode, autostash: true, opId }),
    );
  }

  async pull(s: RepositoryStore) {
    const st = s.status();
    const upstream = st?.upstream ?? null;
    const branches = s.remoteBranches();
    const remote = defaultPullRemote(s.remotes(), upstream);
    const mode = this.settings.value.pullMode;
    await this.dialogs.form({
      title: this.t('dialogs.pull.title'),
      fields: [
        {
          key: 'remote',
          label: this.t('dialogs.pull.remote'),
          type: 'select',
          value: remote,
          options: this.remoteOptions(s),
        },
        {
          key: 'branch',
          label: this.t('dialogs.pull.branch'),
          type: 'select',
          value: defaultPullBranch(branches, remote, upstream, this.head(s)),
          optionsWhen: (v) =>
            pullBranchOptions(branches, String(v['remote']), this.t('dialogs.pull.trackingBranch')),
          hint: this.t('dialogs.pull.branchHint'),
        },
        {
          key: 'into',
          label: this.t('dialogs.pull.into'),
          type: 'text',
          value: st?.detached ? this.t('dialogs.pull.detached') : this.head(s),
          readonly: true,
          mono: true,
          hint: this.t('dialogs.pull.intoHint'),
        },
        {
          key: 'rebase',
          label: this.t('dialogs.pull.rebaseInstead'),
          type: 'checkbox',
          value: mode === 'rebase',
        },
        {
          key: 'ffOnly',
          label: this.t('dialogs.pull.ffOnly'),
          type: 'checkbox',
          value: mode === 'ff-only',
          visibleWhen: (v) => !v['rebase'],
        },
        {
          key: 'autostash',
          label: this.t('dialogs.pull.autostash'),
          type: 'checkbox',
          value: true,
          hint: this.t('dialogs.pull.autostashHint'),
        },
      ],
      submitLabel: 'Pull',
      run: (v) =>
        this.withProgress(s, 'status.pulling', 'toast.pulled', (opId) =>
          this.bridge.git('pull', s.path(), {
            remote: String(v['remote']) || undefined,
            branch: String(v['branch']) || undefined,
            mode: pullModeFromForm(v),
            autostash: !!v['autostash'],
            opId,
          }),
        ),
    });
  }

  quickPush(s: RepositoryStore) {
    const st = s.status();
    if (!st || st.detached) return this.push(s);
    if (!st.upstream) return this.push(s);
    const [remote] = st.upstream.split('/');
    return this.withProgress(s, 'status.pushing', 'toast.pushed', (opId) =>
      this.bridge.git('push', s.path(), { remote, branch: st.head, opId }),
    );
  }

  async push(
    s: RepositoryStore,
    branchName?: string,
    forceDefault: 'none' | 'with-lease' = 'none',
  ) {
    const branch = branchName ?? this.head(s);
    const locals = s.localBranches();
    const remoteBranches = s.remoteBranches();
    const upstream = upstreamOf(locals, branch);
    const remote = defaultPushRemote(s.remotes(), upstream);
    await this.dialogs.form({
      title: this.t('dialogs.push.title'),
      fields: [
        {
          key: 'branch',
          label: this.t('dialogs.push.branch'),
          type: 'select',
          value: branch,
          options: locals.map((b) => ({ value: b.name, label: b.name })),
        },
        {
          key: 'remote',
          label: this.t('dialogs.push.remote'),
          type: 'select',
          value: remote,
          options: this.remoteOptions(s),
          required: true,
          autoValue: {
            deps: ['branch'],
            compute: (v) => defaultPushRemote(s.remotes(), upstreamOf(locals, String(v['branch']))),
          },
        },
        {
          key: 'remoteBranch',
          label: this.t('dialogs.push.remoteBranch'),
          type: 'combo',
          value: defaultPushTarget(branch, upstream, remote),
          optionsWhen: (v) =>
            remoteBranchNames(remoteBranches, String(v['remote'])).map((n) => ({ value: n, label: n })),
          autoValue: {
            deps: ['branch', 'remote'],
            compute: (v) =>
              defaultPushTarget(
                String(v['branch']),
                upstreamOf(locals, String(v['branch'])),
                String(v['remote']),
              ),
          },
          hint: this.t('dialogs.push.remoteBranchHint'),
          mono: true,
        },
        {
          key: 'setUpstream',
          label: this.t('dialogs.push.setUpstream'),
          type: 'checkbox',
          value: shouldSetUpstream(upstream),
          autoValue: {
            deps: ['branch'],
            compute: (v) => shouldSetUpstream(upstreamOf(locals, String(v['branch']))),
          },
        },
        { key: 'tags', label: this.t('dialogs.push.tags'), type: 'checkbox', value: false },
        {
          key: 'force',
          label: this.t('dialogs.push.force'),
          type: 'radio',
          value: forceDefault,
          options: [
            { value: 'none', label: this.t('dialogs.push.forceNone') },
            { value: 'with-lease', label: this.t('dialogs.push.forceLease') },
            { value: 'force', label: this.t('dialogs.push.forceHard') },
          ],
          warnWhen: (v) => (v['force'] === 'force' ? this.t('dialogs.confirmDanger') : null),
        },
        { key: 'noVerify', label: this.t('dialogs.push.noVerify'), type: 'checkbox', value: false },
      ],
      submitLabel: 'Push',
      // Un push forzado reescribe el historial remoto: se confirma antes (respeta el ajuste de acciones peligrosas).
      beforeRun: (v) => {
        const key = forcePushConfirmKey(v['force']);
        if (!key) return true;
        const message = this.t(key, {
          branch: String(v['branch']),
          target: `${String(v['remote'])}/${String(v['remoteBranch']) || String(v['branch'])}`,
        });
        return this.dangerOk(message, this.t('dialogs.push.forceConfirmLabel'));
      },
      run: (v) =>
        this.withProgress(s, 'status.pushing', 'toast.pushed', (opId) =>
          this.bridge.git('push', s.path(), {
            remote: String(v['remote']),
            branch: String(v['branch']),
            remoteBranch: String(v['remoteBranch']) || undefined,
            setUpstream: !!v['setUpstream'],
            tags: !!v['tags'],
            force: v['force'] as 'none',
            noVerify: !!v['noVerify'],
            opId,
          }),
        ),
    });
  }

  async addRemote(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.remote.titleAdd'),
      fields: [
        {
          key: 'name',
          label: this.t('dialogs.remote.name'),
          type: 'text',
          value: s.remotes().length ? '' : 'origin',
          required: true,
          autofocus: true,
        },
        {
          key: 'url',
          label: this.t('dialogs.remote.url'),
          type: 'text',
          required: true,
          mono: true,
          placeholder: this.t('dialogs.clone.urlPlaceholder'),
        },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git(
              'addRemote',
              s.path(),
              String(v['name']).trim(),
              String(v['url']).trim(),
            ),
          { silentError: true },
        ),
    });
  }

  async editRemote(s: RepositoryStore, name: string) {
    const r = s.remotes().find((x) => x.name === name);
    if (!r) return;
    await this.dialogs.form({
      title: this.t('dialogs.remote.titleEdit'),
      fields: [
        {
          key: 'url',
          label: this.t('dialogs.remote.url'),
          type: 'text',
          value: r.fetchUrl,
          required: true,
          mono: true,
        },
        {
          key: 'pushUrl',
          label: this.t('dialogs.remote.pushUrl'),
          type: 'text',
          value: r.pushUrl !== r.fetchUrl ? r.pushUrl : '',
          mono: true,
        },
      ],
      run: (v) =>
        s.run(
          async () => {
            await this.bridge.git('setRemoteUrl', s.path(), name, String(v['url']).trim(), false);
            if (String(v['pushUrl']).trim())
              await this.bridge.git(
                'setRemoteUrl',
                s.path(),
                name,
                String(v['pushUrl']).trim(),
                true,
              );
          },
          { silentError: true },
        ),
    });
  }

  async renameRemote(s: RepositoryStore, name: string) {
    const n = await this.dialogs.prompt(
      this.t('dialogs.remote.titleRename'),
      this.t('dialogs.remote.name'),
      name,
    );
    if (n && n !== name) await s.run(() => this.bridge.git('renameRemote', s.path(), name, n));
  }

  async removeRemote(s: RepositoryStore, name: string) {
    if (
      !(await this.dialogs.confirm(`${this.t('ctx.removeRemote')} "${name}"`, {
        danger: true,
        confirmLabel: this.t('common.remove'),
      }))
    )
      return;
    await s.run(() => this.bridge.git('removeRemote', s.path(), name));
  }

  pruneRemote(s: RepositoryStore, name: string) {
    return s.run(() => this.bridge.git('pruneRemote', s.path(), name), { success: 'toast.opDone' });
  }

  /* ───────── tags ───────── */
  async createTag(s: RepositoryStore, ref = 'HEAD') {
    const values = await this.dialogs.form({
      title: this.t('dialogs.tag.title'),
      fields: [
        {
          key: 'name',
          label: this.t('dialogs.tag.name'),
          type: 'text',
          required: true,
          autofocus: true,
          placeholder: 'v1.0.0',
          mono: true,
        },
        {
          key: 'ref',
          label: this.t('dialogs.tag.ref'),
          type: 'combo',
          value: ref,
          options: this.refOptions(s),
          mono: true,
        },
        { key: 'message', label: this.t('dialogs.tag.message'), type: 'textarea' },
        { key: 'push', label: this.t('dialogs.tag.push'), type: 'checkbox', value: false },
        {
          key: 'pushRemote',
          label: this.t('dialogs.tag.pushRemote'),
          type: 'select',
          value: defaultPullRemote(s.remotes(), s.status()?.upstream ?? null),
          options: this.remoteOptions(s),
          visibleWhen: (v) => !!v['push'],
        },
        { key: 'force', label: this.t('dialogs.tag.force'), type: 'checkbox', value: false },
      ],
      run: (v) =>
        s.run(
          async () => {
            await this.bridge.git('createTag', s.path(), {
              name: String(v['name']).trim(),
              ref: String(v['ref']),
              message: String(v['message'] || '') || undefined,
              force: !!v['force'],
            });
            if (v['push'])
              await this.bridge.git(
                'pushTag',
                s.path(),
                String(v['pushRemote']),
                String(v['name']).trim(),
              );
          },
          { silentError: true },
        ),
    });
    if (values) this.notify.success('toast.tagCreated', { name: String(values['name']) });
  }

  async deleteTag(s: RepositoryStore, tag: Tag) {
    if (
      !(await this.dialogs.confirm(`${this.t('ctx.deleteTag')} ${tag.name}`, {
        danger: true,
        confirmLabel: this.t('common.delete'),
      }))
    )
      return;
    await s.run(() => this.bridge.git('deleteTag', s.path(), tag.name));
  }

  async pushTag(s: RepositoryStore, tag: Tag) {
    const remote = await this.pickRemote(s);
    if (remote)
      await s.run(() => this.bridge.git('pushTag', s.path(), remote, tag.name), {
        busy: 'status.pushing',
        success: 'toast.pushed',
      });
  }

  async deleteRemoteTag(s: RepositoryStore, tag: Tag) {
    const remote = await this.pickRemote(s);
    if (remote && (await this.dangerOk()))
      await s.run(() => this.bridge.git('deleteRemoteTag', s.path(), remote, tag.name), {
        busy: 'status.pushing',
      });
  }

  async pushAllTags(s: RepositoryStore) {
    const remote = await this.pickRemote(s);
    if (remote)
      await s.run(() => this.bridge.git('push', s.path(), { remote, tags: true }), {
        busy: 'status.pushing',
        success: 'toast.pushed',
      });
  }

  private async pickRemote(s: RepositoryStore): Promise<string | undefined> {
    const remotes = s.remotes();
    if (remotes.length === 1) return remotes[0].name;
    const v = await this.dialogs.form({
      title: this.t('dialogs.push.remote'),
      fields: [
        {
          key: 'r',
          label: this.t('dialogs.push.remote'),
          type: 'select',
          value: remotes[0]?.name ?? '',
          options: this.remoteOptions(s),
        },
      ],
    });
    return v ? String(v['r']) : undefined;
  }

  /* ───────── stash ───────── */
  async stash(s: RepositoryStore, paths?: string[]) {
    await this.dialogs.form({
      title: this.t('dialogs.stash.title'),
      fields: [
        {
          key: 'message',
          label: `${this.t('dialogs.stash.message')} (${this.t('common.optional')})`,
          type: 'text',
          autofocus: true,
        },
        {
          key: 'stageNew',
          label: this.t('dialogs.stash.stageNew'),
          type: 'checkbox',
          value: false,
          hint: this.t('dialogs.stash.stageNewHint'),
        },
        {
          key: 'keepIndex',
          label: this.t('dialogs.stash.keepIndex'),
          type: 'checkbox',
          value: false,
        },
        { key: 'staged', label: this.t('dialogs.stash.staged'), type: 'checkbox', value: false },
      ],
      submitLabel: 'Stash',
      run: (v) =>
        s.run(
          () =>
            this.bridge.git('stashSave', s.path(), {
              message: String(v['message'] || '') || undefined,
              stageNew: !!v['stageNew'],
              keepIndex: !!v['keepIndex'],
              staged: !!v['staged'],
              paths,
            }),
          { silentError: true, success: 'toast.stashed' },
        ),
    });
  }

  stashPop(s: RepositoryStore, index = 0) {
    return s.run(() => this.bridge.git('stashPop', s.path(), index), {
      success: 'toast.stashApplied',
    });
  }

  stashApply(s: RepositoryStore, index: number) {
    return s.run(() => this.bridge.git('stashApply', s.path(), index, false), {
      success: 'toast.stashApplied',
    });
  }

  async stashDrop(s: RepositoryStore, st: Stash) {
    if (
      !(await this.dialogs.confirm(`${this.t('ctx.dropStash')} ${st.ref}: ${st.message}`, {
        danger: true,
        confirmLabel: this.t('common.delete'),
      }))
    )
      return;
    await s.run(() => this.bridge.git('stashDrop', s.path(), st.index));
  }

  async stashClear(s: RepositoryStore) {
    if (!(await this.dangerOk())) return;
    await s.run(() => this.bridge.git('stashClear', s.path()));
  }

  async stashBranch(s: RepositoryStore, st: Stash) {
    await this.dialogs.form({
      title: this.t('dialogs.stash.branchTitle'),
      fields: [
        {
          key: 'name',
          label: this.t('dialogs.createBranch.name'),
          type: 'text',
          required: true,
          autofocus: true,
          validate: this.nameValidator,
        },
      ],
      run: (v) =>
        s.run(() => this.bridge.git('stashBranch', s.path(), st.index, String(v['name']).trim()), {
          silentError: true,
        }),
    });
  }

  /* ───────── submódulos y worktrees ───────── */

  async addSubmodule(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.submodule.title'),
      fields: [
        {
          key: 'url',
          label: this.t('dialogs.submodule.url'),
          type: 'text',
          required: true,
          mono: true,
          autofocus: true,
        },
        {
          key: 'path',
          label: this.t('dialogs.submodule.path'),
          type: 'text',
          required: true,
          mono: true,
        },
        {
          key: 'branch',
          label: `${this.t('dialogs.submodule.branch')} (${this.t('common.optional')})`,
          type: 'text',
        },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git(
              'submoduleAdd',
              s.path(),
              String(v['url']).trim(),
              String(v['path']).trim(),
              String(v['branch'] || '') || null,
            ),
          { silentError: true, busy: 'common.running' },
        ),
    });
  }

  updateSubmodules(s: RepositoryStore) {
    return s.run(() => this.bridge.git('submoduleUpdate', s.path(), true, true, false), {
      busy: 'common.running',
      success: 'toast.opDone',
    });
  }

  syncSubmodules(s: RepositoryStore) {
    return s.run(() => this.bridge.git('submoduleSync', s.path()), { success: 'toast.opDone' });
  }

  async deinitSubmodule(s: RepositoryStore, path: string) {
    if (await this.dangerOk())
      await s.run(() => this.bridge.git('submoduleDeinit', s.path(), path, true));
  }

  async addWorktree(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.worktree.title'),
      fields: [
        {
          key: 'startFrom',
          label: this.t('dialogs.worktree.startFrom'),
          type: 'select',
          value: defaultStartBranch(
            s.localBranches().map((b) => b.name),
            this.head(s),
          ),
          options: this.refOptions(s, { local: true, remote: true }),
        },
        {
          key: 'branch',
          label: this.t('dialogs.worktree.branch'),
          type: 'text',
          required: true,
          autofocus: true,
          mono: true,
          placeholder: this.t('dialogs.createBranch.placeholder'),
          validate: this.nameValidator,
        },
        { key: 'path', label: this.t('dialogs.worktree.path'), type: 'path', required: true },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git(
              'worktreeAdd',
              s.path(),
              String(v['path']),
              String(v['branch']).trim(),
              true,
              String(v['startFrom']),
            ),
          { silentError: true },
        ),
    });
  }

  async removeWorktree(s: RepositoryStore, path: string) {
    if (
      await this.dialogs.confirm(`${this.t('ctx.removeWorktree')} ${path}`, {
        danger: true,
        confirmLabel: this.t('common.remove'),
      })
    ) {
      await s.run(() => this.bridge.git('worktreeRemove', s.path(), path, false));
    }
  }

  pruneWorktrees(s: RepositoryStore) {
    return s.run(() => this.bridge.git('worktreePrune', s.path()), { success: 'toast.opDone' });
  }

  /* ───────── Git Flow ───────── */

  /** Inicializa Git Flow; devuelve true si quedó inicializado. */
  async flowInit(s: RepositoryStore): Promise<boolean> {
    const locals = s.localBranches().map((b) => b.name);
    const values = await this.dialogs.form({
      title: this.t('dialogs.flow.initTitle'),
      message: this.t('dialogs.flow.initHint'),
      fields: [
        {
          key: 'master',
          label: this.t('dialogs.flow.production'),
          type: 'select',
          value: defaultStartBranch(locals, this.head(s)),
          options: locals.map((n) => ({ value: n, label: n })),
        },
        {
          key: 'develop',
          label: this.t('dialogs.flow.develop'),
          type: 'text',
          value: 'develop',
          required: true,
          mono: true,
        },
        {
          key: 'feature',
          label: this.t('dialogs.flow.prefixFeature'),
          type: 'text',
          value: 'feature/',
          required: true,
          mono: true,
        },
        {
          key: 'release',
          label: this.t('dialogs.flow.prefixRelease'),
          type: 'text',
          value: 'release/',
          required: true,
          mono: true,
        },
        {
          key: 'hotfix',
          label: this.t('dialogs.flow.prefixHotfix'),
          type: 'text',
          value: 'hotfix/',
          required: true,
          mono: true,
        },
        {
          key: 'versionTag',
          label: this.t('dialogs.flow.versionTag'),
          type: 'text',
          value: '',
          mono: true,
        },
      ],
      run: (v) =>
        s.run(
          () =>
            this.bridge.git('flowInit', s.path(), {
              master: String(v['master']),
              develop: String(v['develop']).trim(),
              feature: String(v['feature']).trim(),
              release: String(v['release']).trim(),
              hotfix: String(v['hotfix']).trim(),
              versionTag: String(v['versionTag']).trim(),
            }),
          { silentError: true, success: 'dialogs.flow.initialized' },
        ),
    });
    return !!values;
  }

  /** Empieza una feature, release o hotfix; si Git Flow no está inicializado, lo inicializa antes. */
  async flowStart(s: RepositoryStore, kind: GitFlowKind) {
    let cfg = await this.bridge.git('flowStatus', s.path());
    if (!cfg) {
      if (!(await this.flowInit(s))) return;
      cfg = await this.bridge.git('flowStatus', s.path());
      if (!cfg) return;
    }
    const flow = cfg;
    const titles = {
      feature: ['dialogs.flow.startFeature', 'dialogs.flow.featureName'],
      release: ['dialogs.flow.startRelease', 'dialogs.flow.releaseName'],
      hotfix: ['dialogs.flow.startHotfix', 'dialogs.flow.hotfixName'],
    } as const;
    const [title, label] = titles[kind];
    await this.dialogs.form({
      title: this.t(title),
      message: this.t('dialogs.flow.basedOn', { base: flowBaseBranch(flow, kind) }),
      fields: [{ key: 'name', label: this.t(label), type: 'text', required: true, autofocus: true, mono: true }],
      run: (v) =>
        s.run(() => this.bridge.git('flowStart', s.path(), kind, String(v['name']).trim()), {
          silentError: true,
          success: 'dialogs.flow.started',
          successParams: { name: flowBranchName(flow, kind, String(v['name'])) },
        }),
    });
  }

  async flowDeinit(s: RepositoryStore) {
    if (!(await this.bridge.git('flowStatus', s.path()))) {
      this.notify.info(this.t('dialogs.flow.notInitialized'));
      return;
    }
    if (
      await this.dialogs.confirm(this.t('dialogs.flow.deinitConfirm'), {
        title: this.t('dialogs.flow.deinitTitle'),
        danger: true,
        confirmLabel: this.t('dialogs.flow.deinitTitle'),
      })
    ) {
      await s.run(() => this.bridge.git('flowDeinit', s.path()), {
        success: 'dialogs.flow.deinitialized',
      });
    }
  }

  /* ───────── estadísticas, treemap y benchmark ───────── */

  async repoStats(s: RepositoryStore) {
    const { RepoStatsDialog } = await import('@features/dialogs/repo-stats/repo-stats');
    await this.dialogs.open(RepoStatsDialog, { store: s }, 640);
  }

  async repoTreemap(s: RepositoryStore) {
    const { RepoTreemapDialog } = await import('@features/dialogs/repo-treemap/repo-treemap');
    await this.dialogs.open(RepoTreemapDialog, { store: s }, 760);
  }

  async repoBenchmark(s: RepositoryStore) {
    const { RepoBenchmarkDialog } = await import('@features/dialogs/repo-benchmark/repo-benchmark');
    await this.dialogs.open(RepoBenchmarkDialog, { store: s }, 600);
  }

  /* ───────── historial y herramientas ───────── */

  async fileHistory(s: RepositoryStore, path?: string) {
    const p =
      path ??
      (await this.dialogs.prompt(
        this.t('commands.fileHistory'),
        this.t('dialogs.pathPrompt.fileHistory'),
        '',
        true,
      ));
    if (!p) return;
    s.view.set('history');
    s.setFilter({ path: p, ref: null });
  }

  async blame(s: RepositoryStore, path?: string, rev?: string) {
    const p =
      path ??
      (await this.dialogs.prompt(
        this.t('commands.blame'),
        this.t('dialogs.pathPrompt.blame'),
        '',
        true,
      ));
    if (!p) return;
    const { Blame } = await import('@features/dialogs');
    await this.dialogs.open(Blame, { store: s, path: p, rev: rev ?? null }, 1000);
  }

  async reflog(s: RepositoryStore) {
    const { Reflog } = await import('@features/dialogs');
    await this.dialogs.open(Reflog, { store: s }, 820);
  }

  async bisect(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.bisect.title'),
      fields: [
        {
          key: 'bad',
          label: this.t('dialogs.bisect.bad'),
          type: 'text',
          value: 'HEAD',
          required: true,
          mono: true,
        },
        {
          key: 'good',
          label: this.t('dialogs.bisect.good'),
          type: 'combo',
          options: this.refOptions(s, { tags: true, local: true }),
          required: true,
          mono: true,
        },
      ],
      run: (v) =>
        s.run(
          async () =>
            this.notify.info(
              await this.bridge.git('bisectStart', s.path(), String(v['bad']), String(v['good'])),
            ),
          { silentError: true },
        ),
    });
  }

  async bisectMark(s: RepositoryStore, verdict: 'good' | 'bad') {
    await s.run(async () =>
      this.notify.info(await this.bridge.git('bisectMark', s.path(), verdict)),
    );
  }

  gc(s: RepositoryStore) {
    return s.run(() => this.bridge.git('gc', s.path(), false), {
      busy: 'common.running',
      success: 'toast.opDone',
    });
  }

  async archive(s: RepositoryStore) {
    await this.dialogs.form({
      title: this.t('dialogs.archive.title'),
      fields: [
        {
          key: 'ref',
          label: this.t('dialogs.archive.ref'),
          type: 'combo',
          value: 'HEAD',
          options: this.refOptions(s),
          mono: true,
        },
        {
          key: 'format',
          label: this.t('dialogs.archive.format'),
          type: 'select',
          value: 'zip',
          options: [
            { value: 'zip', label: 'zip' },
            { value: 'tar.gz', label: 'tar.gz' },
          ],
        },
      ],
      run: async (v) => {
        const out = await this.bridge.app(
          'pickSavePath',
          this.t('dialogs.archive.title'),
          `${s.name()}.${v['format']}`,
        );
        if (out)
          await s.run(
            () => this.bridge.git('archive', s.path(), String(v['ref']), out, v['format'] as 'zip'),
            { silentError: true, success: 'toast.opDone', refresh: false },
          );
      },
    });
  }

  async savePatch(s: RepositoryStore, hashes: string[]) {
    const dir = await this.bridge.app('pickDirectory', this.t('ctx.savePatch'));
    if (dir)
      await s.run(() => this.bridge.git('formatPatch', s.path(), hashes, dir), {
        success: 'toast.opDone',
        refresh: false,
      });
  }

  async applyPatches(s: RepositoryStore) {
    const files = await this.bridge.app('pickFiles', this.t('commands.applyPatch'));
    if (files.length)
      await s.run(() => this.bridge.git('applyMailbox', s.path(), files), {
        success: 'toast.opDone',
      });
  }

  async lfsTrack(s: RepositoryStore) {
    if (!(await this.bridge.git('lfsInstalled', s.path()))) {
      this.notify.info(this.t('dialogs.lfs.notInstalled'));
      return;
    }
    const pattern = await this.dialogs.prompt(
      this.t('dialogs.lfs.title'),
      this.t('dialogs.lfs.pattern'),
      '*.psd',
      true,
    );
    if (pattern) await s.run(() => this.bridge.git('lfsTrack', s.path(), pattern));
  }

  lfsPull(s: RepositoryStore) {
    return s.run(() => this.bridge.git('lfsPull', s.path()), {
      busy: 'common.running',
      success: 'toast.opDone',
    });
  }

  async gitConfig(s: RepositoryStore) {
    const { ConfigEditor } = await import('@features/dialogs');
    await this.dialogs.open(ConfigEditor, { store: s }, 760);
  }

  async customCommand(s: RepositoryStore) {
    const { CustomCommand } = await import('@features/dialogs');
    await this.dialogs.open(CustomCommand, { store: s }, 820);
  }

  async resolveConflict(s: RepositoryStore, path: string) {
    const { ConflictResolver } = await import('@features/dialogs');
    await this.dialogs.open(ConflictResolver, { store: s, path }, 1100);
  }

  /* ───────── plataformas ───────── */

  async cloneFromAccount() {
    const { RemoteRepos } = await import('@features/remote');
    const picked = await this.dialogs.open<{ url: string; name: string }>(RemoteRepos, {}, 760);
    if (picked) await this.cloneRepo(picked.url, picked.name);
  }

  async pullRequests(s: RepositoryStore) {
    const { PullRequests } = await import('@features/remote');
    await this.dialogs.open(PullRequests, { store: s }, 820);
  }

  async createPullRequest(s: RepositoryStore, source?: string) {
    const remote = s.remotes()[0]?.name;
    if (!remote) return;
    const branches = s.localBranches().map((b) => ({ value: b.name, label: b.name }));
    const def =
      s
        .remoteBranches()
        .find((b) => /\/(main|master|develop)$/.test(b.name))
        ?.name.split('/')
        .slice(1)
        .join('/') ?? 'main';
    const last = await this.bridge.git('lastCommitMessage', s.path()).catch(() => '');
    await this.dialogs.form({
      title: this.t('pr.create'),
      width: 600,
      fields: [
        {
          key: 'remote',
          label: this.t('pr.remote'),
          type: 'select',
          value: remote,
          options: this.remoteOptions(s),
        },
        {
          key: 'source',
          label: this.t('pr.source'),
          type: 'select',
          value: source ?? this.head(s),
          options: branches,
        },
        {
          key: 'target',
          label: this.t('pr.target'),
          type: 'text',
          value: def,
          mono: true,
          required: true,
        },
        {
          key: 'title',
          label: this.t('pr.titleField'),
          type: 'text',
          value: last.split('\n')[0],
          required: true,
        },
        {
          key: 'body',
          label: this.t('pr.body'),
          type: 'textarea',
          value: last.split('\n').slice(2).join('\n'),
        },
        { key: 'draft', label: this.t('pr.draft'), type: 'checkbox', value: false },
      ],
      run: async (v: FormValues) => {
        const pr = await this.bridge.app('createPullRequest', s.path(), String(v['remote']), {
          title: String(v['title']),
          body: String(v['body']),
          source: String(v['source']),
          target: String(v['target']),
          draft: !!v['draft'],
        });
        this.notify.success('toast.prCreated', { n: pr.number });
        await this.bridge.app('openExternal', pr.url);
      },
    });
  }

  async openSettings(tab: 'general' | 'git' | 'diff' | 'accounts' | 'about' = 'general') {
    const { Settings } = await import('@features/settings');
    await this.dialogs.open(Settings, { tab }, 760);
    this.ws.scheduleAutoFetch();
  }

  /* ───────── commits (menú contextual del historial) ───────── */

  copy(text: string) {
    void navigator.clipboard.writeText(text);
    this.notify.success('common.copied');
  }

  async openCommitInBrowser(s: RepositoryStore, c: Commit) {
    const remote = s.remotes()[0];
    if (!remote) return;
    const loc = await this.bridge.app('locateRemote', remote.fetchUrl);
    if (!loc.host) return;
    const base = `https://${loc.host}/${loc.owner}/${loc.repo}`;
    const url =
      loc.provider === 'gitlab'
        ? `${base}/-/commit/${c.hash}`
        : loc.provider === 'bitbucket'
          ? `${base}/commits/${c.hash}`
          : `${base}/commit/${c.hash}`;
    await this.bridge.app('openExternal', url);
  }
}

function guessRepoName(url: string): string {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : '';
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return parent.replace(/[\\/]+$/, '') + sep + name;
}
