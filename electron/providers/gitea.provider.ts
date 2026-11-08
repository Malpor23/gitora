import type { NewPullRequest, PullRequest, RemoteRepository } from '@core/models';
import { GitProvider, http, Profile, ProviderContext } from './provider';

interface GtRepo {
  name: string; full_name: string; description: string; private: boolean; fork: boolean;
  default_branch: string; clone_url: string; ssh_url: string; html_url: string; updated_at: string;
}
interface GtPull {
  id: number; number: number; title: string; user: { login: string }; state: string; merged: boolean;
  head: { ref: string }; base: { ref: string }; html_url: string; created_at: string; draft?: boolean;
}

/** Gitea, Forgejo y Codeberg (api en https://host/api/v1). */
export class GiteaProvider implements GitProvider {
  readonly kind = 'gitea' as const;
  readonly defaultApi = 'https://codeberg.org/api/v1';
  readonly defaultHost = 'codeberg.org';

  private headers(token: string) {
    return { Authorization: `token ${token}` };
  }

  async profile(api: string, token: string): Promise<Profile> {
    const u = await http<{ login: string; full_name: string; avatar_url: string }>(`${api}/user`, { headers: this.headers(token) });
    return { username: u.login, displayName: u.full_name || undefined, avatarUrl: u.avatar_url };
  }

  async profileWithPassword(api: string, username: string, password: string): Promise<Profile> {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    const u = await http<{ login: string; full_name: string; avatar_url: string }>(`${api}/user`, {
      headers: { Authorization: `Basic ${basic}` },
    });
    return { username: u.login, displayName: u.full_name || undefined, avatarUrl: u.avatar_url };
  }

  async listRepositories(ctx: ProviderContext, query: string): Promise<RemoteRepository[]> {
    const repos: GtRepo[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await http<GtRepo[]>(`${ctx.account.baseUrl}/user/repos?limit=50&page=${page}`, { headers: this.headers(ctx.token) });
      repos.push(...batch);
      if (batch.length < 50) break;
    }
    const q = query.toLowerCase();
    return repos
      .filter((r) => !q || r.full_name.toLowerCase().includes(q))
      .map((r) => ({
        provider: this.kind,
        accountId: ctx.account.id,
        name: r.name,
        fullName: r.full_name,
        description: r.description ?? '',
        private: r.private,
        fork: r.fork,
        defaultBranch: r.default_branch,
        cloneUrl: r.clone_url,
        sshUrl: r.ssh_url,
        webUrl: r.html_url,
        updatedAt: r.updated_at,
      }));
  }

  async pullRequests(ctx: ProviderContext, owner: string, repo: string): Promise<PullRequest[]> {
    const list = await http<GtPull[]>(`${ctx.account.baseUrl}/repos/${owner}/${repo}/pulls?state=open&limit=50`, { headers: this.headers(ctx.token) });
    return list.map((p) => this.map(p));
  }

  async createPullRequest(ctx: ProviderContext, owner: string, repo: string, pr: NewPullRequest): Promise<PullRequest> {
    const p = await http<GtPull>(`${ctx.account.baseUrl}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { ...this.headers(ctx.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: pr.draft ? `WIP: ${pr.title}` : pr.title, body: pr.body, head: pr.source, base: pr.target }),
    });
    return this.map(p);
  }

  basicCredentials(ctx: ProviderContext) {
    return { user: ctx.account.username, password: ctx.token };
  }

  private map(p: GtPull): PullRequest {
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      author: p.user.login,
      state: p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed',
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      url: p.html_url,
      createdAt: p.created_at,
      draft: !!p.draft,
    };
  }
}
