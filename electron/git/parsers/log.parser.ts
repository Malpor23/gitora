import type { Commit, RefLabel } from '@core/models';

/** Separadores improbables en mensajes: US (0x1f) entre campos y RS (0x1e) entre commits. */
export const FIELD_SEP = '\x1f';
export const RECORD_SEP = '\x1e';

export const LOG_FORMAT = [
  '%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%D', '%s', '%b',
].join('%x1f') + '%x1e';

export function parseLog(output: string, remotes: string[] = []): Commit[] {
  return output
    .split(RECORD_SEP)
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.length > 0)
    .map((record) => {
      const f = record.split(FIELD_SEP);
      return {
        hash: f[0],
        shortHash: f[1],
        parents: f[2] ? f[2].split(' ') : [],
        author: f[3],
        authorEmail: f[4],
        authorDate: f[5],
        committer: f[6],
        committerEmail: f[7],
        committerDate: f[8],
        refs: parseRefs(f[9] ?? '', remotes),
        subject: f[10] ?? '',
        body: (f[11] ?? '').trim(),
      } satisfies Commit;
    });
}

/**
 * Interpreta el campo %D: "HEAD -> main, origin/main, origin/HEAD, tag: v1.0, refs/stash".
 */
export function parseRefs(decoration: string, remotes: string[]): RefLabel[] {
  if (!decoration.trim()) return [];
  const labels: RefLabel[] = [];
  for (const raw of decoration.split(', ')) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith('HEAD -> ')) {
      labels.push({ name: part.slice(8), type: 'branch', current: true });
    } else if (part === 'HEAD') {
      labels.push({ name: 'HEAD', type: 'head', current: true });
    } else if (part.startsWith('tag: ')) {
      labels.push({ name: part.slice(5), type: 'tag' });
    } else if (part === 'refs/stash') {
      labels.push({ name: 'stash', type: 'stash' });
    } else if (part.endsWith('/HEAD')) {
      continue; // origin/HEAD no aporta
    } else if (remotes.some((r) => part.startsWith(r + '/'))) {
      labels.push({ name: part, type: 'remote' });
    } else {
      labels.push({ name: part, type: 'branch' });
    }
  }
  return labels;
}
