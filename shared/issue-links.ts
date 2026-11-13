/**
 * Enlaces a issues en los mensajes de commit.
 *
 * Solo hay dos formas de referencia, fijas a propósito (sin expresiones regulares configurables, que
 * podrían bloquear la interfaz con un patrón malicioso en la configuración de un repositorio):
 *  - `number`: `#123`
 *  - `key`: `ABC-123` (estilo Jira)
 */
export type IssuePattern = 'number' | 'key';

export interface IssueRule {
  pattern: IssuePattern;
  /** Plantilla de la dirección; `{id}` se sustituye por la referencia sin el `#`. */
  url: string;
}

export interface IssueSegment {
  text: string;
  /** Dirección a abrir; ausente en el texto normal. */
  url?: string;
}

/** Claves de la configuración local de git donde cada repositorio define su regla. */
export const ISSUE_PATTERN_CONFIG_KEY = 'gitora.issuePattern';
export const ISSUE_URL_CONFIG_KEY = 'gitora.issueUrl';

const REGEX: Record<IssuePattern, RegExp> = {
  number: /(?<![\w/&#])#(\d{1,9})\b/g,
  key: /(?<![\w/-])([A-Z][A-Z0-9]{1,9}-\d{1,9})\b/g,
};
const MAX_TEXT = 20_000;
const MAX_URL = 300;

/** Valida la regla guardada en la configuración del repositorio; null si no es utilizable. */
export function parseIssueRule(
  pattern: string | undefined,
  url: string | undefined,
): IssueRule | null {
  const u = (url ?? '').trim();
  if (!u || u.length > MAX_URL || !u.includes('{id}') || !/^https?:\/\//i.test(u)) return null;
  const p = (pattern ?? 'number').trim().toLowerCase();
  if (p !== 'number' && p !== 'key') return null;
  return { pattern: p, url: u };
}

/** Regla por omisión según el servidor del remoto (GitHub, GitLab, Codeberg/Gitea o Bitbucket). */
export function issueRuleFromRemote(remoteUrl: string): IssueRule | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)([^/:\s]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/i.exec(
      remoteUrl.trim(),
    );
  if (!m) return null;
  const host = m[1].toLowerCase();
  const repo = m[2].replace(/^\/+/, '');
  if (!/^[^/\s]+\/[^\s]+$/.test(repo)) return null;
  const base = `https://${host}/${repo}`;
  switch (host) {
    case 'github.com':
    case 'codeberg.org':
    case 'bitbucket.org':
      return { pattern: 'number', url: `${base}/issues/{id}` };
    case 'gitlab.com':
      return { pattern: 'number', url: `${base}/-/issues/{id}` };
    default:
      return null;
  }
}

/** Parte el texto en tramos normales y referencias a issues con su dirección. */
export function linkifyIssues(text: string, rule: IssueRule | null): IssueSegment[] {
  if (!rule || !text || text.length > MAX_TEXT) return [{ text }];
  const re = new RegExp(REGEX[rule.pattern].source, 'g');
  const out: IssueSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: m[0], url: rule.url.replace('{id}', encodeURIComponent(m[1])) });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
