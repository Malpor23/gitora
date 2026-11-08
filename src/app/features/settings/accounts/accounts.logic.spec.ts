import {
  AccountFormState,
  canSubmit,
  defaultMethod,
  fieldsFor,
  formatCountdown,
  formFromAccount,
  hostKey,
  navigateIndex,
  PROVIDER_TILES,
  selectionAfterRemoval,
  serverUrl,
  statusView,
  toNewAccountInput,
  updateLabelKey,
} from './accounts.logic';

const base: AccountFormState = {
  provider: 'github',
  method: 'token',
  server: '',
  username: '',
  secret: '',
  keyPath: '',
  clientId: '',
};

describe('accounts.logic', () => {
  it('uses the first offered method as default', () => {
    expect(defaultMethod('github')).toBe('token');
    expect(defaultMethod('gitea')).toBe('token');
  });

  it('declares required fields per method', () => {
    expect(fieldsFor('github', 'token').username).toBe(false);
    expect(fieldsFor('bitbucket', 'token').usernameRequired).toBe(true);
    expect(fieldsFor('bitbucket', 'token').server).toBe(false);
    expect(fieldsFor('gitlab', 'password')).toMatchObject({ usernameRequired: true, secret: true });
    expect(fieldsFor('github', 'ssh')).toMatchObject({ keyPath: true, secret: false });
    expect(fieldsFor('gitlab', 'oauth')).toMatchObject({ clientId: true, secret: false });
  });

  it('validates canSubmit per method', () => {
    expect(canSubmit(base)).toBe(false);
    expect(canSubmit({ ...base, secret: ' t ' })).toBe(true);
    expect(canSubmit({ ...base, provider: 'bitbucket', secret: 't' })).toBe(false);
    expect(canSubmit({ ...base, provider: 'bitbucket', secret: 't', username: 'u' })).toBe(true);
    expect(canSubmit({ ...base, method: 'password', username: 'u', secret: ' ' })).toBe(false);
    expect(canSubmit({ ...base, method: 'ssh', username: 'u' })).toBe(false);
    expect(canSubmit({ ...base, method: 'ssh', username: 'u', keyPath: '/k' })).toBe(true);
    expect(canSubmit({ ...base, method: 'oauth' })).toBe(false);
    expect(canSubmit({ ...base, method: 'oauth', clientId: 'abc' })).toBe(true);
  });

  it('maps the form to NewAccountInput trimming and omitting empties', () => {
    expect(toNewAccountInput({ ...base, secret: ' tok ', server: ' ' })).toEqual({
      provider: 'github',
      authMethod: 'token',
      token: 'tok',
    });
    expect(
      toNewAccountInput({
        ...base,
        provider: 'gitlab',
        method: 'password',
        server: ' gitlab.acme.io ',
        username: ' me ',
        secret: 'pw',
        keyPath: '/ignored',
      }),
    ).toEqual({
      provider: 'gitlab',
      authMethod: 'password',
      baseUrl: 'gitlab.acme.io',
      username: 'me',
      token: 'pw',
    });
    expect(
      toNewAccountInput({
        ...base,
        method: 'ssh',
        username: 'me',
        keyPath: ' /k/id ',
        secret: 'x',
      }),
    ).toEqual({ provider: 'github', authMethod: 'ssh', username: 'me', sshKeyPath: '/k/id' });
  });

  it('computes the host key', () => {
    expect(hostKey('github', '')).toBe('github.com');
    expect(hostKey('gitlab', '  ')).toBe('gitlab.com');
    expect(hostKey('gitlab', 'https://GitLab.Acme.io/sub')).toBe('gitlab.acme.io');
    expect(hostKey('github', 'ghe.acme.io')).toBe('ghe.acme.io');
    expect(hostKey('gitea', 'http://git.acme.io:3000')).toBe('git.acme.io');
  });

  it('formats the countdown as mm:ss', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(65)).toBe('01:05');
    expect(formatCountdown(899)).toBe('14:59');
    expect(formatCountdown(-3)).toBe('00:00');
  });
});

