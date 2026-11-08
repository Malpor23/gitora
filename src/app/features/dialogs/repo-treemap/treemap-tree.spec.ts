import { buildTree, childrenAt, formatBytes } from './treemap-tree';

const files = [
  { path: 'README.md', size: 100 },
  { path: 'src/a.ts', size: 300 },
  { path: 'src/b.ts', size: 200 },
  { path: 'src/ui/c.ts', size: 50 },
  { path: 'docs/x.md', size: 1000 },
];

describe('buildTree / childrenAt', () => {
  const root = buildTree(files);

  it('suma tamanos y conteos en la raiz', () => {
    expect(root.size).toBe(1650);
    expect(root.fileCount).toBe(5);
  });

  it('lista la raiz ordenada por tamano', () => {
    expect(childrenAt(root, [])).toEqual([
      { name: 'docs', size: 1000, fileCount: 1, isDir: true },
      { name: 'src', size: 550, fileCount: 3, isDir: true },
      { name: 'README.md', size: 100, fileCount: 1, isDir: false },
    ]);
  });

  it('navega a subcarpetas', () => {
    const src = childrenAt(root, ['src']);
    expect(src.map((e) => e.name)).toEqual(['a.ts', 'b.ts', 'ui']);
    expect(childrenAt(root, ['src', 'ui'])).toEqual([
      { name: 'c.ts', size: 50, fileCount: 1, isDir: false },
    ]);
  });

  it('ruta inexistente o archivo devuelve vacio', () => {
    expect(childrenAt(root, ['nope'])).toEqual([]);
    expect(childrenAt(root, ['README.md'])).toEqual([]);
  });

  it('arbol vacio', () => {
    expect(childrenAt(buildTree([]), [])).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('formatea unidades', () => {
    expect(formatBytes(0, 'en-US')).toBe('0 B');
    expect(formatBytes(512, 'en-US')).toBe('512 B');
    expect(formatBytes(1024, 'en-US')).toBe('1 KiB');
    expect(formatBytes(1536, 'en-US')).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 * 1024, 'en-US')).toBe('5 MiB');
    expect(formatBytes(3 * 1024 ** 3, 'en-US')).toBe('3 GiB');
  });

  it('no pasa de GiB', () => {
    expect(formatBytes(2048 * 1024 ** 3, 'en-US')).toBe('2,048 GiB');
  });
});
