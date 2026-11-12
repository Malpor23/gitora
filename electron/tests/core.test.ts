import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildHunkPatch } from '../../shared/patch';
import { appMenuTemplate, REPOSITORY_MENU } from '../app-menu';
import { createEditorHelper } from '../git/editor-helper';
import { GitRunner } from '../git/git-runner';
import { BitbucketProvider } from '../providers/bitbucket.provider';
import { GiteaProvider } from '../providers/gitea.provider';
import { GitHubProvider } from '../providers/github.provider';
import { GitLabProvider } from '../providers/gitlab.provider';
import { normalizeApi } from '../providers/provider-registry';
import { GitService } from '../git/git-service';
import { parseRemoteUrl } from '../providers/provider';

/**
 * Pruebas de integración del núcleo: se ejecutan contra repositorios git reales
 * en una carpeta temporal (sin Electron). `npm run test:core`
 */
const tmp = mkdtempSync(path.join(os.tmpdir(), 'gitora-test-'));
const runner = new GitRunner('git');
const editor = createEditorHelper(tmp, process.execPath);
const git = new GitService(runner, () => [], editor, path.join(tmp, 'work'));
const repo = path.join(tmp, 'repo');
const write = (f: string, s: string) => writeFileSync(path.join(repo, f), s);

before(async () => {
  await git.init(repo, false, 'main');
  await git.setIdentity(repo, { name: 'Prueba', email: 'prueba@example.com' }, false);
  await git.configSet(repo, 'commit.gpgsign', 'false', 'local');
});

after(() => { /* la carpeta temporal la limpia el sistema */ });

describe('repositorio y commits', () => {
  it('abre el repo y empieza sin commits', async () => {
    const info = await git.open(repo);
    assert.equal(info.name, 'repo');
    const st = await git.status(repo);
    assert.equal(st.oid, null);
    assert.equal(st.head, 'main');
    assert.deepEqual(await git.log(repo, {}), []);
  });

  it('detecta archivos nuevos, hace stage y commit', async () => {
    write('a.txt', 'uno\ndos\ntres\ncuatro\ncinco\n');
    write('con espacio ñ.txt', 'hola\n');
    let st = await git.status(repo);
    assert.equal(st.unstaged.length, 2);
    assert.ok(st.unstaged.some((f) => f.path === 'con espacio ñ.txt' && f.kind === 'untracked'));
    await git.stageAll(repo);
    st = await git.status(repo);
    assert.equal(st.staged.length, 2);
    const hash = await git.commit(repo, { message: 'Primer commit\n\nCuerpo del mensaje' });
    const log = await git.log(repo, {});
    assert.equal(log[0].hash, hash);
    assert.equal(log[0].subject, 'Primer commit');
    assert.equal(log[0].body, 'Cuerpo del mensaje');
    assert.ok(log[0].refs.some((r) => r.name === 'main' && r.current));
  });

  it('hace stage de una sola línea de un hunk', async () => {
    write('a.txt', 'uno\nDOS\ntres\ncuatro\nCINCO\n');
    const diff = await git.diffWorking(repo, 'a.txt', false, 3, false);
    assert.ok(diff);
    assert.equal(diff!.hunks.length, 1);
    const lines = diff!.hunks[0].lines;
    // seleccionamos solo el par -dos/+DOS
    const sel = lines.map((l, i) => ({ l, i })).filter(({ l }) => /dos/i.test(l.content) && l.type !== 'ctx').map(({ i }) => i);
    await git.applyPatch(repo, buildHunkPatch(diff!, 0, sel, 'forward'), 'stage');
    const staged = await git.diffWorking(repo, 'a.txt', true, 3, false);
    assert.equal(staged!.additions, 1);
    assert.equal(staged!.deletions, 1);
    const unstaged = await git.diffWorking(repo, 'a.txt', false, 3, false);
    assert.equal(unstaged!.additions, 1);
    assert.ok(unstaged!.hunks[0].lines.some((l) => l.content === 'CINCO'));

    // y lo devolvemos (unstage de la línea)
    const stagedLines = staged!.hunks[0].lines.map((_, i) => i);
    await git.applyPatch(repo, buildHunkPatch(staged!, 0, stagedLines, 'reverse'), 'unstage');
    assert.equal((await git.status(repo)).staged.length, 0);
    await git.discard(repo, ['a.txt']);
    assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'uno\ndos\ntres\ncuatro\ncinco\n');
  });
});

