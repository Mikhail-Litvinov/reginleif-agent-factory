type Policy = Record<string, unknown>;

// database.md (execution_policies): a change that loosens a security column or raises a limit is an owner action with
// two presses. Fail-safe: a change counts as loosening unless it is provably a tightening.

// Lists of what is allowed: an added element loosens.
const ALLOW_LISTS = ['allowed_commands', 'allowed_directories', 'allowed_repositories', 'allowed_tools', 'git_operations'] as const;
// The list of operations that need confirmation: a removed element loosens (fewer operations are confirmed).
const CONFIRM_LISTS = ['confirmation_required'] as const;
// Documented as a free-form jsonb with no order: only a deep-equal value is provably not a loosening.
const OPAQUE = ['network'] as const;
const LIMITS = ['max_concurrent_tasks', 'max_tasks_per_agent', 'max_run_seconds', 'max_tokens', 'max_cost', 'max_auto_fixes', 'max_attempts', 'max_rework_rounds', 'max_child_depth', 'max_children_per_task'] as const;

const canonical = (value: unknown): string => {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};
const list = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined;

function limitLoosens(before: unknown, after: unknown): boolean {
  const unlimitedBefore = before === null || before === undefined;
  const unlimitedAfter = after === null || after === undefined;
  if (unlimitedBefore) return false; // nothing was limited: a value or the same null cannot loosen
  if (unlimitedAfter) return true; // unlimited replaces a value
  const a = Number(before), b = Number(after);
  return !Number.isFinite(a) || !Number.isFinite(b) || b > a;
}

/**
 * Names of the columns by which `next` loosens `current` (API snake_case). An empty result means the change is provably
 * not a loosening. A missing `current` (no policy yet) loosens nothing.
 */
export function loosenedColumns(current: Policy | undefined, next: Policy): string[] {
  if (!current) return [];
  const loosened: string[] = [];
  for (const column of ALLOW_LISTS) {
    const before = list(current[column]), after = list(next[column]);
    if (!before || !after) { if (canonical(current[column]) !== canonical(next[column])) loosened.push(column); continue; }
    if (after.some(item => !before.includes(item))) loosened.push(column);
  }
  for (const column of CONFIRM_LISTS) {
    const before = list(current[column]), after = list(next[column]);
    if (!before || !after) { if (canonical(current[column]) !== canonical(next[column])) loosened.push(column); continue; }
    if (before.some(item => !after.includes(item))) loosened.push(column);
  }
  for (const column of OPAQUE) if (canonical(current[column]) !== canonical(next[column])) loosened.push(column);
  // false -> true loosens; an unrecognised value is not provably a tightening.
  if (current.auto_accept_low_risk !== next.auto_accept_low_risk && next.auto_accept_low_risk !== false) loosened.push('auto_accept_low_risk');
  for (const column of LIMITS) if (limitLoosens(current[column], next[column])) loosened.push(column);
  // A limit's amount is meaningful only in its currency: a changed currency under a cost limit changes what it allows.
  if ((current.currency ?? null) !== (next.currency ?? null) && (current.max_cost ?? null) !== null) loosened.push('currency');
  return loosened;
}
