import { ComponentFixture, TestBed } from '@angular/core/testing';

import { HostsLayout } from './hosts-layout';

describe('HostsLayout', () => {
  let component: HostsLayout;
  let fixture: ComponentFixture<HostsLayout>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostsLayout],
    }).compileComponents();

    fixture = TestBed.createComponent(HostsLayout);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