describe('ramas, merge, stash y tags', () => {
  it('crea ramas, hace merge con conflicto y lo resuelve', async () => {
    await git.createBranch(repo, 'feature/login', '', true);
    write('a.txt', 'uno\ndos-feature\ntres\ncuatro\ncinco\n');
    await git.stageAll(repo);
    await git.commit(repo, { message: 'Cambio en feature' });
    await git.checkout(repo, 'main', {});
    write('a.txt', 'uno\ndos-main\ntres\ncuatro\ncinco\n');
    await git.stageAll(repo);
    await git.commit(repo, { message: 'Cambio en main' });

    const branches = await git.branches(repo);
    assert.ok(branches.find((b) => b.name === 'feature/login'));
    assert.ok(branches.find((b) => b.name === 'main' && b.current));

    await assert.rejects(git.merge(repo, { ref: 'feature/login' }));
    let st = await git.status(repo);
    assert.equal(st.state, 'merging');
    assert.equal(st.conflicted[0].path, 'a.txt');
    const versions = await git.conflictVersions(repo, 'a.txt');
    assert.ok(versions.ours?.includes('dos-main'));
    assert.ok(versions.theirs?.includes('dos-feature'));
    await git.resolveWith(repo, 'a.txt', 'theirs');
    await git.mergeContinue(repo);
    st = await git.status(repo);
    assert.equal(st.state, 'clean');
    const [merge] = await git.log(repo, { limit: 1 });
    assert.equal(merge.parents.length, 2);
    const details = await git.show(repo, merge.hash);
    assert.ok(details.files.length >= 1);
  });

  it('stash push / list / pop', async () => {
    write('b.txt', 'temporal\n');
    await git.stashSave(repo, { message: 'mi stash', includeUntracked: true });
    let stashes = await git.stashes(repo);
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].message, 'mi stash');
    const diff = await git.stashDiff(repo, 0);
    assert.ok(Array.isArray(diff));
    await git.stashPop(repo, 0);
    stashes = await git.stashes(repo);
    assert.equal(stashes.length, 0);
    await git.discard(repo, ['b.txt']);
  });

  it('tags ligeros y anotados', async () => {
    await git.createTag(repo, { name: 'v1.0.0', ref: 'HEAD', message: 'Versión 1' });
    await git.createTag(repo, { name: 'ligero', ref: 'HEAD~1' });
    const tags = await git.tags(repo);
    const v1 = tags.find((t) => t.name === 'v1.0.0')!;
    assert.ok(v1.annotated);
    assert.equal(v1.message, 'Versión 1');
    const [head] = await git.log(repo, { limit: 1 });
    assert.equal(v1.hash, head.hash);
    assert.ok(head.refs.some((r) => r.type === 'tag' && r.name === 'v1.0.0'));
  });
});

describe('rebase interactivo sin terminal', () => {
  it('reordena, renombra (reword) y aplasta (fixup) commits', async () => {
    await git.createBranch(repo, 'limpieza', '', true);
    for (const n of ['c1', 'c2', 'c3']) {
      write(`${n}.txt`, n + '\n');
      await git.stageAll(repo);
      await git.commit(repo, { message: `Commit ${n}` });
    }
    const log = await git.log(repo, { limit: 3 }); // c3, c2, c1
    const [c3, c2, c1] = log;
    await git.rebaseInteractive(repo, `${c1.hash}~1`, [
      { action: 'reword', hash: c1.hash, subject: c1.subject, message: 'Commit uno renombrado' },
      { action: 'pick', hash: c3.hash, subject: c3.subject },
      { action: 'fixup', hash: c2.hash, subject: c2.subject },
    ], false);
    const after = await git.log(repo, { limit: 2 });
    assert.equal(after[0].subject, 'Commit c3');
    assert.equal(after[1].subject, 'Commit uno renombrado');
    assert.equal((await git.status(repo)).state, 'clean');
  });
});

