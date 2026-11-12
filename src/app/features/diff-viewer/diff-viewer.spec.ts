import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DiffFile } from '@core/models';
import { DiffViewer } from './diff-viewer';

const binary = (over: Partial<DiffFile>): DiffFile => ({
  oldPath: 'img/logo.png',
  newPath: 'img/logo.png',
  headerLines: [],
  isNew: false,
  isDeleted: false,
  isRename: false,
  isBinary: true,
  additions: 0,
  deletions: 0,
  hunks: [],
  ...over,
});

describe('DiffViewer', () => {
  let component: DiffViewer;
  let fixture: ComponentFixture<DiffViewer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DiffViewer],
    }).compileComponents();

    fixture = TestBed.createComponent(DiffViewer);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('imágenes', () => {
    const refs = (file: DiffFile, source: Parameters<typeof fixture.componentRef.setInput>[1]) => {
      fixture.componentRef.setInput('file', file);
      fixture.componentRef.setInput('source', source);
      return component.imageRefs();
    };

    it('en el árbol de trabajo compara índice contra disco, y en staged HEAD contra índice', () => {
      expect(refs(binary({}), { repo: '/r', kind: 'working', staged: false })).toEqual({
        before: { rev: '', path: 'img/logo.png' },
        after: { rev: null, path: 'img/logo.png' },
      });
      expect(refs(binary({}), { repo: '/r', kind: 'working', staged: true })).toEqual({
        before: { rev: 'HEAD', path: 'img/logo.png' },
        after: { rev: '', path: 'img/logo.png' },
      });
    });

    it('en un commit compara el padre contra el commit, con la ruta anterior si hubo renombrado', () => {
      const file = binary({ oldPath: 'a.png', newPath: 'b.png', isRename: true });
      expect(refs(file, { repo: '/r', kind: 'commit', hash: 'abc' })).toEqual({
        before: { rev: 'abc^', path: 'a.png' },
        after: { rev: 'abc', path: 'b.png' },
      });
    });

    it('un archivo nuevo no tiene versión anterior y uno eliminado no tiene la nueva', () => {
      const src = { repo: '/r', kind: 'commit', hash: 'abc' } as const;
      expect(refs(binary({ isNew: true }), src)?.before).toBeNull();
      expect(refs(binary({ isDeleted: true }), src)?.after).toBeNull();
    });

    it('no hay vista previa si el binario no es imagen o falta el origen', () => {
      const src = { repo: '/r', kind: 'commit', hash: 'abc' } as const;
      expect(refs(binary({ oldPath: 'x.zip', newPath: 'x.zip' }), src)).toBeNull();
      expect(refs(binary({}), null)).toBeNull();
    });

    it('sin vista previa sigue mostrando el aviso de archivo binario', async () => {
      fixture.componentRef.setInput('file', binary({ oldPath: 'x.zip', newPath: 'x.zip' }));
      await fixture.whenStable();
      fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Archivo binario');
    });
  });
});
