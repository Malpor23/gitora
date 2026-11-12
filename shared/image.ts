/** Tipos de imagen que el visor del diff sabe mostrar (SVG queda fuera: es texto y ya sale en el diff). */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Tamaño máximo de una imagen que se envía al visor (en bytes). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Tipo MIME de una imagen según su extensión, o null si no es una imagen soportada. */
export function imageMime(file: string): string | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  return IMAGE_MIME[file.slice(dot + 1).toLowerCase()] ?? null;
}
