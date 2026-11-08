import { TestBed } from '@angular/core/testing';

import { ContextMenuService } from './context-menu.service';

describe('ContextMenuService', () => {
  let service: ContextMenuService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ContextMenuService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('opens below the anchor and drops dangling separators', () => {
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () => ({ left: 40, bottom: 50 }) as DOMRect;
    service.openAt(anchor, [{ separator: true }, { label: 'A' }, { separator: true }]);
    const st = service.state()!;
    expect([st.x, st.y]).toEqual([40, 52]);
    expect(st.items.map((i) => i.label)).toEqual(['A']);
  });
});
