-- 96: knitting program from the CAD (client voice notes 03-Oct-2026).
--   A program is made "from CAD" (the job's CAD fabric program line: fabric, GSM, Dia, colour, required KG are
--   filled in) or "direct". Its yarn comes only from the job's own yarn stock (PO GRN lots / job transfers).
-- Re-runnable.
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_knitting_program' AND COLUMN_NAME='program_source');
SET @s = IF(@x=0, 'ALTER TABLE trx_knitting_program
  ADD COLUMN program_source VARCHAR(10) NOT NULL DEFAULT ''DIRECT'' COMMENT ''CAD / DIRECT'',
  ADD COLUMN cad_req_id BIGINT UNSIGNED NULL COMMENT ''CAD the program was made from'',
  ADD COLUMN cad_fp_id BIGINT UNSIGNED NULL COMMENT ''trx_cad_fabric_program line (fabric × colour) it covers'',
  ADD COLUMN fabric_colour VARCHAR(80) NULL,
  ADD KEY ix_kp_cadfp (cad_fp_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
