import type { BenchmarkResult, FileSize, RepoContributor, RepoStats } from '@core/models';
import type { Exec } from './git-flow';

const num = (s: string) => Number.parseInt(s.trim(), 10) || 0;

/** Los 12 meses terminados en el mes de `now`, de más antiguo a más reciente (`YYYY-MM`). */
export function lastMonths(now: Date, count = 12): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** `git shortlog -sne`: "  12\tNombre <correo>" por línea. */
export function parseShortlog(out: string): RepoContributor[] {
  const list: RepoContributor[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\t(.*?)\s*<([^>]*)>\s*$/.exec(line);
    if (m) list.push({ commits: Number(m[1]), name: m[2], email: m[3] });
  }
  return list.sort((a, b) => b.commits - a.commits);
}

/** `git count-objects -v`: tamaño total (sueltos + packs) en KiB. */
export function parseSizeKb(out: string): number {
  const fields = new Map<string, number>();
  for (const line of out.split('\n')) {
    const [k, v] = line.split(':');
    if (k && v !== undefined) fields.set(k.trim(), num(v));
  }
  return (fields.get('size') ?? 0) + (fields.get('size-pack') ?? 0);
}

/** `git ls-tree -r -l -z`: "modo tipo hash   tamaño\truta" separados por NUL; solo blobs. */
export function parseFileSizes(out: string): FileSize[] {
  const files: FileSize[] = [];
  for (const rec of out.split('\0')) {
    const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/s.exec(rec);
    if (m) files.push({ path: m[2], size: Number(m[1]) });
  }
  return files;
}

const lines = (out: string) => out.split('\n').filter((l) => l.trim() !== '');

export async function repoStats(git: Exec, now = new Date()): Promise<RepoStats> {
  const quiet = { silent: true };
  const safe = (args: string[]) => git(args, quiet).catch(() => '');

  const [count, branches, tags, tree, roots, last, size, shortlog] = await Promise.all([
    safe(['rev-list', '--count', '--all']),
    safe(['for-each-ref', '--format=%(refname)', 'refs/heads']),
    safe(['for-each-ref', '--format=%(refname)', 'refs/tags']),
    safe(['ls-tree', '-r', '--name-only', '-z', 'HEAD']),
    safe(['log', '--all', '--max-parents=0', '--format=%aI']),
    safe(['log', '--all', '-1', '--format=%aI']),
    safe(['count-objects', '-v']),
    safe(['shortlog', '-sne', '--all']),
  ]);

  const months = lastMonths(now);
  const since = `${months[0]}-01`;
  const activityOut = await safe([
    'log',
    '--all',
    `--since=${since}`,
    '--format=%ad',
    '--date=format:%Y-%m',
  ]);
  const perMonth = new Map<string, number>(months.map((m) => [m, 0]));
  for (const m of lines(activityOut))
    if (perMonth.has(m)) perMonth.set(m, (perMonth.get(m) ?? 0) + 1);

  const rootDates = lines(roots).sort();
  return {
    commits: num(count),
    branches: lines(branches).length,
    tags: lines(tags).length,
    files: tree.split('\0').filter(Boolean).length,
    firstCommit: rootDates[0] ?? null,
    lastCommit: lines(last)[0] ?? null,
    sizeKb: parseSizeKb(size),
    contributors: parseShortlog(shortlog).slice(0, 50),
    activity: months.map((month) => ({ month, commits: perMonth.get(month) ?? 0 })),
  };
}

export async function fileSizes(git: Exec): Promise<FileSize[]> {
  const out = await git(['ls-tree', '-r', '-l', '-z', 'HEAD'], { silent: true }).catch(() => '');
  return parseFileSizes(out);
}

const BENCHMARKS: { name: string; args: string[] }[] = [
  { name: 'dialogs.benchmark.tests.status', args: ['status', '--porcelain=v2', '--branch'] },
  { name: 'dialogs.benchmark.tests.log', args: ['log', '-n', '1000', '--format=%H'] },
  { name: 'dialogs.benchmark.tests.branches', args: ['branch', '-a'] },
  { name: 'dialogs.benchmark.tests.count', args: ['rev-list', '--count', 'HEAD'] },
  { name: 'dialogs.benchmark.tests.files', args: ['ls-files'] },
  { name: 'dialogs.benchmark.tests.diff', args: ['diff', '--stat', 'HEAD'] },
  { name: 'dialogs.benchmark.tests.objects', args: ['count-objects', '-v'] },
];

/** Mide, de uno en uno, cuánto tarda git en operaciones habituales (no se registran en la consola). */
export async function benchmark(git: Exec): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const b of BENCHMARKS) {
    const start = performance.now();
    const ok = await git(b.args, { silent: true }).then(
      () => true,
      () => false,
    );
    results.push({
      name: b.name,
      command: `git ${b.args.join(' ')}`,
      ms: ok ? Math.round((performance.now() - start) * 10) / 10 : null,
    });
  }
  return results;
}
