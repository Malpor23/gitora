/** Tipos de Conventional Commits que se ofrecen por omisión. */
export const DEFAULT_COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

/** Clave de la configuración local de git donde cada repositorio guarda sus propios tipos. */
export const COMMIT_TYPES_CONFIG_KEY = 'gitora.commitTypes';

const MAX_TYPES = 30;
const TYPE_NAME = /^[a-z][a-z0-9-]*$/;
const PREFIX = /^([A-Za-z][\w-]*)(\([^()\r\n]*\))?(!)?:[ \t]?/;

/** Lee una lista de tipos separados por comas o espacios; descarta los inválidos y los repetidos. */
export function parseCommitTypes(text: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (text ?? '').split(/[\s,]+/)) {
    const t = raw.toLowerCase();
    if (TYPE_NAME.test(t) && !out.includes(t)) out.push(t);
    if (out.length === MAX_TYPES) break;
  }
  return out;
}

interface Prefix {
  type: string;
  scope: string;
  breaking: boolean;
  rest: string;
}

/** Separa el prefijo `tipo(alcance)!: ` del resumen, solo si el tipo es uno de los conocidos. */
function splitPrefix(subject: string, known: readonly string[]): Prefix | null {
  const m = PREFIX.exec(subject);
  if (!m || !known.includes(m[1].toLowerCase())) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] ?? '',
    breaking: !!m[3],
    rest: subject.slice(m[0].length),
  };
}

/** Tipo convencional con el que empieza el resumen, o null si no empieza con uno conocido. */
export function currentCommitType(subject: string, known: readonly string[]): string | null {
  return splitPrefix(subject, known)?.type ?? null;
}

/** Pone `type` al inicio del resumen; si ya tenía un tipo conocido lo reemplaza y conserva alcance y "!". */
export function applyCommitType(subject: string, type: string, known: readonly string[]): string {
  const p = splitPrefix(subject, known);
  if (!p) return `${type}: ${subject}`;
  return `${type}${p.scope}${p.breaking ? '!' : ''}: ${p.rest}`;
}

/** Marca o desmarca el cambio incompatible (`!`); sin un tipo conocido no hace nada. */
export function toggleBreaking(subject: string, known: readonly string[]): string {
  const p = splitPrefix(subject, known);
  if (!p) return subject;
  return `${p.type}${p.scope}${p.breaking ? '' : '!'}: ${p.rest}`;
}

/** Indica si el resumen ya lleva la marca de cambio incompatible (`!`) tras un tipo conocido. */
export function hasBreakingMark(subject: string, known: readonly string[]): boolean {
  return splitPrefix(subject, known)?.breaking ?? false;
}
