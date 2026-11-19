import { fetchJson, type Widget, type WidgetEnv } from './widget';

type CiState = 'ok' | 'fail' | 'run' | null;

export function ciStateFrom(run: { status?: string; conclusion?: string | null } | undefined): CiState {
  if (!run) return null;
  if (run.status !== 'completed') return 'run';
  return run.conclusion === 'success' || run.conclusion === 'skipped' ? 'ok' : 'fail';
}

/**
 * Developer status: latest GitHub Actions run on a branch, PRs waiting for your
 * review, and simple HTTP health checks. Only goes loud when something is wrong.
 */
export function createDevWidget(): Widget {
  let ci: CiState = null;
  let reviews: number | null = null;
  let down: string[] = [];
  let checked = false;

  const gh = (env: WidgetEnv, path: string) =>
    fetchJson(env.fetch, `https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(env.settings.dev.githubToken ? { Authorization: `Bearer ${env.settings.dev.githubToken}` } : {}),
      },
    });

  return {
    id: 'dev',
    refreshMs: 2 * 60_000,
    async refresh(env) {
      const { repo, branch, githubToken, healthUrls } = env.settings.dev;
      const jobs: Promise<void>[] = [];
      if (repo) {
        jobs.push(
          gh(env, `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch || 'main')}&per_page=1`)
            .then((j) => { ci = ciStateFrom(j.workflow_runs?.[0]); }),
        );
      }
      if (githubToken) {
        jobs.push(
          gh(env, `/search/issues?q=${encodeURIComponent('is:pr is:open review-requested:@me archived:false')}&per_page=1`)
            .then((j) => { reviews = j.total_count ?? 0; }),
        );
      }
      jobs.push(
        Promise.all(
          healthUrls.filter(Boolean).map(async (url) => {
            try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 8000);
              const res = await env.fetch(url, { signal: ctrl.signal, cache: 'no-store' });
              clearTimeout(t);
              return res.ok ? null : url;
            } catch {
              return url;
            }
          }),
        ).then((r) => { down = r.filter((u): u is string => !!u); }),
      );
      await Promise.all(jobs);
      checked = true;
    },
    render(env) {
      if (!checked) return null;
      const parts: string[] = [];
      if (ci === 'fail') parts.push('CI 실패');
      else if (ci === 'run') parts.push('CI 진행');
      else if (ci === 'ok') parts.push('CI ok');
      if (reviews) parts.push(`리뷰 ${reviews}`);
      if (env.settings.dev.healthUrls.length) {
        parts.push(down.length ? `다운 ${down.map((u) => hostOf(u)).join(',')}` : '서버 ok');
      }
      if (!parts.length) return null;
      return { text: parts.join(' '), urgent: ci === 'fail' || down.length > 0 };
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return url;
  }
}
