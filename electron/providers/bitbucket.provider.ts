import type { NewPullRequest, PullRequest, RemoteRepository } from '@core/models';
import { GitProvider, http, Profile, ProviderContext } from './provider';

interface BbRepo {
  name: string; full_name: string; description: string; is_private: boolean; parent?: unknown;
  mainbranch?: { name: string }; links: { clone: { name: string; href: string }[]; html: { href: string } };
  updated_on: string;
}
interface BbPr {
  id: number; title: string; author: { display_name: string; nickname?: string }; state: string;
  source: { branch: { name: string } }; destination: { branch: { name: string } };
  links: { html: { href: string } }; created_on: string; draft?: boolean;
}
interface Page<T> { values: T[]; next?: string }

/**
 * Bitbucket Cloud. Autenticación con usuario + App Password / API token
 * (Basic auth), que es lo que Bitbucket exige para la API y para git por HTTPS.
 */
export class BitbucketProvider implements GitProvider {
  readonly kind = 'bitbucket' as const;
  readonly defaultApi = 'https://api.bitbucket.org/2.0';
  readonly defaultHost = 'bitbucket.org';

  private headers(user: string, token: string) {
    return { Authorization: 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64') };
  }

  async profile(api: string, token: string, username?: string): Promise<Profile> {
    if (!username) throw new Error('Bitbucket necesita el nombre de usuario además del App Password');
    const u = await http<{ username?: string; nickname?: string; display_name: string; links: { avatar: { href: string } } }>(
      `${api}/user`,
      { headers: this.headers(username, token) },
    );
    return { username: username, displayName: u.display_name, avatarUrl: u.links?.avatar?.href };
  }

  async listRepositories(ctx: ProviderContext, query: string): Promise<RemoteRepository[]> {
    const h = this.headers(ctx.account.username, ctx.token);
    const q = query ? `&q=${encodeURIComponent(`name ~ "${query.replace(/"/g, '')}"`)}` : '';
    let url: string | undefined = `${ctx.account.baseUrl}/repositories?role=member&pagelen=100&sort=-updated_on${q}`;
    const repos: BbRepo[] = [];
    for (let i = 0; url && i < 5; i++) {
      const page: Page<BbRepo> = await http<Page<BbRepo>>(url, { headers: h });
      repos.push(...page.values);
      url = page.next;
    }
    return repos.map((r) => ({
      provider: this.kind,
      accountId: ctx.account.id,
      name: r.name,
      fullName: r.full_name,
      description: r.description ?? '',
      private: r.is_private,
      fork: !!r.parent,
      defaultBranch: r.mainbranch?.name ?? 'main',
      cloneUrl: r.links.clone.find((c) => c.name === 'https')?.href.replace(/^https:\/\/[^@]+@/, 'https://') ?? '',
      sshUrl: r.links.clone.find((c) => c.name === 'ssh')?.href ?? '',
      webUrl: r.links.html.href,
      updatedAt: r.updated_on,
    }));
  }

  async pullRequests(ctx: ProviderContext, owner: string, repo: string): Promise<PullRequest[]> {
    const page = await http<Page<BbPr>>(
      `${ctx.account.baseUrl}/repositories/${owner}/${repo}/pullrequests?state=OPEN&pagelen=50`,
      { headers: this.headers(ctx.account.username, ctx.token) },
    );
    return page.values.map((p) => this.map(p));
  }

  async createPullRequest(ctx: ProviderContext, owner: string, repo: string, pr: NewPullRequest): Promise<PullRequest> {
    const p = await http<BbPr>(`${ctx.account.baseUrl}/repositories/${owner}/${repo}/pullrequests`, {
      method: 'POST',
      headers: { ...this.headers(ctx.account.username, ctx.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: pr.title,
        description: pr.body,
        source: { branch: { name: pr.source } },
        destination: { branch: { name: pr.target } },
        draft: !!pr.draft,
      }),
    });
    return this.map(p);
  }

  basicCredentials(ctx: ProviderContext) {
    return { user: ctx.account.username, password: ctx.token };
  }

  private map(p: BbPr): PullRequest {
    return {
      id: p.id,
      number: p.id,
      title: p.title,
      author: p.author.nickname ?? p.author.display_name,
      state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? 'open' : 'closed',
      sourceBranch: p.source.branch.name,
      targetBranch: p.destination.branch.name,
      url: p.links.html.href,
      createdAt: p.created_on,
      draft: !!p.draft,
    };
  }
}
