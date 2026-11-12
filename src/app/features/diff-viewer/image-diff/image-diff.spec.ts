import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { BridgeService } from '@core/services';
import { ImageDiff } from './image-diff';

const blob = (b64: string) => ({ mime: 'image/png', base64: b64, size: 2048 });

describe('ImageDiff', () => {
  let git: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<ImageDiff>;

  async function setup(
    before: { rev: string | null; path: string } | null,
    after: { rev: string | null; path: string } | null,
  ) {
    fixture = TestBed.createComponent(ImageDiff);
    fixture.componentRef.setInput('repo', '/r');
    fixture.componentRef.setInput('before', before);
    fixture.componentRef.setInput('after', after);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    git = vi.fn(async (_op: string, _repo: string, rev: string | null) =>
      blob(rev === 'old' ? 'QQ==' : 'Qg=='),
    );
    TestBed.configureTestingModule({
      imports: [ImageDiff],
      providers: [{ provide: BridgeService, useValue: { git } }],
    });
  });

  it('pide cada versión por su revisión y las muestra lado a lado', async () => {
    const el = await setup({ rev: 'old', path: 'a.png' }, { rev: null, path: 'a.png' });
    expect(git).toHaveBeenCalledWith('imageBlob', '/r', 'old', 'a.png');
    expect(git).toHaveBeenCalledWith('imageBlob', '/r', null, 'a.png');
    const imgs = el.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute('src')).toContain('data:image/png;base64,QQ==');
    expect(imgs[1].getAttribute('src')).toContain('data:image/png;base64,Qg==');
    expect(el.querySelectorAll('button').length).toBe(3);
  });

  it('con un archivo nuevo muestra solo la versión nueva y sin selector de modo', async () => {
    const el = await setup(null, { rev: 'new', path: 'a.png' });
    expect(git).toHaveBeenCalledTimes(1);
    expect(el.querySelectorAll('img').length).toBe(1);
    expect(el.querySelectorAll('button').length).toBe(0);
  });

  it('el modo deslizador recorta la imagen anterior según el control', async () => {
    const el = await setup({ rev: 'old', path: 'a.png' }, { rev: 'new', path: 'a.png' });
    const buttons = el.querySelectorAll('button');
    buttons[1].click();
    fixture.detectChanges();
    const slider = el.querySelector('input[type=range]') as HTMLInputElement;
    expect(slider.getAttribute('aria-label')).toBeTruthy();
    slider.value = '30';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const top = el.querySelectorAll('img')[1] as HTMLImageElement;
    expect(top.style.clipPath).toContain('70%');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('el modo mezcla ajusta la opacidad de la imagen nueva', async () => {
    const el = await setup({ rev: 'old', path: 'a.png' }, { rev: 'new', path: 'a.png' });
    el.querySelectorAll('button')[2].click();
    fixture.detectChanges();
    const slider = el.querySelector('input[type=range]') as HTMLInputElement;
    slider.value = '25';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const top = el.querySelectorAll('img')[1] as HTMLImageElement;
    expect(Number(top.style.opacity)).toBeCloseTo(0.25);
  });

  it('avisa cuando ninguna versión se puede leer', async () => {
    git.mockResolvedValue(null);
    const el = await setup({ rev: 'old', path: 'a.png' }, { rev: 'new', path: 'a.png' });
    expect(el.querySelectorAll('img').length).toBe(0);
    expect(el.textContent).toContain('No se puede mostrar la imagen');
  });
});
