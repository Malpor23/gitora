import { Component, computed, inject } from '@angular/core';

import { I18n } from '@core/i18n';
import { TPipe } from '@core/i18n/i18n';
import { ContextMenuService, SettingsService, WorkspaceService } from '@core/services';
import { GitFlows } from '@features/actions';
import { Icon } from '@shared/components';

@Component({
  imports: [TPipe, Icon],
  selector: 'gt-welcome',
  host: { class: 'block h-full overflow-auto' },
  templateUrl: './welcome.html',
})
export class Welcome {
  readonly flows = inject(GitFlows);
  readonly ws = inject(WorkspaceService);
  readonly settings = inject(SettingsService);
  private readonly menu = inject(ContextMenuService);
  private readonly i18n = inject(I18n);
  readonly recent = computed(() => this.settings.settings()?.recentRepos ?? []);

  base(p: string) {
    return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  }

  menuFor(e: MouseEvent, repo: string) {
    this.menu.open(e, [
      {
        label: this.i18n.t('welcome.removeRecent'),
        icon: 'x',
        action: () =>
          this.settings.update({ recentRepos: this.recent().filter((r) => r !== repo) }),
      },
    ]);
  }
}
