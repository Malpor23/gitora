import type { FileChange, FileChangeKind, RepoStatus } from '@core/models';

/**
 * Parser de `git status --porcelain=v2 --branch -z --untracked-files=all`.
 * Formato documentado en `git help status` (sección "Porcelain Format Version 2").
 */
export function parseStatusV2(output: string): Omit<RepoStatus, 'state'> {
  const result: Omit<RepoStatus, 'state'> = {
    head: '',
    oid: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicted: [],
  };

  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;

    if (entry.startsWith('# ')) {
      parseHeader(entry.slice(2), result);
      continue;
    }

    const type = entry[0];
    if (type === '?') {
      result.unstaged.push({ path: entry.slice(2), kind: 'untracked', code: '??' });
    } else if (type === '!') {
      // ignorados: no se muestran
    } else if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = splitN(entry, 9);
      pushOrdinary(result, parts[1], parts[2], parts[8]);
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const parts = splitN(entry, 10);
      const origPath = tokens[++i];
      pushOrdinary(result, parts[1], parts[2], parts[9], origPath);
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = splitN(entry, 11);
      result.conflicted.push({ path: parts[10], kind: 'conflicted', code: parts[1] });
    }
  }
  return result;
}

function parseHeader(line: string, r: Omit<RepoStatus, 'state'>) {
  const [key, ...rest] = line.split(' ');
  const value = rest.join(' ');
  switch (key) {
    case 'branch.oid':
      r.oid = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      if (value === '(detached)') {
        r.detached = true;
      } else {
        r.head = value;
      }
      break;
    case 'branch.upstream':
      r.upstream = value;
      break;
    case 'branch.ab': {
      const m = /\+(\d+) -(\d+)/.exec(value);
      if (m) {
        r.ahead = +m[1];
        r.behind = +m[2];
      }
      break;
    }
  }
  if (r.detached && r.oid) r.head = r.oid.slice(0, 8);
}

function pushOrdinary(
  r: Omit<RepoStatus, 'state'>,
  xy: string,
  sub: string,
  path: string,
  origPath?: string,
) {
  const x = xy[0];
  const y = xy[1];
  const submodule = sub[0] === 'S';
  if (x !== '.') {
    r.staged.push(withOrig({ path, kind: kindFromCode(x), code: xy, submodule }, origPath));
  }
  if (y !== '.') {
    // En el working tree un rename aún no existe: git lo informa como modificación.
    r.unstaged.push({ path, kind: kindFromCode(y), code: xy, submodule });
  }
}

function withOrig(f: FileChange, origPath?: string): FileChange {
  if (origPath) f.origPath = origPath;
  return f;
}

export function kindFromCode(c: string): FileChangeKind {
  switch (c) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'typechange';
    case 'U': return 'conflicted';
    case '?': return 'untracked';
    case '!': return 'ignored';
    default: return 'modified';
  }
}

/** Divide en n campos por espacio; el último conserva espacios (rutas con espacios). */
export function splitN(s: string, n: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const idx = s.indexOf(' ', start);
    if (idx === -1) break;
    out.push(s.slice(start, idx));
    start = idx + 1;
  }
  out.push(s.slice(start));
  return out;
}
