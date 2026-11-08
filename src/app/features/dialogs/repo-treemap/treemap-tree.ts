import { FileSize } from '@core/models';

export interface TreeNode {
  name: string;
  size: number;
  fileCount: number;
  isDir: boolean;
  children: Map<string, TreeNode>;
}

export interface TreeEntry {
  name: string;
  size: number;
  fileCount: number;
  isDir: boolean;
}

function dir(name: string): TreeNode {
  return { name, size: 0, fileCount: 0, isDir: true, children: new Map() };
}

/** Construye la jerarquía de carpetas/archivos con tamaños y conteos acumulados. */
export function buildTree(files: FileSize[]): TreeNode {
  const root = dir('');
  for (const f of files) {
    const parts = f.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    const size = Math.max(0, f.size);
    let node = root;
    node.size += size;
    node.fileCount += 1;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = isLeaf
          ? { name: part, size: 0, fileCount: 0, isDir: false, children: new Map() }
          : dir(part);
        node.children.set(part, child);
      }
      child.size += size;
      child.fileCount += 1;
      node = child;
    });
  }
  return root;
}

/** Entradas de la carpeta indicada, ordenadas por tamaño (desc) y luego por nombre. */
export function childrenAt(root: TreeNode, pathSegments: string[]): TreeEntry[] {
  let node: TreeNode | undefined = root;
  for (const seg of pathSegments) {
    node = node.children.get(seg);
    if (!node || !node.isDir) return [];
  }
  return [...node.children.values()]
    .map((c) => ({ name: c.name, size: c.size, fileCount: c.fileCount, isDir: c.isDir }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB'];

/** Formatea bytes con unidades binarias (B, KiB, MiB, GiB). */
export function formatBytes(n: number, locale?: string): string {
  let v = Math.max(0, n);
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const num = new Intl.NumberFormat(locale, {
    maximumFractionDigits: u === 0 ? 0 : v < 10 ? 2 : 1,
  }).format(v);
  return `${num} ${UNITS[u]}`;
}
