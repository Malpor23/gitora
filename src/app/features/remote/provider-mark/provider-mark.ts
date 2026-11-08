import { Component, computed, input } from '@angular/core';

import { Account, ProviderKind } from '@core/models';

const NAMES: Record<ProviderKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  gitea: 'Gitea',
};

interface Logo {
  viewBox: string;
  /** Color de la marca; GitHub usa el color de texto para verse bien en tema claro y oscuro. */
  color: string;
  path: string;
}

/*
 * Logos de las plataformas. GitHub, GitLab y Bitbucket: Font Awesome Free 5.15.4 (iconos CC BY 4.0,
 * https://fontawesome.com/license/free). Gitea: taza de té dibujada a mano (no hay logo libre incluido).
 */
const LOGOS: Record<ProviderKind, Logo> = {
  github: {
    viewBox: '0 0 496 512',
    color: 'currentColor',
    path: 'M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8zM97.2 352.9c-1.3 1-1 3.3.7 5.2 1.6 1.6 3.9 2.3 5.2 1 1.3-1 1-3.3-.7-5.2-1.6-1.6-3.9-2.3-5.2-1zm-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9 1.6 1 3.6.7 4.3-.7.7-1.3-.3-2.9-2.3-3.9-2-.6-3.6-.3-4.3.7zm32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2 2.3 2.3 5.2 2.6 6.5 1 1.3-1.3.7-4.3-1.3-6.2-2.2-2.3-5.2-2.6-6.5-1zm-11.4-14.7c-1.6 1-1.6 3.6 0 5.9 1.6 2.3 4.3 3.3 5.6 2.3 1.6-1.3 1.6-3.9 0-6.2-1.4-2.3-4-3.3-5.6-2z',
  },
  gitlab: {
    viewBox: '0 0 512 512',
    color: '#fc6d26',
    path: 'M105.2 24.9c-3.1-8.9-15.7-8.9-18.9 0L29.8 199.7h132c-.1 0-56.6-174.8-56.6-174.8zM.9 287.7c-2.6 8 .3 16.9 7.1 22l247.9 184-226.2-294zm160.8-88l94.3 294 94.3-294zm349.4 88l-28.8-88-226.3 294 247.9-184c6.9-5.1 9.7-14 7.2-22zM425.7 24.9c-3.1-8.9-15.7-8.9-18.9 0l-56.6 174.8h132z',
  },
  bitbucket: {
    viewBox: '0 0 512 512',
    color: '#2684ff',
    path: 'M22.2 32A16 16 0 0 0 6 47.8a26.35 26.35 0 0 0 .2 2.8l67.9 412.1a21.77 21.77 0 0 0 21.3 18.2h325.7a16 16 0 0 0 16-13.4L505 50.7a16 16 0 0 0-13.2-18.3 24.58 24.58 0 0 0-2.8-.2L22.2 32zm285.9 297.8h-104l-28.1-147h157.3l-25.2 147z',
  },
  gitea: {
    viewBox: '0 0 512 512',
    color: '#609926',
    path: 'M64 128h288v176a112 112 0 0 1-112 112h-64A112 112 0 0 1 64 304zM352 160h40a56 56 0 0 1 0 112h-40v-40h40a16 16 0 0 0 0-32h-40zM96 440h256v32H96z',
  },
};

/** Host de una URL de remoto (https://, ssh:// o scp `git@host:ruta`), en minúsculas. */
function hostOf(url: string): string | null {
  const t = url.trim();
  const scp = /^[\w.-]+@([^:/]+):/.exec(t);
  if (scp) return scp[1].toLowerCase();
  try {
    return new URL(t).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Proveedor al que apunta un remoto: primero por las cuentas configuradas (cubre servidores propios)
 * y si no por el nombre del host, con la misma heurística que el proceso principal.
 */
export function providerOfUrl(url: string, accounts: readonly Account[] = []): ProviderKind | null {
  const host = hostOf(url);
  if (!host) return null;
  const account = accounts.find((a) => a.host.toLowerCase() === host);
  if (account) return account.provider;
  if (host === 'github.com' || host.endsWith('.ghe.com')) return 'github';
  if (host === 'gitlab.com' || host.includes('gitlab')) return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  if (host.includes('gitea') || host.includes('codeberg') || host.includes('forgejo')) return 'gitea';
  return null;
}

@Component({
  selector: 'gt-provider-mark',
  template: `<svg
    class="inline-block flex-none text-fg"
    [style.width.px]="size()"
    [style.height.px]="size()"
    role="img"
    [attr.viewBox]="logo().viewBox"
    [attr.aria-label]="name()"
  >
    <title>{{ name() }}</title>
    <path [attr.d]="logo().path" [attr.fill]="logo().color" />
  </svg>`,
})
export class ProviderMark {
  readonly provider = input.required<ProviderKind>();
  readonly size = input(22);
  protected readonly logo = computed(() => LOGOS[this.provider()]);
  name() {
    return NAMES[this.provider()];
  }
}
