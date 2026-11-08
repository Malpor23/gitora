import { FSWatcher, watch } from 'node:fs';
import * as path from 'node:path';

/**
 * Observa cambios del repositorio para refrescar la UI sin que el usuario pulse nada.
 * - Siempre vigila la carpeta .git (HEAD, index, refs): barato y suficiente para
 *   detectar commits, checkouts y operaciones hechas desde la terminal.
 * - Opcionalmente vigila el working tree completo (en Linux puede agotar inotify en
 *   repos enormes; por eso viene desactivado por defecto ahí y se refresca al enfocar).
 */
export class RepoWatcher {
  private watchers = new Map<string, FSWatcher[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private dirs = new Map<string, string>();

  constructor(private readonly notify: (repo: string, gitOnly: boolean) => void) {}

  watch(repo: string, gitDir: string, workingTree: boolean) {
    this.unwatch(repo);
    this.dirs.set(repo, gitDir);
    const list: FSWatcher[] = [];
    const safe = (target: string, recursive: boolean, cb: (file: string) => void) => {
      try {
        list.push(watch(target, { recursive }, (_evt, file) => cb(String(file ?? ''))));
      } catch {
        /* p. ej. carpeta inexistente */
      }
    };

    safe(gitDir, false, (file) => {
      if (/^(HEAD|index|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs)$/.test(file)) {
        this.debounce(repo, true);
      }
    });
    safe(path.join(gitDir, 'refs'), true, () => this.debounce(repo, true));

    if (workingTree) {
      safe(repo, true, (file) => {
        const norm = file.replace(/\\/g, '/');
        if (norm.startsWith('.git/') || norm === '.git' || /(^|\/)node_modules\//.test(norm)) return;
        this.debounce(repo, false);
      });
    }
    this.watchers.set(repo, list);
  }

  unwatch(repo: string) {
    this.watchers.get(repo)?.forEach((w) => w.close());
    this.watchers.delete(repo);
  }

  /** Reaplica la vigilancia del working tree a los repos ya abiertos (cambio de ajuste en caliente). */
  setWorkingTree(on: boolean) {
    for (const [repo, gitDir] of this.dirs) if (this.watchers.has(repo)) this.watch(repo, gitDir, on);
  }

  dispose() {
    for (const repo of [...this.watchers.keys()]) this.unwatch(repo);
  }

  private debounce(repo: string, gitOnly: boolean) {
    clearTimeout(this.timers.get(repo));
    this.timers.set(repo, setTimeout(() => this.notify(repo, gitOnly), 350));
  }
}
