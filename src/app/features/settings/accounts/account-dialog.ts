import { afterNextRender, Component, computed, DestroyRef, effect, ElementRef, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { I18n, TPipe } from '@core/i18n/i18n';
import { Account, AuthMethod, OAuthDeviceCode, ProviderKind } from '@core/models';
import {
  BridgeService,
  DIALOG_DATA,
  DIALOG_REF,
  DialogRef,
  NotifyService,
  SettingsService,
} from '@core/services';
import { ProviderMark } from '@features/remote';
import { Icon } from '@shared/components';

import { methodOf, PROVIDER_AUTH_METHODS } from '../../../../../shared/auth';
import {
  AccountFormState,
  canSubmit,
  defaultMethod,
  fieldsFor,
  formatCountdown,
  formFromAccount,
  hostKey,
  PROVIDER_NAMES,
  PROVIDER_TILES,
  ProviderTile,
  toNewAccountInput,
} from './accounts.logic';

const TOKEN_HELP: Record<ProviderKind, string> = {
  github: 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Gitora',
  gitlab:
    'https://gitlab.com/-/user_settings/personal_access_tokens?name=Gitora&scopes=api,read_repository,write_repository',
  bitbucket: 'https://bitbucket.org/account/settings/app-passwords/new',
  gitea: 'https://codeberg.org/user/settings/applications',
};

const SERVER_PLACEHOLDER: Record<ProviderKind, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com · gitlab.miempresa.com',
  bitbucket: '',
  gitea: 'codeberg.org · gitea.miempresa.com',
};

/** Datos del diálogo: sin `account` es un alta; con `account`, la edición de su credencial. */
export interface AccountDialogData {
  account?: Account;
}

/** Alta de cuenta (elegir plataforma y rellenar el formulario) o edición de la credencial de una existente. */
@Component({
  selector: 'gt-account-dialog',
  imports: [FormsModule, TPipe, Icon, ProviderMark],
  templateUrl: './account-dialog.html',
})
export class AccountDialog {
  private readonly data = (inject(DIALOG_DATA, { optional: true }) ?? {}) as AccountDialogData;
  readonly ref = inject(DIALOG_REF) as DialogRef<Account>;
  private readonly bridge = inject(BridgeService);
  private readonly notify = inject(NotifyService);
  private readonly svc = inject(SettingsService);
  private readonly i18n = inject(I18n);
  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly tiles = PROVIDER_TILES;
  /** Cuenta que se está editando (null = alta). */
  readonly editing = signal<Account | null>(this.data.account ?? null);
  readonly step = signal<'pick' | 'form'>(this.data.account ? 'form' : 'pick');

  readonly provider = signal<ProviderKind>('github');
  readonly method = signal<AuthMethod>('token');
  readonly server = signal('');
  readonly username = signal('');
  readonly secret = signal('');
  readonly keyPath = signal('');
  readonly clientId = signal('');
  readonly serverRequired = signal(false);
  readonly tile = signal<ProviderTile | null>(null);

  readonly adding = signal(false);
  readonly error = signal<string | null>(null);

  // Estado de la pantalla OAuth
  readonly device = signal<OAuthDeviceCode | null>(null);
  readonly remaining = signal(0);

  readonly methods = computed(() => PROVIDER_AUTH_METHODS[this.provider()]);
  readonly fields = computed(() => fieldsFor(this.provider(), this.method()));
  readonly state = computed<AccountFormState>(() => ({
    provider: this.provider(),
    method: this.method(),
    server: this.server(),
    username: this.username(),
    secret: this.secret(),
    keyPath: this.keyPath(),
    clientId: this.clientId(),
    serverRequired: this.serverRequired(),
  }));
  readonly submittable = computed(() => canSubmit(this.state()));
  readonly clientKey = computed(() => hostKey(this.provider(), this.server()));
  readonly countdown = computed(() => formatCountdown(this.remaining()));
  readonly serverPlaceholder = computed(() => SERVER_PLACEHOLDER[this.provider()]);
  readonly title = computed(() => {
    const a = this.editing();
    return a ? `${this.i18n.t('accounts.editTitle')}: ${a.username}@${a.host}` : this.i18n.t('accounts.add');
  });

  private timer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;

  constructor() {
    const a = this.editing();
    if (a) {
      const f = formFromAccount(a);
      this.provider.set(f.provider);
      this.method.set(f.method);
      this.server.set(f.server);
      this.username.set(f.username);
      this.keyPath.set(f.keyPath);
    }
    // Rellena el Client ID guardado para el servidor elegido
    effect(() => {
      const key = this.clientKey();
      const saved = this.svc.settings()?.oauthClientIds?.[key] ?? '';
      untracked(() => {
        if (this.method() === 'oauth') this.clientId.set(saved);
      });
    });
    afterNextRender(() => this.focusFirst());
    // Cerrar el diálogo (×, Escape, clic fuera) con una sesión OAuth pendiente la cancela
    this.destroyRef.onDestroy(() => {
      this.stopTimer();
      const d = this.device();
      if (d) {
        this.cancelled = true;
        void this.bridge.app('oauthCancel', d.sessionId).catch(() => undefined);
      }
    });
  }