describe('formFromAccount', () => {
  const base = {
    id: 'a1',
    provider: 'gitlab' as const,
    baseUrl: 'https://gitlab.com/api/v4',
    host: 'gitlab.com',
    username: 'ana',
    hasToken: true,
    authMethod: 'token' as const,
    apiAccess: true,
  };

  it('deja el secreto vacío y el servidor vacío cuando es el de por defecto', () => {
    expect(formFromAccount(base)).toEqual({
      provider: 'gitlab',
      method: 'token',
      server: '',
      username: 'ana',
      secret: '',
      keyPath: '',
      clientId: '',
    });
  });

  it('conserva el servidor propio y la ruta de la clave SSH', () => {
    const f = formFromAccount({ ...base, host: 'git.acme.com', authMethod: 'ssh', sshKeyPath: '/home/ana/.ssh/id_ed25519', hasToken: false, apiAccess: false });
    expect(f.server).toBe('git.acme.com');
    expect(f.method).toBe('ssh');
    expect(f.keyPath).toBe('/home/ana/.ssh/id_ed25519');
  });

  it('offers the six platform tiles, enterprise and self-hosted requiring a server', () => {
    expect(PROVIDER_TILES.map((t) => t.id)).toEqual([
      'bitbucket',
      'gitea',
      'github',
      'github-enterprise',
      'gitlab',
      'gitlab-self',
    ]);
    const required = PROVIDER_TILES.filter((t) => t.serverRequired).map((t) => [t.id, t.provider]);
    expect(required).toEqual([
      ['github-enterprise', 'github'],
      ['gitlab-self', 'gitlab'],
    ]);
  });

  it('blocks submit without server only when the server is required and shown', () => {
    const ok: AccountFormState = {
      provider: 'github',
      method: 'token',
      server: '',
      username: '',
      secret: 'tok',
      keyPath: '',
      clientId: '',
    };
    expect(canSubmit({ ...ok, serverRequired: true })).toBe(false);
    expect(canSubmit({ ...ok, serverRequired: true, server: ' ghe.acme.com ' })).toBe(true);
    expect(canSubmit({ ...ok, serverRequired: false })).toBe(true);
    expect(
      canSubmit({ ...ok, provider: 'bitbucket', username: 'ana', serverRequired: true }),
    ).toBe(true);
  });

  it('maps each status to a tone and a text key', () => {
    expect(statusView('online')).toEqual({ tone: 'success', key: 'accounts.status.online' });
    expect(statusView('offline').tone).toBe('danger');
    expect(statusView('invalid').tone).toBe('warning');
    expect(statusView('unverifiable').tone).toBe('muted');
    expect(statusView('checking').tone).toBe('busy');
  });

  it('picks the update label by method and builds the server link', () => {
    expect(updateLabelKey('ssh')).toBe('accounts.update.ssh');
    expect(updateLabelKey('oauth')).toBe('accounts.update.oauth');
    expect(serverUrl({ host: 'git.acme.com' })).toBe('https://git.acme.com');
  });

  it('selects a neighbour after removing an account', () => {
    expect(selectionAfterRemoval(['a', 'b', 'c'], 1)).toBe('c');
    expect(selectionAfterRemoval(['a', 'b', 'c'], 2)).toBe('b');
    expect(selectionAfterRemoval(['a', 'b'], 0)).toBe('b');
    expect(selectionAfterRemoval(['a'], 0)).toBeNull();
  });

  it('navigates a list with arrows, Home and End within bounds', () => {
    expect(navigateIndex('ArrowDown', 0, 3)).toBe(1);
    expect(navigateIndex('ArrowDown', 2, 3)).toBe(2);
    expect(navigateIndex('ArrowUp', 0, 3)).toBe(0);
    expect(navigateIndex('ArrowUp', 2, 3)).toBe(1);
    expect(navigateIndex('Home', 2, 3)).toBe(0);
    expect(navigateIndex('End', 0, 3)).toBe(2);
    expect(navigateIndex('a', 0, 3)).toBeNull();
    expect(navigateIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
