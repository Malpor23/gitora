import type { NewPullRequest, PullRequest, RemoteRepository } from '@core/models';
import { GitProvider, http, Profile, ProviderContext } from './provider';

interface GlProject {
  id: number; name: string; path_with_namespace: string; description: string | null; visibility: string;
  forked_from_project?: unknown; default_branch: string; http_url_to_repo: string; ssh_url_to_repo: string;
  web_url: string; last_activity_at: string;
}
interface GlMr {
  id: number; iid: number; title: string; author: { username: string }; state: string;
  source_branch: string; target_branch: string; web_url: string; created_at: string; draft?: boolean;
}

/** GitLab.com y GitLab self-hosted (api en https://host/api/v4). */
export class GitLabProvider implements GitProvider {
  readonly kind = 'gitlab' as const;
  readonly defaultApi = 'https://gitlab.com/api/v4';
  readonly defaultHost = 'gitlab.com';

  private headers(token: string) {
    return { 'PRIVATE-TOKEN': token };
  }

  async profile(api: string, token: string): Promise<Profile> {
    const u = await http<{ username: string; name: string; avatar_url: string }>(`${api}/user`, { headers: this.headers(token) });
    return { username: u.username, displayName: u.name, avatarUrl: u.avatar_url };
  }

  async listRepositories(ctx: ProviderContext, query: string): Promise<RemoteRepository[]> {
    const params = new URLSearchParams({ membership: 'true', per_page: '100', order_by: 'last_activity_at', simple: 'true' });
    if (query) params.set('search', query);
    const list = await http<GlProject[]>(`${ctx.account.baseUrl}/projects?${params}`, { headers: this.headers(ctx.token) });
    return list.map((p) => ({
      provider: this.kind,
      accountId: ctx.account.id,
      name: p.name,
      fullName: p.path_with_namespace,
      description: p.description ?? '',
      private: p.visibility !== 'public',
      fork: !!p.forked_from_project,
      defaultBranch: p.default_branch,
      cloneUrl: p.http_url_to_repo,
      sshUrl: p.ssh_url_to_repo,
      webUrl: p.web_url,
      updatedAt: p.last_activity_at,
    }));
  }

  private projectPath(owner: string, repo: string) {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  async pullRequests(ctx: ProviderContext, owner: string, repo: string): Promise<PullRequest[]> {
    const list = await http<GlMr[]>(
      `${ctx.account.baseUrl}/projects/${this.projectPath(owner, repo)}/merge_requests?state=opened&per_page=100`,
      { headers: this.headers(ctx.token) },
    );
    return list.map((m) => this.map(m));
  }

  async createPullRequest(ctx: ProviderContext, owner: string, repo: string, pr: NewPullRequest): Promise<PullRequest> {
    const m = await http<GlMr>(`${ctx.account.baseUrl}/projects/${this.projectPath(owner, repo)}/merge_requests`, {
      method: 'POST',
      headers: { ...this.headers(ctx.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: pr.draft ? `Draft: ${pr.title}` : pr.title,
        description: pr.body,
        source_branch: pr.source,
        target_branch: pr.target,
      }),
    });
    return this.map(m);
  }

  basicCredentials(ctx: ProviderContext) {
    return { user: 'oauth2', password: ctx.token };
  }

  private map(m: GlMr): PullRequest {
    return {
      id: m.id,
      number: m.iid,
      title: m.title,
      author: m.author.username,
      state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed',
      sourceBranch: m.source_branch,
      targetBranch: m.target_branch,
      url: m.web_url,
      createdAt: m.created_at,
      draft: !!m.draft,
    };
  }
}
