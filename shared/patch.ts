import type { DiffFile, DiffHunk } from '@core/models';

/**
 * Construye un parche aplicable con `git apply` a partir de un hunk (o de algunas
 * de sus líneas). Es lo que permite hacer stage/unstage/descartar por hunk o por
 * línea, como en Fork.
 *
 * - direction 'forward': el parche se aplica tal cual (stage desde el working tree,
 *   o descartar con `apply -R` sobre el working tree).
 * - direction 'reverse': el parche se aplicará con `-R` sobre el índice (unstage).
 *
 * Las líneas no seleccionadas se transforman para que el resto del archivo quede
 * intacto:
 *   forward → '+' no seleccionado se elimina; '-' no seleccionado pasa a contexto.
 *   reverse → '+' no seleccionado pasa a contexto; '-' no seleccionado se elimina.
 */
export function buildHunkPatch(
  file: DiffFile,
  hunkIndex: number,
  selectedLines: number[] | null,
  direction: 'forward' | 'reverse',
): string {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) throw new Error(`Hunk ${hunkIndex} no existe`);
  const body = buildHunkBody(hunk, selectedLines, direction);
  if (!body) return '';
  return [...patchHeader(file), body.text].join('\n') + '\n';
}

/** Parche con varios hunks completos (p. ej. "stage de todo el archivo"). */
export function buildFilePatch(file: DiffFile, direction: 'forward' | 'reverse'): string {
  const parts = file.hunks
    .map((h) => buildHunkBody(h, null, direction))
    .filter((b): b is { text: string } => !!b)
    .map((b) => b.text);
  if (!parts.length) return '';
  return [...patchHeader(file), ...parts].join('\n') + '\n';
}

function patchHeader(file: DiffFile): string[] {
  // Conservamos solo las líneas que `git apply` necesita.
  const keep = file.headerLines.filter(
    (l) =>
      l.startsWith('diff --git') ||
      l.startsWith('--- ') ||
      l.startsWith('+++ ') ||
      l.startsWith('new file mode') ||
      l.startsWith('deleted file mode') ||
      l.startsWith('old mode') ||
      l.startsWith('new mode'),
  );
  if (!keep.some((l) => l.startsWith('--- '))) {
    keep.push(`--- ${file.isNew ? '/dev/null' : 'a/' + file.oldPath}`);
    keep.push(`+++ ${file.isDeleted ? '/dev/null' : 'b/' + file.newPath}`);
  }
  return keep;
}

function buildHunkBody(
  hunk: DiffHunk,
  selected: number[] | null,
  direction: 'forward' | 'reverse',
): { text: string } | null {
  const sel = selected ? new Set(selected) : null;
  const out: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let hasChange = false;

  hunk.lines.forEach((line, i) => {
    const isSelected = !sel || sel.has(i);
    switch (line.type) {
      case 'ctx':
        out.push(' ' + line.content);
        oldCount++;
        newCount++;
        break;
      case 'nonewline':
        out.push('\\ No newline at end of file');
        break;
      case 'add':
        if (isSelected) {
          out.push('+' + line.content);
          newCount++;
          hasChange = true;
        } else if (direction === 'reverse') {
          out.push(' ' + line.content);
          oldCount++;
          newCount++;
        }
        break;
      case 'del':
        if (isSelected) {
          out.push('-' + line.content);
          oldCount++;
          hasChange = true;
        } else if (direction === 'forward') {
          out.push(' ' + line.content);
          oldCount++;
          newCount++;
        }
        break;
    }
  });

  if (!hasChange) return null;
  // Si una línea "\ No newline" quedó huérfana tras quitar su línea, la eliminamos.
  const cleaned = out.filter((l, i) => !(l.startsWith('\\') && (i === 0 || out[i - 1].startsWith('\\'))));
  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.section ? ' ' + hunk.section : ''}`;
  return { text: [header, ...cleaned].join('\n') };
}