describe('remotos, clone y push', () => {
  it('clona desde un repo bare, hace push y fetch', async () => {
    const bare = path.join(tmp, 'remote.git');
    await git.init(bare, true, 'main');
    await git.addRemote(repo, 'origin', bare);
    await git.push(repo, { remote: 'origin', branch: 'main', setUpstream: true, tags: false });
    const clonePath = path.join(tmp, 'clone');
    const info = await git.clone('', { url: bare, directory: clonePath, opId: 'c1' });
    assert.equal(info.name, 'clone');
    const remotes = await git.remotes(clonePath);
    assert.equal(remotes[0].name, 'origin');
    await git.fetch(clonePath, { prune: true });
    const branches = await git.branches(clonePath);
    assert.ok(branches.find((b) => b.name === 'origin/main' && b.remote === 'origin'));
    const st = await git.status(clonePath);
    assert.equal(st.upstream, 'origin/main');
  });
});

describe('URLs de remotos', () => {
  it('interpreta https, scp y ssh', () => {
    assert.deepEqual(parseRemoteUrl('https://github.com/malpor23/gitora.git'), { host: 'github.com', owner: 'malpor23', repo: 'gitora' });
    assert.deepEqual(parseRemoteUrl('git@gitlab.com:grupo/sub/app.git'), { host: 'gitlab.com', owner: 'grupo/sub', repo: 'app' });
    assert.deepEqual(parseRemoteUrl('ssh://git@gitea.local:2222/yo/proyecto.git'), { host: 'gitea.local', owner: 'yo', repo: 'proyecto' });
  });
});

describe('menú de la aplicación', () => {
  const opts = { isDev: false, isMac: false, appName: 'Gitora', repoActive: true, onCommand: () => undefined };
  const labels = (t: ReturnType<typeof appMenuTemplate>): string[] =>
    t.flatMap((m) => [m.label ?? '', ...(Array.isArray(m.submenu) ? m.submenu.map((i) => i.label ?? '') : [])]);

  it('muestra los menús y sus opciones en español', () => {
    const l = labels(appMenuTemplate('es', opts));
    for (const esperado of ['Archivo', 'Editar', 'Ver', 'Ventana', 'Salir', 'Copiar', 'Pegar', 'Pantalla completa']) {
      assert.ok(l.includes(esperado), `falta "${esperado}"`);
    }
    assert.ok(!l.includes('File') && !l.includes('Copy'));
  });

  it('muestra los menús y sus opciones en inglés', () => {
    const l = labels(appMenuTemplate('en', opts));
    for (const expected of ['File', 'Edit', 'View', 'Window', 'Quit', 'Copy', 'Paste', 'Toggle Full Screen']) {
      assert.ok(l.includes(expected), `missing "${expected}"`);
    }
    assert.ok(!l.includes('Archivo') && !l.includes('Copiar'));
  });

  it('ambos idiomas tienen la misma estructura y los mismos roles', () => {
    const roles = (t: ReturnType<typeof appMenuTemplate>) =>
      t.map((m) => (Array.isArray(m.submenu) ? m.submenu.map((i) => i.role ?? i.type) : []));
    assert.deepEqual(roles(appMenuTemplate('es', opts)), roles(appMenuTemplate('en', opts)));
  });

  it('las opciones de desarrollo solo aparecen en modo dev', () => {
    const view = (dev: boolean) =>
      labels(appMenuTemplate('en', { ...opts, isDev: dev }));
    assert.ok(!view(false).includes('Developer Tools'));
    assert.ok(view(true).includes('Developer Tools'));
  });
});

