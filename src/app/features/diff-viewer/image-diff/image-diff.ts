import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeUrl } from '@angular/platform-browser';

import { TPipe } from '@core/i18n/i18n';
import { ImageBlob } from '@core/models';
import { BridgeService } from '@core/services';

/** Dónde vive una versión de la imagen: `rev` null = árbol de trabajo, '' = índice, otro = commit. */
export interface ImageRef {
  rev: string | null;
  path: string;
}

export type ImageDiffMode = 'side' | 'swipe' | 'blend';

interface Loaded {
  url: SafeUrl;
  size: number;
}

@Component({
  imports: [TPipe],
  selector: 'gt-image-diff',
  host: { class: 'flex flex-col min-h-0 flex-1' },
  templateUrl: './image-diff.html',
})
export class ImageDiff {
  private readonly bridge = inject(BridgeService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly repo = input.required<string>();
  /** Versión anterior; null si el archivo es nuevo. */
  readonly before = input<ImageRef | null>(null);
  /** Versión nueva; null si el archivo se eliminó. */
  readonly after = input<ImageRef | null>(null);

  readonly mode = signal<ImageDiffMode>('side');
  /** Posición del deslizador (0-100) usada por los modos swipe y blend. */
  readonly position = signal(50);

  readonly loading = signal(true);
  readonly beforeImg = signal<Loaded | null>(null);
  readonly afterImg = signal<Loaded | null>(null);
  /** Tamaño en píxeles de cada imagen, conocido cuando el navegador la decodifica. */
  readonly beforeDims = signal<string | null>(null);
  readonly afterDims = signal<string | null>(null);

  /** Comparar encima solo tiene sentido si existen las dos versiones. */
  readonly canCompare = computed(() => !!this.beforeImg() && !!this.afterImg());
  readonly activeMode = computed<ImageDiffMode>(() => (this.canCompare() ? this.mode() : 'side'));
  readonly clip = computed(() => `inset(0 ${100 - this.position()}% 0 0)`);
  readonly opacity = computed(() => this.position() / 100);

  private token = 0;

  constructor() {
    effect(() => {
      const repo = this.repo();
      const before = this.before();
      const after = this.after();
      const mine = ++this.token;
      this.loading.set(true);
      this.beforeImg.set(null);
      this.afterImg.set(null);
      this.beforeDims.set(null);
      this.afterDims.set(null);
      void Promise.all([this.load(repo, before), this.load(repo, after)]).then(([b, a]) => {
        // Si mientras tanto se eligió otro archivo, este resultado ya no sirve.
        if (mine !== this.token) return;
        this.beforeImg.set(b);
        this.afterImg.set(a);
        this.loading.set(false);
      });
    });
  }

  onSlider(e: Event) {
    this.position.set(Number((e.target as HTMLInputElement).value));
  }

  onLoad(e: Event, side: 'before' | 'after') {
    const img = e.target as HTMLImageElement;
    const text = `${img.naturalWidth} × ${img.naturalHeight}`;
    (side === 'before' ? this.beforeDims : this.afterDims).set(text);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private async load(repo: string, ref: ImageRef | null): Promise<Loaded | null> {
    if (!ref) return null;
    try {
      const blob: ImageBlob | null = await this.bridge.git('imageBlob', repo, ref.rev, ref.path);
      if (!blob) return null;
      // El tipo MIME sale de una lista fija de extensiones y el contenido es base64 de git:
      // por eso es seguro marcar la URL como confiable (el saneador de Angular rechaza p. ej. image/x-icon).
      const url = this.sanitizer.bypassSecurityTrustUrl(`data:${blob.mime};base64,${blob.base64}`);
      return { url, size: blob.size };
    } catch {
      return null;
    }
  }
}
