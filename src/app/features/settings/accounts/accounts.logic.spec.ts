import {
  AccountFormState,
  canSubmit,
  defaultMethod,
  fieldsFor,
  formatCountdown,
  hostKey,
  toNewAccountInput,
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