describe('menú Repository', () => {
  type Item = ReturnType<typeof appMenuTemplate>[number];
  const base = { isDev: false, isMac: false, appName: 'Gitora' };
  const flat = (items: Item[]): Item[] =>
    items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu as Item[]) : [])]);
  const repoMenu = (lang: 'es' | 'en', repoActive = true, onCommand: (id: string) => void = () => undefined) =>
    appMenuTemplate(lang, { ...base, repoActive, onCommand }).find(
      (m) => m.label === (lang === 'es' ? 'Repositorio' : 'Repository'),
    )!;

  it('queda entre Ver y Ventana y se traduce', () => {
    const labels = appMenuTemplate('en', { ...base, repoActive: true, onCommand: () => undefined }).map((m) => m.label);
    assert.deepEqual(labels.slice(-3), ['View', 'Repository', 'Window']);
    const es = flat([repoMenu('es')]).map((i) => i.label);
    for (const l of ['Actualizar', 'Fetch…', 'Pull…', 'Push…', 'Guardar stash…', 'Nueva rama…', 'Nuevo tag…', 'Nuevo worktree…', 'Git Flow', 'Iniciar feature…', 'Iniciar release…', 'Iniciar hotfix…', 'Desinicializar Git Flow…', 'Estadísticas del repositorio…', 'Treemap del repositorio…', 'Benchmark de rendimiento…', 'Ajustes de este repositorio…']) {
      assert.ok(es.includes(l), `falta "${l}"`);
    }
    const en = flat([repoMenu('en')]).map((i) => i.label);
    for (const l of ['Refresh', 'Save Stash…', 'New Branch…', 'New Tag…', 'New Worktree…', 'Start Feature…', 'Start Release…', 'Start Hotfix…', 'Deinitialize Git Flow…', 'Repository Statistics…', 'Repository Treemap…', 'Performance Benchmark…', 'Settings for this Repository…']) {
      assert.ok(en.includes(l), `missing "${l}"`);
    }
  });

  it('cada entrada ejecuta su comando', () => {
    const ran: string[] = [];
    const items = flat([repoMenu('en', true, (id) => ran.push(id))]).filter((i) => i.click);
    for (const i of items) (i.click as () => void)();
    assert.deepEqual([...ran].sort(), Object.values(REPOSITORY_MENU).sort());
  });

  it('se deshabilita sin repositorio activo', () => {
    const leaves = (repoActive: boolean) =>
      flat([repoMenu('es', repoActive)]).filter((i) => i.type !== 'separator' && i.label);
    assert.ok(leaves(false).slice(1).every((i) => i.enabled === false));
    assert.ok(leaves(true).slice(1).every((i) => i.enabled !== false));
  });

  it('Ctrl+W sigue siendo de la app: "Cerrar ventana" no registra el atajo del sistema', () => {
    for (const lang of ['es', 'en'] as const) {
      const closes = flat(appMenuTemplate(lang, { ...base, repoActive: true, onCommand: () => undefined })).filter(
        (i) => i.role === 'close',
      );
      assert.ok(closes.length >= 2, 'hay entradas de cerrar ventana');
      assert.ok(closes.every((i) => i.registerAccelerator === false));
    }
  });
});

