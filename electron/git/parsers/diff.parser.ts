import type { DiffFile, DiffHunk } from '@core/models';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parser de diff unificado (`git diff`, `git show`, `git stash show -p`). */
export function parseDiff(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = output.split('\n');
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHeader = false;

  const finish = () => {
    if (file) files.push(file);
    file = null;
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      finish();
      const paths = parseDiffGitPaths(line);
      file = {
        oldPath: paths.old,
        newPath: paths.new,
        headerLines: [line],
        isNew: false,
        isDeleted: false,
        isRename: false,
        isBinary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      inHeader = true;
      continue;
    }
    if (!file) continue;
    const f: DiffFile = file;

    if (inHeader && !line.startsWith('@@')) {
      f.headerLines.push(line);
      if (line.startsWith('new file mode')) f.isNew = true;
      else if (line.startsWith('deleted file mode')) f.isDeleted = true;
      else if (line.startsWith('rename from ')) { f.isRename = true; f.oldPath = unquote(line.slice(12)); }
      else if (line.startsWith('rename to ')) { f.isRename = true; f.newPath = unquote(line.slice(10)); }
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.isBinary = true;
      else if (line.startsWith('--- ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') f.oldPath = stripPrefix(unquote(p));
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4);
        if (p !== '/dev/null') f.newPath = stripPrefix(unquote(p));
      }
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      inHeader = false;
      hunk = {
        header: line,
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        section: m[5] ?? '',
        lines: [],
      };
      f.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const h: DiffHunk = hunk;

    const c = line[0];
    if (c === '+') {
      h.lines.push({ type: 'add', content: line.slice(1), oldNo: null, newNo: newNo++ });
      f.additions++;
    } else if (c === '-') {
      h.lines.push({ type: 'del', content: line.slice(1), oldNo: oldNo++, newNo: null });
      f.deletions++;
    } else if (c === ' ') {
      h.lines.push({ type: 'ctx', content: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === '\\') {
      h.lines.push({ type: 'nonewline', content: line.slice(2), oldNo: null, newNo: null });
    } else if (line === '' && i === lines.length - 1) {
      // fin de la salida
    } else if (line === '') {
      // línea vacía de contexto sin el espacio inicial (algunas herramientas la recortan)
      h.lines.push({ type: 'ctx', content: '', oldNo: oldNo++, newNo: newNo++ });
    }
  }
  finish();
  return files;
}

function parseDiffGitPaths(line: string): { old: string; new: string } {
  const rest = line.replace(/^diff --(git|cc|combined) /, '');
  // Caso con comillas: "a/x y" "b/x y"
  const quoted = /^"(.+?)" "(.+?)"$/.exec(rest);
  if (quoted) return { old: stripPrefix(unescapeC(quoted[1])), new: stripPrefix(unescapeC(quoted[2])) };
  // Caso habitual: a/ruta b/ruta (si ambas rutas son iguales podemos partir por la mitad)
  if (rest.startsWith('a/')) {
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half)) {
      const a = rest.slice(0, half);
      const b = rest.slice(half + 1);
      if (a.slice(2) === b.slice(2)) return { old: a.slice(2), new: b.slice(2) };
    }
    const idx = rest.indexOf(' b/');
    if (idx > 0) return { old: rest.slice(2, idx), new: rest.slice(idx + 3) };
  }
  // diff --cc ruta
  return { old: rest, new: rest };
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

function unquote(p: string): string {
  p = p.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) return unescapeC(p.slice(1, -1));
  return p;
}

/** Git escapa rutas con caracteres especiales al estilo C (octal para UTF-8). */
function unescapeC(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (/[0-7]/.test(n)) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      const map: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92, r: 13 };
      bytes.push(map[n] ?? n.charCodeAt(0));
      i += 1;
      continue;
    }
    for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}
