import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Valida la ruta de una clave SSH privada y devuelve la ruta absoluta normalizada.
 * Solo se comprueba que exista y que su encabezado sea de una clave privada (para detectar que se
 * eligió la `.pub` por error): el contenido no se guarda ni se copia.
 */
export async function validateSshKeyPath(raw: string, home = os.homedir()): Promise<string> {
  let p = raw.trim();
  if (!p) throw new Error('Indica la ruta de la clave privada');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
  if (!path.isAbsolute(p)) throw new Error('La ruta de la clave debe ser absoluta');
  if (/["\r\n\0]/.test(p)) throw new Error('La ruta de la clave tiene caracteres no permitidos');
  p = path.normalize(p);

  const stat = await fs.stat(p).catch(() => null);
  if (!stat?.isFile()) throw new Error(`No existe el archivo de clave: ${p}`);
  if (p.toLowerCase().endsWith('.pub')) {
    throw new Error('Esa es la clave pública (.pub): elige la clave privada, sin la extensión .pub');
  }
  const handle = await fs.open(p, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    if (head.startsWith('ssh-') || head.startsWith('ecdsa-') || head.startsWith('sk-')) {
      throw new Error('Ese archivo es una clave pública: elige la clave privada');
    }
    if (!head.startsWith('-----BEGIN')) throw new Error('El archivo no parece una clave privada SSH');
  } finally {
    await handle.close();
  }
  return p;
}

/**
 * Valor de `core.sshCommand` que fuerza una clave concreta. `IdentitiesOnly` evita que ssh pruebe
 * otras claves del agente, y `BatchMode` impide que se quede esperando una contraseña sin terminal
 * (una clave con frase de paso debe estar cargada en ssh-agent).
 */
export function sshCommandFor(keyPath: string): string {
  return `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o BatchMode=yes`;
}

/** ¿Es un remoto SSH? (`git@host:ruta` o `ssh://...`). Los HTTPS usan cabeceras, no claves. */
export function isSshUrl(url: string): boolean {
  const u = url.trim();
  return /^ssh:\/\//i.test(u) || /^[\w.-]+@[\w.-]+:/.test(u);
}