describe('Git Flow, estadísticas, treemap y benchmark (git real)', () => {
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' } }).trim();
  const fresh = (name: string) => {
    const dir = path.join(tmp, name);
    sh(tmp, 'init', '-q', '-b', 'main', dir);
    sh(dir, 'config', 'user.name', 'Ana');
    sh(dir, 'config', 'user.email', 'ana@example.com');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    return dir;
  };
  const put = (dir: string, f: string, s: string) => {
    const full = path.join(dir, f);
    execFileSync('mkdir', ['-p', path.dirname(full)]);
    writeFileSync(full, s);
  };
  const cfg = { master: 'main', develop: 'develop', feature: 'feature/', release: 'release/', hotfix: 'hotfix/', versionTag: '' };

  it('Git Flow: init, start feature/release/hotfix y deinit', async () => {
    const dir = fresh('flow');
    put(dir, 'a.txt', 'a');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'inicial');
    assert.equal(await git.flowStatus(dir), null);

    await assert.rejects(() => git.flowStart(dir, 'feature', 'x'), /no está inicializado/);
    await assert.rejects(() => git.flowInit(dir, { ...cfg, master: 'nope' }), /no existe/);
    await assert.rejects(() => git.flowInit(dir, { ...cfg, develop: 'main' }), /distintas/);

    await git.flowInit(dir, cfg);
    assert.deepEqual(await git.flowStatus(dir), cfg);
    assert.equal(sh(dir, 'rev-parse', 'develop'), sh(dir, 'rev-parse', 'main'));

    // develop avanza: una feature sale de develop y un hotfix de main
    sh(dir, 'checkout', '-q', 'develop');
    put(dir, 'dev.txt', 'd');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'en develop');
    assert.equal(await git.flowStart(dir, 'feature', 'login'), 'feature/login');
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/login');
    assert.equal(sh(dir, 'rev-parse', 'feature/login'), sh(dir, 'rev-parse', 'develop'));
    assert.equal(await git.flowStart(dir, 'hotfix', '1.0.1'), 'hotfix/1.0.1');
    assert.equal(sh(dir, 'rev-parse', 'hotfix/1.0.1'), sh(dir, 'rev-parse', 'main'));
    sh(dir, 'checkout', '-q', 'develop');
    assert.equal(await git.flowStart(dir, 'release', '2.0.0'), 'release/2.0.0');

    await assert.rejects(() => git.flowStart(dir, 'feature', 'login'), /ya existe/);
    await assert.rejects(() => git.flowStart(dir, 'feature', 'nombre con espacio'), /no es un nombre de rama válido/);
    await assert.rejects(() => git.flowStart(dir, 'feature', '   '), /vacío/);

    await git.flowDeinit(dir);
    assert.equal(await git.flowStatus(dir), null);
    assert.ok(sh(dir, 'branch', '--list', 'feature/login'), 'deinit no borra ramas');
  });

  it('estadísticas: conteos, colaboradores y actividad', async () => {
    const dir = fresh('stats');
    const s0 = await git.repoStats(dir);
    assert.equal(s0.commits, 0);
    assert.equal(s0.files, 0);
    assert.equal(s0.firstCommit, null);
    assert.equal(s0.activity.length, 12);

    put(dir, 'a.txt', '1');
    put(dir, 'src/b.txt', '2');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'uno');
    put(dir, 'a.txt', '1b');
    sh(dir, 'commit', '-qam', 'dos');
    put(dir, 'c.txt', '3');
    sh(dir, 'add', '.');
    sh(dir, '-c', 'user.name=Beto', '-c', 'user.email=beto@example.com', 'commit', '-qm', 'tres');
    sh(dir, 'tag', 'v1');
    sh(dir, 'branch', 'otra');

    const s = await git.repoStats(dir);
    assert.equal(s.commits, 3);
    assert.equal(s.branches, 2);
    assert.equal(s.tags, 1);
    assert.equal(s.files, 3);
    assert.deepEqual(s.contributors.map((c) => [c.name, c.email, c.commits]), [
      ['Ana', 'ana@example.com', 2],
      ['Beto', 'beto@example.com', 1],
    ]);
    assert.ok(s.firstCommit && s.lastCommit && s.firstCommit <= s.lastCommit);
    assert.ok(s.sizeKb > 0);
    assert.equal(s.activity.length, 12);
    assert.equal(s.activity.reduce((n, a) => n + a.commits, 0), 3);
    assert.equal(s.activity.at(-1)!.commits, 3);
  });

  it('treemap: tamaños de los archivos versionados', async () => {
    const dir = fresh('sizes');
    assert.deepEqual(await git.fileSizes(dir), []);
    put(dir, 'big.bin', 'x'.repeat(5000));
    put(dir, 'dir/con espacio.txt', 'abc');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'archivos');
    put(dir, 'sin-versionar.txt', 'no cuenta');
    const files = (await git.fileSizes(dir)).sort((a, b) => b.size - a.size);
    assert.deepEqual(files, [
      { path: 'big.bin', size: 5000 },
      { path: 'dir/con espacio.txt', size: 3 },
    ]);
  });

  it('benchmark: mide cada prueba sin ensuciar la consola', async () => {
    const dir = fresh('bench');
    put(dir, 'a.txt', '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'uno');
    const before = runner.getHistory().length;
    const res = await git.benchmark(dir);
    assert.equal(res.length, 7);
    assert.ok(res.every((r) => r.command.startsWith('git ') && r.name.startsWith('dialogs.benchmark.tests.')));
    assert.ok(res.every((r) => typeof r.ms === 'number' && r.ms >= 0));
    assert.equal(runner.getHistory().length, before, 'las mediciones son silenciosas');
  });

  it('stash: "Stage new files" incluye los archivos nuevos; sin la opción los ignora', async () => {
    const dir = fresh('stash');
    put(dir, 'a.txt', '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'uno');
    put(dir, 'a.txt', 'cambiado');
    put(dir, 'nuevo.txt', 'nuevo');

    await git.stashSave(dir, { message: 'sin opcion' });
    assert.ok(existsSync(path.join(dir, 'nuevo.txt')), 'por defecto el archivo nuevo se queda');
    await git.stashPop(dir, 0);

    await git.stashSave(dir, { message: 'con opcion', stageNew: true });
    assert.ok(!existsSync(path.join(dir, 'nuevo.txt')), 'el archivo nuevo entró al stash');
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), '1');
    await git.stashPop(dir, 0);
    assert.equal(readFileSync(path.join(dir, 'nuevo.txt'), 'utf8'), 'nuevo');
  });

  it('worktree: crea la rama nueva desde "Start from"', async () => {
    const dir = fresh('wt');
    put(dir, 'a.txt', '1');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', 'uno');
    sh(dir, 'branch', 'base');
    put(dir, 'a.txt', '2');
    sh(dir, 'commit', '-qam', 'dos');
    const wt = path.join(tmp, 'wt-extra');
    await git.worktreeAdd(dir, wt, 'desde-base', true, 'base');
    assert.equal(sh(dir, 'rev-parse', 'desde-base'), sh(dir, 'rev-parse', 'base'));
    assert.notEqual(sh(dir, 'rev-parse', 'desde-base'), sh(dir, 'rev-parse', 'main'));
    assert.ok(existsSync(path.join(wt, 'a.txt')));
  });

  it('fetch: con rama trae solo esa rama', async () => {
    const bare = path.join(tmp, 'fetch-bare.git');
    sh(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    const a = fresh('fetch-a');
    put(a, 'f.txt', '1');
    sh(a, 'add', '.');
    sh(a, 'commit', '-qm', 'uno');
    sh(a, 'remote', 'add', 'origin', bare);
    sh(a, 'push', '-q', 'origin', 'main');
    const b = path.join(tmp, 'fetch-b');
    sh(tmp, 'clone', '-q', bare, b);
    sh(a, 'branch', 'uno');
    sh(a, 'branch', 'dos');
    sh(a, 'push', '-q', 'origin', 'uno', 'dos');
    await git.fetch(b, { remote: 'origin', branch: 'uno' });
    const refs = sh(b, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin');
    assert.ok(refs.split('\n').includes('origin/uno'));
    assert.ok(!refs.split('\n').includes('origin/dos'));
  });
});

