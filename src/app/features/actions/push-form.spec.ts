import {
  defaultPushRemote,
  defaultPushTarget,
  forcePushConfirmKey,
  shouldSetUpstream,
  upstreamOf,
} from './push-form';

describe('push-form', () => {
  const remotes = [{ name: 'origin' }, { name: 'fork' }];

  it('el remoto por defecto es el del upstream de la rama', () => {
    expect(defaultPushRemote(remotes, 'fork/feature/x')).toBe('fork');
  });

  it('sin upstream usa origin y luego el primer remoto', () => {
    expect(defaultPushRemote(remotes, null)).toBe('origin');
    expect(defaultPushRemote([{ name: 'a' }, { name: 'b' }], null)).toBe('a');
    expect(defaultPushRemote([], null)).toBe('');
  });

  it('ignora un upstream cuyo remoto ya no existe', () => {
    expect(defaultPushRemote(remotes, 'gone/main')).toBe('origin');
  });

  it('el destino reutiliza el nombre del upstream solo si es del mismo remoto', () => {
    expect(defaultPushTarget('local-x', 'origin/feature/x', 'origin')).toBe('feature/x');
    expect(defaultPushTarget('local-x', 'origin/feature/x', 'fork')).toBe('local-x');
    expect(defaultPushTarget('main', null, 'origin')).toBe('main');
  });

  it('fija el upstream solo si la rama no tiene', () => {
    expect(shouldSetUpstream(null)).toBe(true);
    expect(shouldSetUpstream('origin/main')).toBe(false);
  });

  it('encuentra el upstream por nombre de rama local', () => {
    const list = [
      { name: 'main', upstream: 'origin/main' },
      { name: 'wip', upstream: null },
    ];
    expect(upstreamOf(list, 'main')).toBe('origin/main');
    expect(upstreamOf(list, 'wip')).toBeNull();
    expect(upstreamOf(list, 'nope')).toBeNull();
  });

  it('pide confirmación solo cuando el push es forzado', () => {
    expect(forcePushConfirmKey('none')).toBeNull();
    expect(forcePushConfirmKey(undefined)).toBeNull();
    expect(forcePushConfirmKey('with-lease')).toBe('dialogs.push.confirmForceLease');
    expect(forcePushConfirmKey('force')).toBe('dialogs.push.confirmForce');
  });
});
