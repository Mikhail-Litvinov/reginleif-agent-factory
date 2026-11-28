-- Migration 0010: the registry-first question gate runs in the Control Worker (af_control), which therefore needs the
-- one write the gate performs: attaching a newly found record to an inquiry (registry_inquiry_results insert).
-- 0006 granted that insert to af_api only. Reads (inquiries, results, records, embeddings) are already granted to af_control.
-- No new table, no DELETE, no UPDATE: the verdict columns stay af_api's.
-- Hand-written guard and grant.
CREATE FUNCTION af_0010_result_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user = 'af_control' AND (NEW.found_by IS DISTINCT FROM 'gate' OR NEW.verdict IS NOT NULL OR NEW.difference IS NOT NULL OR NEW.conflicts_with_id IS NOT NULL OR NEW.verdict_at IS NOT NULL) THEN
  RAISE EXCEPTION 'control may attach gate-found records without a verdict only';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER registry_results_insert BEFORE INSERT ON registry_inquiry_results FOR EACH ROW EXECUTE FUNCTION af_0010_result_insert();
--> statement-breakpoint
GRANT INSERT ON registry_inquiry_results TO af_control;