describe('normalizeApi', () => {
  it('usa siempre la API fija de los servicios en la nube', () => {
    assert.equal(normalizeApi('github', 'https://github.com/usuario'), 'https://api.github.com');
    assert.equal(normalizeApi('github', 'github.com'), 'https://api.github.com');
    assert.equal(normalizeApi('gitlab', 'https://gitlab.com/grupo/repo'), 'https://gitlab.com/api/v4');
  });
  it('la API por defecto de cada proveedor queda igual (es lo que se usa con el campo Servidor vacío)', () => {
    // Regresión: https://api.github.com se trataba como GitHub Enterprise y pedía /api/v3/user (404)
    for (const p of [new GitHubProvider(), new GitLabProvider(), new BitbucketProvider(), new GiteaProvider()]) {
      assert.equal(normalizeApi(p.kind, p.defaultApi), p.defaultApi, p.kind);
    }
  });
  it('completa la ruta de la API en servidores propios y respeta la que ya viene', () => {
    assert.equal(normalizeApi('github', 'https://ghe.acme.io'), 'https://ghe.acme.io/api/v3');
    assert.equal(normalizeApi('gitea', 'https://git.acme.io/'), 'https://git.acme.io/api/v1');
    assert.equal(normalizeApi('gitlab', 'https://git.acme.io/gl/api/v4'), 'https://git.acme.io/gl/api/v4');
  });
});