  providerName(p: ProviderKind) {
    return PROVIDER_NAMES[p];
  }

  /** Elige una casilla de plataforma y pasa al formulario. */
  pickTile(t: ProviderTile) {
    this.tile.set(t);
    this.provider.set(t.provider);
    this.method.set(defaultMethod(t.provider));
    this.serverRequired.set(t.serverRequired);
    this.server.set('');
    this.error.set(null);
    this.step.set('form');
    this.focusFirst();
  }

  back() {
    if (this.adding()) return;
    this.step.set('pick');
    this.error.set(null);
    this.focusFirst();
  }

  /** En edición también se puede cambiar de método (p. ej. de token a clave SSH): la cuenta editada se reemplaza. */
  selectMethod(m: AuthMethod) {
    this.method.set(m);
    this.error.set(null);
  }

  tokenHelp() {
    void this.bridge.app('openExternal', TOKEN_HELP[this.provider()]);
  }

  async browseKey() {
    const files = await this.bridge.app('pickFiles', this.i18n.t('accounts.keyPath'));
    if (files[0]) this.keyPath.set(files[0]);
  }

  async submit() {
    if (this.step() !== 'form' || !this.submittable() || this.adding()) return;
    this.adding.set(true);
    this.error.set(null);
    try {
      if (this.method() === 'oauth') await this.runOAuth();
      else await this.runAdd();
    } catch (e) {
      if (!this.cancelled) this.error.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.adding.set(false);
    }
  }

  private async runAdd() {
    const acc = await this.bridge.app('addAccount', toNewAccountInput(this.state()));
    await this.finish(acc);
  }

  private async runOAuth() {
    const s = this.state();
    const clientId = s.clientId.trim();
    const baseUrl = s.server.trim() || undefined;
    const code = await this.bridge.app('oauthStart', { provider: s.provider, baseUrl, clientId });
    const key = this.clientKey();
    const ids = this.svc.settings()?.oauthClientIds ?? {};
    if (ids[key] !== clientId) {
      void this.svc.update({ oauthClientIds: { ...ids, [key]: clientId } });
    }
    this.cancelled = false;
    this.device.set(code);
    this.startTimer(code.expiresIn);
    try {
      const acc = await this.bridge.app('oauthComplete', code.sessionId);
      this.stopTimer();
      this.device.set(null);
      await this.finish(acc);
    } catch (e) {
      this.stopTimer();
      this.device.set(null);
      throw e;
    }
  }

  private async finish(acc: Account) {
    const edited = this.editing();
    // Un token nuevo puede pertenecer a otro usuario: entonces la cuenta editada queda reemplazada
    if (edited && edited.id !== acc.id) await this.bridge.app('removeAccount', edited.id);
    await this.svc.reload();
    this.notify.success(edited ? 'toast.accountUpdated' : 'toast.accountAdded', { name: `${acc.username}@${acc.host}` });
    this.ref.close(acc);
  }

  async cancelOAuth() {
    const d = this.device();
    if (!d) return;
    this.cancelled = true;
    this.stopTimer();
    this.device.set(null);
    this.error.set(null);
    try {
      await this.bridge.app('oauthCancel', d.sessionId);
    } catch {
      // La sesión ya terminó; no hay nada que cancelar.
    }
  }

  copyCode() {
    const d = this.device();
    if (!d) return;
    void navigator.clipboard.writeText(d.userCode);
    this.notify.success('common.copied');
  }

  openBrowser() {
    const d = this.device();
    if (d) void this.bridge.app('openExternal', d.verificationUriComplete ?? d.verificationUri);
  }

  methodOf(a: Account): AuthMethod {
    return methodOf(a);
  }

  /** Foco en el primer control útil del paso actual (en el servidor si es obligatorio). */
  private focusFirst() {
    setTimeout(() => {
      const root = this.el.nativeElement as HTMLElement;
      const target =
        this.step() === 'pick'
          ? root.querySelector<HTMLElement>('[data-tile]')
          : this.editing()
            ? root.querySelector<HTMLElement>('#a-secret, #a-key, #a-client')
            : this.serverRequired()
              ? root.querySelector<HTMLElement>('#a-server')
              : root.querySelector<HTMLElement>('#a-user, #a-secret, #a-key, #a-client, #a-server');
      target?.focus();
    }, 0);
  }

  private startTimer(seconds: number) {
    this.stopTimer();
    const end = Date.now() + seconds * 1000;
    this.remaining.set(seconds);
    this.timer = setInterval(() => {
      this.remaining.set(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    }, 1000);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
