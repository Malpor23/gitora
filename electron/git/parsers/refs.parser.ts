import type {
  BlameLine, Branch, ReflogEntry, Remote, Stash, Submodule, Tag, Worktree,
} from '@core/models';
import { FIELD_SEP } from './log.parser';

export const BRANCH_FORMAT = [
  '%(refname)', '%(refname:short)', '%(objectname)', '%(upstream:short)',
  '%(upstream:track,nobracket)', '%(HEAD)', '%(committerdate:iso-strict)',
  '%(contents:subject)', '%(authorname)',
].join('%1f');

export function parseBranches(output: string): Branch[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(FIELD_SEP);
      const fullName = f[0];
      const isRemote = fullName.startsWith('refs/remotes/');
      const short = f[1];
      const track = f[4] ?? '';
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      return {
        name: short,
        fullName,
        remote: isRemote ? short.split('/')[0] : null,
        current: f[5] === '*',
        hash: f[2],
        upstream: f[3] || null,
        upstreamGone: track === 'gone',
        ahead: ahead ? +ahead[1] : 0,
        behind: behind ? +behind[1] : 0,
        date: f[6],
        subject: f[7] ?? '',
        author: f[8] ?? '',
      } satisfies Branch;
    })
    .filter((b) => !(b.remote && b.name.endsWith('/HEAD')) && b.name !== b.remote);
}

export const TAG_FORMAT = [
  '%(refname:short)', '%(objecttype)', '%(objectname)', '%(*objectname)',
  '%(contents:subject)', '%(creatordate:iso-strict)',
].join('%1f');

export function parseTags(output: string): Tag[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(FIELD_SEP);
      const annotated = f[1] === 'tag';
      return {
        name: f[0],
        annotated,
        hash: annotated && f[3] ? f[3] : f[2],
        message: annotated ? f[4] ?? '' : '',
        date: f[5] ?? '',
      } satisfies Tag;
    });
}

/** `git remote -v` */
export function parseRemotes(output: string): Remote[] {
  const map = new Map<string, Remote>();
  for (const line of output.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

export const STASH_FORMAT = ['%gd', '%H', '%gs', '%cI'].join('%x1f');

export function parseStashes(output: string): Stash[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(FIELD_SEP);
      const idx = /\{(\d+)\}/.exec(f[0]);
      return {
        ref: f[0],
        index: idx ? +idx[1] : 0,
        hash: f[1],
        message: (f[2] ?? '').replace(/^(WIP on|On) [^:]+:\s*/, ''),
        date: f[3] ?? '',
      };
    });
}

/** `git submodule status --recursive` → " 1a2b3c path (v1.0)", "-hash path", "+hash path", "Uhash path" */
export function parseSubmodules(output: string): Submodule[] {
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const flag = line[0];
      const rest = line.slice(1).trim();
      const [hash, path, ...desc] = rest.split(' ');
      const status: Submodule['status'] =
        flag === '-' ? 'uninitialized' : flag === '+' ? 'modified' : flag === 'U' ? 'conflict' : 'ok';
      return { hash, path, status, describe: desc.join(' ').replace(/^\(|\)$/g, '') };
    });
}

/** `git worktree list --porcelain` */
export function parseWorktrees(output: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: '', branch: null, bare: false, detached: false, locked: false, main: list.length === 0 };
      list.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'bare') cur.bare = true;
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('locked')) cur.locked = true;
  }
  return list;
}

export const REFLOG_FORMAT = ['%H', '%gd', '%gs', '%cI'].join('%x1f');

export function parseReflog(output: string): ReflogEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const f = line.split(FIELD_SEP);
      return { hash: f[0], selector: f[1], action: f[2] ?? '', date: f[3] ?? '' };
    });
}

/** `git blame --porcelain` */
export function parseBlame(output: string): BlameLine[] {
  const meta = new Map<string, { author: string; date: string; summary: string }>();
  const lines: BlameLine[] = [];
  const rows = output.split('\n');
  let i = 0;
  while (i < rows.length) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(rows[i]);
    if (!header) { i++; continue; }
    const hash = header[1];
    const lineNo = +header[2];
    const info = meta.get(hash) ?? { author: '', date: '', summary: '' };
    i++;
    while (i < rows.length && !rows[i].startsWith('\t')) {
      const r = rows[i];
      if (r.startsWith('author ')) info.author = r.slice(7);
      else if (r.startsWith('author-time ')) info.date = new Date(+r.slice(12) * 1000).toISOString();
      else if (r.startsWith('summary ')) info.summary = r.slice(8);
      i++;
    }
    meta.set(hash, info);
    const content = (rows[i] ?? '').slice(1);
    lines.push({ hash, lineNo, content, ...info });
    i++;
  }
  return lines;
}

/** `git show --numstat --format= -M` combinado con --name-status para el detalle de un commit. */
export function parseNameStatus(output: string): { code: string; path: string; origPath?: string }[] {
  const tokens = output.split('\0').filter((t) => t !== '');
  const out: { code: string; path: string; origPath?: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i].trim();
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      out.push({ code: code[0], origPath: tokens[i + 1], path: tokens[i + 2] });
      i += 2;
    } else {
      out.push({ code: code[0], path: tokens[i + 1] });
      i += 1;
    }
  }
  return out;
}

export function parseNumstatTotals(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    if (m[1] !== '-') additions += +m[1];
    if (m[2] !== '-') deletions += +m[2];
  }
  return { additions, deletions };
}
