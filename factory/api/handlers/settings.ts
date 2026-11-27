import type { Repo } from '../../db/repo/index.ts';

// api.md and database.md name these four settings (page.defaultLimit, page.maxLimit, token.overlapSeconds,
// confirm.windowSeconds) but give no value for any of them (docs silent). The numbers below are used only while the
// setting is absent or invalid; an owner-set setting always wins.
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_TOKEN_OVERLAP_SECONDS = 60;
export const DEFAULT_CONFIRM_WINDOW_SECONDS = 60;

const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export async function pageLimits(repo: Repo): Promise<{ defaultLimit: number; maxLimit: number }> {
  const settings = await repo.settings.snapshot(['page.defaultLimit', 'page.maxLimit']);
  const maxLimit = positive(settings['page.maxLimit']) ?? MAX_PAGE_LIMIT;
  return { defaultLimit: Math.min(positive(settings['page.defaultLimit']) ?? DEFAULT_PAGE_LIMIT, maxLimit), maxLimit };
}

export async function tokenOverlapSeconds(repo: Repo): Promise<number> {
  return positive((await repo.settings.snapshot(['token.overlapSeconds']))['token.overlapSeconds']) ?? DEFAULT_TOKEN_OVERLAP_SECONDS;
}

export async function confirmWindowSeconds(repo: Repo): Promise<number> {
  return positive((await repo.settings.snapshot(['confirm.windowSeconds']))['confirm.windowSeconds']) ?? DEFAULT_CONFIRM_WINDOW_SECONDS;
}
