import { Account } from './repository';

export type Language = 'es' | 'en';
export type Theme = 'dark' | 'light' | 'system';
export type ProviderKind = 'github' | 'gitlab' | 'bitbucket' | 'gitea';

export interface Settings {
  language: Language;
  theme: Theme;
  gitPath: string; // vacío = "git" del PATH
  defaultCloneDir: string;
  recentRepos: string[];
  openRepos: string[];
  activeRepo: string | null;
  diffContext: number;
  diffViewMode: 'unified' | 'split';
  ignoreWhitespace: boolean;
  fontSize: number;
  pullMode: 'merge' | 'rebase' | 'ff-only';
  /** Client ID de OAuth recordado por servidor (host), para no pedirlo en cada inicio de sesión. */
  oauthClientIds: Record<string, string>;
  fetchInterval: number; // minutos, 0 = desactivado
  confirmDangerous: boolean;
  showConsole: boolean;
  /** Ancho del panel lateral y alto de la consola en píxeles (se recuerdan entre sesiones). */
  sidebarWidth: number;
  consoleHeight: number;
  watchWorkingTree: boolean;
  externalDiffTool: string;
  externalMergeTool: string;
  terminal: string; // comando para abrir terminal
  accounts: Account[];
}