describe('imágenes en el diff (git real)', () => {
  const imgRepo = path.join(tmp, 'img-repo');
  // Bytes que no son UTF-8 válido: si pasaran por una cadena de texto se corromperían.
  const v1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0x01]);
  const v2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc3, 0x28, 0x00, 0x80, 0x02]);
  const v3 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xa0, 0xa1, 0x00, 0x80, 0x03]);
  let first = '';

  before(async () => {
    await git.init(imgRepo, false, 'main');
    await git.setIdentity(imgRepo, { name: 'Prueba', email: 'prueba@example.com' }, false);
    await git.configSet(imgRepo, 'commit.gpgsign', 'false', 'local');
    writeFileSync(path.join(imgRepo, 'logo.png'), v1);
    writeFileSync(path.join(imgRepo, 'nota.txt'), 'texto\n');
    await git.stageAll(imgRepo);
    first = await git.commit(imgRepo, { message: 'Imagen inicial' });
    writeFileSync(path.join(imgRepo, 'logo.png'), v2);
    await git.stage(imgRepo, ['logo.png']);
    writeFileSync(path.join(imgRepo, 'logo.png'), v3);
  });

  it('lee la imagen binaria intacta en un commit, el índice y el árbol de trabajo', async () => {
    const atCommit = await git.imageBlob(imgRepo, first, 'logo.png');
    assert.equal(atCommit?.mime, 'image/png');
    assert.equal(atCommit?.size, v1.length);
    assert.ok(Buffer.from(atCommit!.base64, 'base64').equals(v1));

    const atIndex = await git.imageBlob(imgRepo, '', 'logo.png');
    assert.ok(Buffer.from(atIndex!.base64, 'base64').equals(v2));

    const atWorktree = await git.imageBlob(imgRepo, null, 'logo.png');
    assert.ok(Buffer.from(atWorktree!.base64, 'base64').equals(v3));
  });

  it('devuelve null si no es imagen, no existe en esa revisión o excede el límite', async () => {
    assert.equal(await git.imageBlob(imgRepo, first, 'nota.txt'), null);
    assert.equal(await git.imageBlob(imgRepo, first, 'no-existe.png'), null);
    writeFileSync(path.join(imgRepo, 'grande.png'), Buffer.alloc(11 * 1024 * 1024, 1));
    assert.equal(await git.imageBlob(imgRepo, null, 'grande.png'), null);
  });

  it('rechaza revisiones que parecen opciones y rutas fuera del repositorio', async () => {
    assert.equal(await git.imageBlob(imgRepo, '--help', 'logo.png'), null);
    assert.equal(await git.imageBlob(imgRepo, null, '../repo/a.png'), null);
    assert.equal(await git.imageBlob(imgRepo, null, path.join(tmp, 'repo', 'a.png')), null);
  });

  it('fileAt sigue devolviendo texto como antes', async () => {
    assert.equal(await git.fileAt(imgRepo, first, 'nota.txt'), 'texto\n');
  });
});
