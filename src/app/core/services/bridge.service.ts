import { inject, NgZone, Service } from '@angular/core';

import { AppOpName, AppOps, GitOpName, GitOps, MainEvents } from '../../../../shared/api';

interface GitoraBridge {
  git(op: string, ...args: unknown[]): Promise<unknown>;
  app(op: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    gitora?: GitoraBridge;
  }
}

type Params<F> = F extends (...args: infer A) => unknown ? A : never;
type Result<F> = F extends (...args: never[]) => Promise<infer R> ? R : never;

function cleanError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
}

@Service()
export class BridgeService {
  private readonly zone = inject(NgZone);

  get available(): boolean {
    return !!window.gitora;
  }

  private get api(): GitoraBridge {
    if (!window.gitora) throw new Error('Bridge not available');
    return window.gitora;
  }

  async git<K extends GitOpName>(op: K, ...args: Params<GitOps[K]>): Promise<Result<GitOps[K]>> {
    try {
      return (await this.api.git(op, ...args)) as Result<GitOps[K]>;
    } catch (e) {
      throw cleanError(e);
    }
  }

  async app<K extends AppOpName>(op: K, ...args: Params<AppOps[K]>): Promise<Result<AppOps[K]>> {
    try {
      return (await this.api.app(op, ...args)) as Result<AppOps[K]>;
    } catch (e) {
      throw cleanError(e);
    }
  }

  on<K extends keyof MainEvents>(event: K, cb: (payload: MainEvents[K]) => void): () => void {
    if (!window.gitora) return () => {};
    return this.api.on(event, (p) => this.zone.run(() => cb(p as MainEvents[K])));
  }
}
