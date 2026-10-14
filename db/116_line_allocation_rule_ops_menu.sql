-- 116 · Client call 14-Oct-2026
-- 1. One rule for checking / ironing / packing DCs: take only bundles that came through the previous process
--    (a confirmed line allocation of it, or received back from a DC of it). 1 = required (client's choice), 0 = any stock.
-- 2. Line QC (AQL inspections) stays hidden; admin can show it.
-- 3. "Process completed" needs operations for every process: default ones for checking / ironing / packing stages
--    that have none (rate 0 — set in Process & Operations / rate cards).
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'DC_REQUIRES_LINE_ALLOCATION', '1',
       'Checking / ironing / packing DC: 1 = only bundles that came through the previous process (line allocation, or back from its DC); 0 = any available stock'
  FROM mst_company;

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'MENU_SHOW_LINE_QC', '0',
       'Menu: 1 = show "Line QC (AQL inspections)" under Checking · Ironing · Packing; 0 = hidden'
  FROM mst_company;

-- op codes are unique per company and several stage codes can be the same process (IRONING / FINISHING), so the
-- code carries the stage: IRONING-IRONING, FINISHING-IRONING, PACKING-FOLDING …
INSERT INTO mst_process_operation (company_id, stage_id, op_code, op_name, sort_order)
SELECT ps.company_id, ps.id, CONCAT(LEFT(UPPER(ps.stage_code), 14), '-', v.op_code), v.op_name, v.sort_order
  FROM cfg_process_stage ps
  JOIN (SELECT 'CHECK,CHECKING' codes, 'CHECKING' op_code, 'Checking' op_name, 10 sort_order
        UNION ALL SELECT 'IRON,IRONING,FINISH,FINISHING,PRESS', 'IRONING', 'Ironing', 10
        UNION ALL SELECT 'PACK,PACKING', 'FOLDING', 'Folding', 10
        UNION ALL SELECT 'PACK,PACKING', 'PACKING', 'Packing', 20) v
    ON FIND_IN_SET(UPPER(ps.stage_code), v.codes) > 0
 WHERE NOT EXISTS (SELECT 1 FROM mst_process_operation o
                    WHERE o.company_id = ps.company_id AND o.op_code = CONCAT(LEFT(UPPER(ps.stage_code), 14), '-', v.op_code))
   -- only stages the client has not set up themselves
   AND NOT EXISTS (SELECT 1 FROM mst_process_operation o2
                    WHERE o2.stage_id = ps.id AND o2.op_code NOT LIKE CONCAT(LEFT(UPPER(ps.stage_code), 14), '-%'));
