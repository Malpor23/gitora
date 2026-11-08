import { defaultStartBranch, flowBaseBranch, flowBranchName } from './repo-forms';

describe('repo-forms', () => {
  it('"Comenzar desde" prefiere main, luego master, luego la rama actual', () => {
    expect(defaultStartBranch(['dev', 'main', 'master'], 'dev')).toBe('main');
    expect(defaultStartBranch(['dev', 'master'], 'dev')).toBe('master');
    expect(defaultStartBranch(['dev', 'x'], 'x')).toBe('x');
    expect(defaultStartBranch(['a', 'b'], 'zzz')).toBe('a');
    expect(defaultStartBranch([], 'HEAD')).toBe('HEAD');
  });

  it('los hotfix salen de producción y el resto de develop', () => {
    const cfg = { master: 'main', develop: 'develop' };
    expect(flowBaseBranch(cfg, 'hotfix')).toBe('main');
    expect(flowBaseBranch(cfg, 'feature')).toBe('develop');
    expect(flowBaseBranch(cfg, 'release')).toBe('develop');
  });

  it('arma el nombre con el prefijo y recorta espacios', () => {
    const cfg = { feature: 'feature/', release: 'rel-', hotfix: 'hotfix/' };
    expect(flowBranchName(cfg, 'feature', ' login ')).toBe('feature/login');
    expect(flowBranchName(cfg, 'release', '1.0')).toBe('rel-1.0');
  });
});
