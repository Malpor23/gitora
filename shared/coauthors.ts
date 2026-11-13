/** Un co-autor de un commit, tal como aparece en el trailer `Co-authored-by`. */
export interface CoAuthor {
  name: string;
  email: string;
}

const CO_AUTHOR = /^([^<>\r\n]+?)\s*<([^<>\s\r\n@]+@[^<>\s\r\n@]+\.[^<>\s\r\n@]+)>$/;
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s/;
const CO_AUTHORED_LINE = /^Co-authored-by:\s*.*<([^<>\s]+)>\s*$/i;

/**
 * Interpreta `Nombre <correo>`. Devuelve null si el formato no es válido; en particular rechaza
 * saltos de línea, que permitirían inyectar otras líneas (y trailers) en el mensaje del commit.
 */
export function parseCoAuthor(text: string): CoAuthor | null {
  const m = CO_AUTHOR.exec(text.trim());
  return m ? { name: m[1].trim(), email: m[2] } : null;
}

export function formatCoAuthor(c: CoAuthor): string {
  return `${c.name} <${c.email}>`;
}

/**
 * Añade al final del mensaje una línea `Co-authored-by` por cada co-autor, sin repetir los
 * que ya estén en el mensaje (se comparan por correo, sin distinguir mayúsculas). Si el mensaje
 * ya termina en un bloque de trailers se continúa en él; si no, se abre uno tras una línea en blanco.
 * Lanza un error si algún co-autor no tiene el formato `Nombre <correo>`.
 */
export function appendCoAuthors(message: string, coAuthors: readonly string[]): string {
  if (!coAuthors.length) return message;
  const known = new Set<string>();
  for (const line of message.split(/\r?\n/)) {
    const m = CO_AUTHORED_LINE.exec(line.trim());
    if (m) known.add(m[1].toLowerCase());
  }
  const lines: string[] = [];
  for (const raw of coAuthors) {
    const parsed = parseCoAuthor(raw);
    if (!parsed) throw new Error(`Co-autor no válido: "${raw}". Usa el formato Nombre <correo>.`);
    const key = parsed.email.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    lines.push(`Co-authored-by: ${formatCoAuthor(parsed)}`);
  }
  if (!lines.length) return message;

  const base = message.replace(/\s+$/, '');
  const paragraphs = base.split(/\r?\n\r?\n/);
  const last = paragraphs[paragraphs.length - 1].split(/\r?\n/);
  // Con una sola línea de párrafo (el asunto) no hay bloque de trailers que continuar.
  const inTrailerBlock = paragraphs.length > 1 && last.every((l) => TRAILER_LINE.test(l));
  return `${base}${inTrailerBlock ? '\n' : '\n\n'}${lines.join('\n')}`;
}
