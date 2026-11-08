import { TestBed } from '@angular/core/testing';

import { Icon } from './icon';

describe('Icon', () => {
  it('renders an svg sized by the size input', async () => {
    const fixture = TestBed.createComponent(Icon);
    fixture.componentRef.setInput('name', 'search');
    fixture.componentRef.setInput('size', 20);
    await fixture.whenStable();
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.innerHTML).not.toBe('');
  });
});
