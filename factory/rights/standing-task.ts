// The system project is seeded by migration 0007.
export const FACTORY_PROJECT_ID = '00000000-0000-4000-8000-000000000007';

export async function standingTaskFor(tasks: { list(input: { projectId: string; originType: string }): Promise<{ id: string }[]> }, projectId: string | null): Promise<string> {
  const rows = await tasks.list({ projectId: projectId ?? FACTORY_PROJECT_ID, originType: 'standing' });
  if (rows.length !== 1) throw new Error('Project must have exactly one standing task');
  return rows[0]!.id;
}
