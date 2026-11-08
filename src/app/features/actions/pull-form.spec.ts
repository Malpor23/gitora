import {
  defaultPullBranch,
  defaultPullRemote,
  pullBranchOptions,
  pullModeFromForm,
  remoteBranchNames,
} from './pull-form';

const branches = [
  { name: 'main', remote: null },
  { name: 'origin/main', remote: 'origin' },
  { name: 'origin/HEAD', remote: 'origin' },
  { name: 'origin/feature/login', remote: 'origin' },
  { name: 'origin/bugfix/x', remote: 'origin' },
  { name: 'upstream/main', remote: 'upstream' },
];

describe('pull-form', () => {
  it('usa origin como remoto por defecto aunque el upstream sea otro', () => {
    const remotes = [{ name: 'upstream' }, { name: 'origin' }];
    expect(defaultPullRemote(remotes, 'upstream/main')).toBe('origin');
  });

  it('sin origin cae al remoto del upstream y luego al primero', () => {
    const remotes = [{ name: 'a' }, { name: 'b' }];
    expect(defaultPullRemote(remotes, 'b/main')).toBe('b');
    expect(defaultPullRemote(remotes, null)).toBe('a');
    expect(defaultPullRemote([], null)).toBe('');
  });

  it('lista las ramas del remoto elegido, features incluidas, sin HEAD y ordenadas', () => {
    expect(remoteBranchNames(branches, 'origin')).toEqual(['bugfix/x', 'feature/login', 'main']);
    expect(remoteBranchNames(branches, 'upstream')).toEqual(['main']);
  });

  it('las opciones empiezan por la rama de seguimiento', () => {
    const opts = pullBranchOptions(branches, 'origin', 'Seguimiento');
    expect(opts[0]).toEqual({ value: '', label: 'Seguimiento' });
    expect(opts.map((o) => o.value)).toEqual(['', 'bugfix/x', 'feature/login', 'main']);
  });

  it('preselecciona el upstream, luego la rama actual y si no, vacío', () => {
    expect(defaultPullBranch(branches, 'origin', 'origin/feature/login', 'main')).toBe(
      'feature/login',
    );
    expect(defaultPullBranch(branches, 'origin', 'upstream/main', 'main')).toBe('main');
    expect(defaultPullBranch(branches, 'origin', null, 'otra')).toBe('');
  });

  it('rebase gana sobre ff-only y por defecto es merge', () => {
    expect(pullModeFromForm({ rebase: true, ffOnly: true })).toBe('rebase');
    expect(pullModeFromForm({ rebase: false, ffOnly: true })).toBe('ff-only');
    expect(pullModeFromForm({ rebase: false, ffOnly: false })).toBe('merge');
  });
});
