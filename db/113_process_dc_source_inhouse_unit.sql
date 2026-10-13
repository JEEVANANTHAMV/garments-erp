-- 113: Process Outward DC (client voice note 13-Oct-2026, evening)
--   * "From process" is chosen per DC for out-and-back processes (printing, embroidery, washing …):
--       CUT  = cut panels at cutting, SEWING = PCS part-way through stitching (they come back to stitching WIP),
--       SEWN = stitched garments. A part-stitched PCS out on a DC is counted on the bundle (out_wip_qty) so the
--       stitching line cannot report it as sewn while it is away; loss on that DC is wip_loss_qty.
--   * A DC can go to an in-house unit (Units master: Stitching Unit 1, Unit 2 …) instead of a contractor:
--       no contractor, no rate, never on a contractor bill. vendor_id becomes optional, unit_id is added.
-- Re-runnable; every ALTER is guarded.

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='out_wip_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN out_wip_qty INT NOT NULL DEFAULT 0 COMMENT ''Part-stitched PCS out on a process DC (back to stitching WIP on receipt)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_cutting_bundle' AND COLUMN_NAME='wip_loss_qty');
SET @s = IF(@x=0, 'ALTER TABLE trx_cutting_bundle ADD COLUMN wip_loss_qty INT NOT NULL DEFAULT 0 COMMENT ''Part-stitched PCS rejected / short / lost on a process DC''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='source_level');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN source_level VARCHAR(10) NULL COMMENT ''CUT / SEWING / SEWN chosen on the DC (NULL = the process default)''', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='unit_id');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD COLUMN unit_id BIGINT UNSIGNED NULL COMMENT ''In-house unit the DC goes to (instead of a contractor)'', ADD KEY ix_jwc_unit (unit_id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- contractor optional (an in-house unit DC has none); the FK stays
SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND COLUMN_NAME='vendor_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_jobwork_challan MODIFY vendor_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_receipt' AND COLUMN_NAME='vendor_id' AND IS_NULLABLE='NO');
SET @s = IF(@x=1, 'ALTER TABLE trx_jobwork_receipt MODIFY vendor_id BIGINT UNSIGNED NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @x = (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='trx_jobwork_challan' AND CONSTRAINT_NAME='fk_jwc__unit');
SET @s = IF(@x=0, 'ALTER TABLE trx_jobwork_challan ADD CONSTRAINT fk_jwc__unit FOREIGN KEY (unit_id) REFERENCES mst_unit(id)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
