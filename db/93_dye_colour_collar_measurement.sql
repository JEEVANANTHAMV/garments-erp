-- 93: client voice notes 03-Oct-2026.
--   * Fabric process DC (dyeing): each roll line keeps the fabric colour it went out in (grey / melange / ...)
--     next to the dye colour (color_name), so outward and inward show "Fabric colour" and "Dye colour".
--   * Collar knitting program: the size row carries the collar measurement loaded from the CAD.
-- Re-runnable.

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_fabric_process_roll_in' AND COLUMN_NAME='fabric_color');
SET @s = IF(@x=0, 'ALTER TABLE trx_fabric_process_roll_in ADD COLUMN fabric_color VARCHAR(80) NULL COMMENT ''Colour of the roll as issued (grey / melange / ...); color_name = dye colour'' AFTER color_name', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- existing DC lines: the issued roll's own colour (a grey roll shows GREY)
UPDATE trx_fabric_process_roll_in ri JOIN trx_fabric_roll fr ON fr.id = ri.fabric_roll_id
   SET ri.fabric_color = COALESCE(NULLIF(fr.color_name, ''), IF(fr.process_state = 'GREY', 'GREY', NULL))
 WHERE ri.fabric_color IS NULL;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_collar_program_size' AND COLUMN_NAME='measurement');
SET @s = IF(@x=0, 'ALTER TABLE trx_collar_program_size ADD COLUMN measurement VARCHAR(80) NULL COMMENT ''Collar measurement of the size (from the CAD flat-knit spec)'' AFTER size_code', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
