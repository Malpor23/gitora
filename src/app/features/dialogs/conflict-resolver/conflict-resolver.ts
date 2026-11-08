import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TPipe } from '@core/i18n/i18n';
import {
  BridgeService,
  DIALOG_DATA,
  DIALOG_REF,
  DialogRef,
  NotifyService,
  SettingsService,
} from '@core/services';
import { RepositoryStore } from '@core/store';
import { Icon } from '@shared/components';

interface Block {
  kind: 'text' | 'conflict';
  text?: string;
  ours?: string;
  theirs?: string;
  choice?: 'ours' | 'theirs' | 'both' | null;
}

@Component({
  imports: [FormsModule, TPipe, Icon],
  selector: 'gt-conflict-resolver',
  templateUrl: './conflict-resolver.html',
})
export class ConflictResolver {
  readonly data = inject(DIALOG_DATA) as { store: RepositoryStore; path: string };
  readonly ref = inject(DIALOG_REF) as DialogRef;
  private readonly bridge = inject(BridgeService);
  private readonly notify = inject(NotifyService);
  private readonly settings = inject(SettingsService);

  readonly blocks = signal<Block[]>([]);
  readonly result = signal('');
  edited = false;

  constructor() {
    void this.bridge.git('conflictVersions', this.data.store.path(), this.data.path).then((v) => {
      this.blocks.set(parseConflicts(v.merged));
      this.result.set(v.merged);
    });
  }

  choose(i: number, choice: 'ours' | 'theirs' | 'both') {
    this.blocks.update((list) => list.map((b, k) => (k === i ? { ...b, choice } : b)));
    this.rebuild();
  }

  all(choice: 'ours' | 'theirs') {
    this.blocks.update((list) => list.map((b) => (b.kind === 'conflict' ? { ...b, choice } : b)));
    this.rebuild();
  }

  private rebuild() {
    this.result.set(
      this.blocks()
        .map((b) => {
          if (b.kind === 'text') return b.text!;
          if (b.choice === 'ours') return b.ours!;
          if (b.choice === 'theirs') return b.theirs!;
          if (b.choice === 'both') return b.ours! + b.theirs!;
          return `<<<<<<< ours\n${b.ours}=======\n${b.theirs}>>>>>>> theirs\n`;
        })
        .join(''),
    );
  }

  hasMarkers() {
    return /^(<<<<<<<|>>>>>>>)( |$)/m.test(this.result());
  }

  async save() {
    const s = this.data.store;
    await s.run(() => this.bridge.git('saveResolution', s.path(), this.data.path, this.result()));
    this.ref.close(true);
  }

  async mergetool() {
    const s = this.data.store;
    this.ref.close();
    await s.run(() =>
      this.bridge.git('mergetool', s.path(), this.data.path, this.settings.value.externalMergeTool),
    );
  }
}

/** Separa el archivo en bloques normales y bloques con marcadores de conflicto. */
function parseConflicts(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split(/(?<=\n)/);
  let buf = '';
  let state: 'text' | 'ours' | 'base' | 'theirs' = 'text';
  let ours = '';
  let theirs = '';
  for (const line of lines) {
    if (state === 'text' && line.startsWith('<<<<<<<')) {
      if (buf) blocks.push({ kind: 'text', text: buf });
      buf = '';
      ours = '';
      theirs = '';
      state = 'ours';
    } else if (state === 'ours' && line.startsWith('|||||||')) {
      state = 'base';
    } else if ((state === 'ours' || state === 'base') && line.startsWith('=======')) {
      state = 'theirs';
    } else if (state === 'theirs' && line.startsWith('>>>>>>>')) {
      blocks.push({ kind: 'conflict', ours, theirs, choice: null });
      state = 'text';
    } else if (state === 'ours') ours += line;
    else if (state === 'theirs') theirs += line;
    else if (state === 'text') buf += line;
  }
  if (buf) blocks.push({ kind: 'text', text: buf });
  return blocks;
}
