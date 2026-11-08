import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Account, Settings } from '../src/app/core/models';

export const DEFAULT_SETTINGS: Settings = {
  language: 'es',            // español por defecto
  theme: 'dark',
  gitPath: '',
  defaultCloneDir: path.join(os.homedir(), 'Proyectos'),
  recentRepos: [],
  openRepos: [],
  activeRepo: null,
  diffContext: 3,
  diffViewMode: 'unified',
  ignoreWhitespace: false,
  fontSize: 13,
  pullMode: 'merge',
  fetchInterval: 10,
  confirmDangerous: true,
  showConsole: false,
  sidebarWidth: 260,
  consoleHeight: 220,
  watchWorkingTree: process.platform === 'win32' || process.platform === 'darwin',
  externalDiffTool: '',
  externalMergeTool: '',
  terminal: '',
  accounts: [],
  oauthClientIds: {},
};

/** Tokens cifrados con el llavero del sistema (DPAPI en Windows, libsecret/kwallet en Linux). */
export interface TokenCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

interface StoredFile {
  settings: Settings;
  tokens: Record<string, { value: string; encrypted: boolean }>;
}

export class SettingsStore {
  private data: StoredFile;
  private readonly file: string;

  constructor(dir: string, private readonly cipher: TokenCipher) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'settings.json');
    this.data = this.load();
  }

  private load(): StoredFile {
    if (!existsSync(this.file)) return { settings: { ...DEFAULT_SETTINGS }, tokens: {} };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredFile>;
      const settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
      // Cuentas guardadas antes de existir los métodos de autenticación: eran todas de token.
      settings.accounts = settings.accounts.map((a) => ({
        ...a,
        authMethod: a.authMethod ?? 'token',
        apiAccess: a.apiAccess ?? true,
      }));
      return { settings, tokens: raw.tokens ?? {} };
    } catch {
      return { settings: { ...DEFAULT_SETTINGS }, tokens: {} };
    }
  }

  private save() {
    // Escritura atómica: evita corromper el archivo si la app se cierra a mitad.
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  get(): Settings {
    return structuredClone(this.data.settings);
  }

  update(patch: Partial<Settings>): Settings {
    const { accounts: _ignored, ...rest } = patch; // las cuentas se gestionan aparte
    // Valores numéricos acotados: un intervalo negativo haría que el auto-fetch disparase sin pausa
    const clamp = (v: unknown, min: number, max: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
    const bounds = { fetchInterval: [0, 240], diffContext: [0, 50], sidebarWidth: [190, 480], consoleHeight: [100, 2000], fontSize: [11, 17] } as const;
    for (const [key, [min, max]] of Object.entries(bounds)) {
      if (key in rest) {
        const v = clamp((rest as Record<string, unknown>)[key], min, max);
        if (v === undefined) delete (rest as Record<string, unknown>)[key];
        else (rest as Record<string, unknown>)[key] = v;
      }
    }
    this.data.settings = { ...this.data.settings, ...rest };
    this.save();
    return this.get();
  }

  addRecent(repo: string) {
    const list = [repo, ...this.data.settings.recentRepos.filter((r) => r !== repo)].slice(0, 30);
    this.data.settings.recentRepos = list;
    this.save();
  }

  /** `secret` es el token, la contraseña o el JSON de OAuth; null para las claves SSH (no tienen). */
  upsertAccount(account: Account, secret: string | null) {
    const others = this.data.settings.accounts.filter((a) => a.id !== account.id);
    this.data.settings.accounts = [...others, { ...account, hasToken: secret !== null }];
    if (secret === null) delete this.data.tokens[account.id];
    else this.setSecret(account.id, secret);
    this.save();
  }

  /** Reemplaza el secreto de una cuenta (p. ej. tras renovar un token OAuth). */
  setSecret(id: string, secret: string) {
    const encrypted = this.cipher.available();
    this.data.tokens[id] = { value: encrypted ? this.cipher.encrypt(secret) : secret, encrypted };
    this.save();
  }

  removeAccount(id: string) {
    this.data.settings.accounts = this.data.settings.accounts.filter((a) => a.id !== id);
    delete this.data.tokens[id];
    this.save();
  }

  account(id: string): Account | undefined {
    return this.data.settings.accounts.find((a) => a.id === id);
  }

  token(id: string): string | null {
    const t = this.data.tokens[id];
    if (!t) return null;
    try {
      return t.encrypted ? this.cipher.decrypt(t.value) : t.value;
    } catch {
      return null;
    }
  }
}
