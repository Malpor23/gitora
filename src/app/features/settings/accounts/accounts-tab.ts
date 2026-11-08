import { Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';

import { I18n, TPipe } from '@core/i18n/i18n';
import { Account, AccountStatus, AuthMethod } from '@core/models';
import {
  BridgeService,
  DIALOG_REF,
  DialogRef,
  DialogService,
  SettingsService,
} from '@core/services';
import { GitFlows } from '@features/actions';
import { ProviderMark } from '@features/remote';
import { Icon } from '@shared/components';
import { authorHue, initials } from '@shared/utils/avatar';

import { methodOf } from '../../../../../shared/auth';
import {
  navigateIndex,
  PROVIDER_NAMES,
  selectionAfterRemoval,
  serverUrl,
  StatusTone,
  statusView,
  updateLabelKey,
} from './accounts.logic';

type DetailTab = 'account' | 'repos';

/** Una comprobación reciente se reutiliza al volver a seleccionar la cuenta (evita llamadas repetidas a la API). */
const STATUS_TTL_MS = 30_000;

@Component({
  selector: 'gt-accounts-tab',
  imports: [TPipe, Icon, ProviderMark],
  templateUrl: './accounts-tab.html',
})
export class AccountsTab {
  private readonly bridge = inject(BridgeService);
  private readonly svc = inject(SettingsService);
  private readonly i18n = inject(I18n);
  private readonly dialogs = inject(DialogService);
  private readonly flows = inject(GitFlows);
  private readonly settingsRef = inject(DIALOG_REF) as DialogRef;
  private readonly destroyRef = inject(DestroyRef);

  readonly accounts = computed<Account[]>(() => this.svc.settings()?.accounts ?? []);
  readonly selectedId = signal<string | null>(null);
  /** La cuenta elegida; mientras no se elija ninguna (o ya no exista) se muestra la primera. */
  readonly selected = computed<Account | null>(() => {
    const list = this.accounts();
    return list.find((a) => a.id === this.selectedId()) ?? list[0] ?? null;
  });
  private readonly selectedKey = computed(() => this.selected()?.id ?? null);
  readonly detailTab = signal<DetailTab>('account');
  readonly avatarBroken = signal(false);

  readonly statuses = signal<Record<string, AccountStatus | 'checking'>>({});
  private readonly checkedAt = new Map<string, number>();
  private alive = true;

  readonly status = computed(() => {
    const a = this.selected();
    if (!a) return null;
    const st = this.statuses()[a.id];
    if (!st) return null;
    const view = statusView(st);
    // Sin API y sin clave SSH (p. ej. contraseña en GitLab): mismo estado gris, con su propia explicación
    const key = st === 'unverifiable' && methodOf(a) !== 'ssh' ? 'accounts.status.noApi' : view.key;
    return { tone: view.tone as StatusTone, key };
  });

  constructor() {
    effect(() => {
      const id = this.selectedKey();
      untracked(() => {
        this.avatarBroken.set(false);
        if (id) void this.check(id, false);
      });
    });
    this.destroyRef.onDestroy(() => (this.alive = false));
  }

  providerName(a: Account) {
    return PROVIDER_NAMES[a.provider];
  }

  methodOf(a: Account): AuthMethod {
    return methodOf(a);
  }

  updateKey(a: Account) {
    return updateLabelKey(methodOf(a));
  }

  link(a: Account) {
    return serverUrl(a);
  }

  displayName(a: Account) {
    return a.displayName || a.username;
  }

  initials(a: Account) {
    return initials(this.displayName(a));
  }

  hue(a: Account) {
    return authorHue(`${a.username}@${a.host}`);
  }

  select(id: string) {
    this.selectedId.set(id);
  }

  /** Flechas, Inicio y Fin mueven la selección de la lista y el foco con ella. */
  onListKey(e: KeyboardEvent) {
    const list = this.accounts();
    const current = list.findIndex((a) => a.id === this.selected()?.id);
    const next = navigateIndex(e.key, current, list.length);
    if (next === null) return;
    e.preventDefault();
    const id = list[next].id;
    this.select(id);
    setTimeout(() => document.getElementById('acc-opt-' + id)?.focus(), 0);
  }

  onTabKey(e: KeyboardEvent) {
    const order: DetailTab[] = ['account', 'repos'];
    const next = navigateIndex(e.key, order.indexOf(this.detailTab()), order.length);
    if (next === null) return;
    e.preventDefault();
    this.detailTab.set(order[next]);
    setTimeout(() => document.getElementById('acc-tab-' + order[next])?.focus(), 0);
  }

  async check(id: string, force = true) {
    const last = this.checkedAt.get(id) ?? 0;
    if (this.statuses()[id] === 'checking') return;
    if (!force && this.statuses()[id] && Date.now() - last < STATUS_TTL_MS) return;
    this.statuses.update((s) => ({ ...s, [id]: 'checking' }));
    let result: AccountStatus;
    try {
      result = await this.bridge.app('checkAccount', id);
    } catch {
      result = 'offline';
    }
    this.checkedAt.set(id, Date.now());
    if (this.alive) this.statuses.update((s) => ({ ...s, [id]: result }));
  }

  openServer(a: Account) {
    void this.bridge.app('openExternal', serverUrl(a));
  }

  async add() {
    const { AccountDialog } = await import('./account-dialog');
    const saved = await this.dialogs.open<Account>(AccountDialog, {}, 560);
    if (!saved) return;
    this.select(saved.id);
    void this.check(saved.id);
  }

  async editCredential(a: Account) {
    const { AccountDialog } = await import('./account-dialog');
    const saved = await this.dialogs.open<Account>(AccountDialog, { account: a }, 560);
    if (!saved) return;
    this.select(saved.id);
    void this.check(saved.id);
  }

  async remove() {
    const a = this.selected();
    if (!a) return;
    const name = `${a.username}@${a.host}`;
    const ok = await this.dialogs.confirm(this.i18n.t('accounts.removeConfirm', { name }), {
      title: this.i18n.t('accounts.remove'),
      danger: true,
      confirmLabel: this.i18n.t('common.remove'),
    });
    if (!ok) return;
    const ids = this.accounts().map((x) => x.id);
    const next = selectionAfterRemoval(ids, ids.indexOf(a.id));
    await this.bridge.app('removeAccount', a.id);
    this.statuses.update((s) => {
      const { [a.id]: _gone, ...rest } = s;
      return rest;
    });
    this.checkedAt.delete(a.id);
    this.selectedId.set(next);
    await this.svc.reload();
  }

  /** Abre «Clonar desde mi cuenta» con esta cuenta elegida y, si se elige un repo, cierra Ajustes y lo clona. */
  async cloneFromThisAccount(a: Account) {
    const { RemoteRepos } = await import('@features/remote');
    const picked = await this.dialogs.open<{ url: string; name: string }>(RemoteRepos, { accountId: a.id }, 760);
    if (!picked) return;
    this.settingsRef.close();
    await this.flows.cloneRepo(picked.url, picked.name);
  }
}
