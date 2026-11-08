import type { NewPullRequest, PullRequest, RemoteRepository } from '@core/models';
import { GitProvider, http, Profile, ProviderContext } from './provider';

interface GhRepo {
  name: string; full_name: string; description: string | null; private: boolean; fork: boolean;
  default_branch: string; clone_url: string; ssh_url: string; html_url: string; updated_at: string;
}
interface GhPull {
  id: number; number: number; title: string; user: { login: string }; state: string;
  merged_at: string | null; head: { ref: string }; base: { ref: string }; html_url: string;
  created_at: string; draft: boolean;
}

/** GitHub.com y GitHub Enterprise Server (api en https://host/api/v3). */
export class GitHubProvider implements GitProvider {
  readonly kind = 'github' as const;
  readonly defaultApi = 'https://api.github.com';
  readonly defaultHost = 'github.com';

  private headers(token: string) {
    return { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  }

  async profile(api: string, token: string): Promise<Profile> {
    const u = await http<{ login: string; name: string | null; avatar_url: string }>(`${api}/user`, { headers: this.headers(token) });
    return { username: u.login, displayName: u.name ?? undefined, avatarUrl: u.avatar_url };
  }

  async listRepositories(ctx: ProviderContext, query: string): Promise<RemoteRepository[]> {
    const api = ctx.account.baseUrl;
    const repos: GhRepo[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await http<GhRepo[]>(
        `${api}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        { headers: this.headers(ctx.token) },
      );
      repos.push(...batch);
      if (batch.length < 100) break;
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
    const list = await http<GhPull[]>(
      `${ctx.account.baseUrl}/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
      { headers: this.headers(ctx.token) },
    );
    return list.map((p) => this.map(p));
  }

  async createPullRequest(ctx: ProviderContext, owner: string, repo: string, pr: NewPullRequest): Promise<PullRequest> {
    const p = await http<GhPull>(`${ctx.account.baseUrl}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { ...this.headers(ctx.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: pr.title, body: pr.body, head: pr.source, base: pr.target, draft: !!pr.draft }),
    });
    return this.map(p);
  }

  basicCredentials(ctx: ProviderContext) {
    return { user: 'x-access-token', password: ctx.token };
  }

  private map(p: GhPull): PullRequest {
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      author: p.user.login,
      state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      url: p.html_url,
      createdAt: p.created_at,
      draft: p.draft,
    };
  }
}
