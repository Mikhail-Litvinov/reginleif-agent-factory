-- Migration 0007 seeds the system task without its required initial revision.
INSERT INTO task_revisions(id,task_id,revision_number,requirements,acceptance_criteria,constraints,change_reason)
SELECT gen_random_uuid(), id, 1, '', '[]'::jsonb, '{}'::jsonb, 'initial'
FROM tasks WHERE id = '00000000-0000-4000-8000-000000000008'
AND NOT EXISTS (SELECT 1 FROM task_revisions WHERE task_id = tasks.id AND revision_number = 1);
UPDATE tasks SET current_revision = 1, row_version = row_version + 1, updated_at = now()
WHERE id = '00000000-0000-4000-8000-000000000008' AND current_revision IS NULL;
