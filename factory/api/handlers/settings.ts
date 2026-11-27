import type { Repo } from '../../db/repo/index.ts';

const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export async function pageLimits(repo: Repo): Promise<{ defaultLimit: number; maxLimit: number }> {
  const settings = await repo.settings.snapshot(['page.defaultLimit', 'page.maxLimit']);
  // api.md makes both limits settings but does not set bootstrap values; use these fallbacks only when absent or invalid.
  const maxLimit = positive(settings['page.maxLimit']) ?? 100;
  return { defaultLimit: Math.min(positive(settings['page.defaultLimit']) ?? 50, maxLimit), maxLimit };
}

export async function tokenOverlapSeconds(repo: Repo): Promise<number> {
  // security.md requires a short overlap; token.overlapSeconds is the configured value, with a one-minute bootstrap fallback.
  return positive((await repo.settings.snapshot(['token.overlapSeconds']))['token.overlapSeconds']) ?? 60;
}
