import { Component, input } from '@angular/core';

import { ProviderKind } from '@core/models';

const NAMES: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  gitea: 'Gitea',
};
const INITIALS: Record<ProviderKind, string> = {
  github: 'GH',
  gitlab: 'GL',
  bitbucket: 'BB',
  gitea: 'GT',
};

const COLORS: Record<ProviderKind, string> = {
  github: 'bg-[#57606a]',
  gitlab: 'bg-[#c2571a]',
  bitbucket: 'bg-[#1f5fbf]',
  gitea: 'bg-[#4f8a2a]',
};

@Component({
  selector: 'gt-provider-mark',
  template: `<span
    class="inline-grid size-[22px] place-items-center rounded-md text-[10.5px] font-bold text-white"
    [class]="colors[provider()]"
    [title]="name()"
    >{{ initials() }}</span
  >`,
})
export class ProviderMark {
  protected readonly colors = COLORS;
  readonly provider = input.required<ProviderKind>();
  name() {
    return NAMES[this.provider()];
  }
  initials() {
    return INITIALS[this.provider()];
  }
}
