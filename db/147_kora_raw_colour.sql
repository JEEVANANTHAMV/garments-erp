-- =====================================================================
-- 147 · Knitting colour is "Cora / Raw" (client audio 30-Oct-2026; spelling C-O-R-A per client audio 04-Nov-2026 —
--       values first saved as 'Kora / Raw' are relabelled below)
--   Knitted fabric and undyed yarn have no colour of their own. They were shown as "raw", "GREY" (grey is a
--   real colour) or — on a dyeing DC — with the colour the job's CAD wanted (e.g. Orange) as the FABRIC colour.
--   trx_knitting_program_yarns / _stripes.colour   raw / kora / cora / greige spellings → 'Cora / Raw'
--   trx_fabric_process_roll_in.fabric_color        undyed rolls (no colour of their own) saved as GREY or with
--                                                   the knitting program's colour → 'Cora / Raw'
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
UPDATE trx_knitting_program_yarns SET colour = 'Cora / Raw'
 WHERE LOWER(TRIM(colour)) IN ('raw', 'kora', 'cora', 'greige', 'kora/raw', 'kora / raw', 'cora/raw', 'cora / raw', 'raw/kora', 'raw / kora', 'natural raw')
   AND colour <> 'Cora / Raw';

UPDATE trx_knitting_program_stripes SET colour = 'Cora / Raw'
 WHERE LOWER(TRIM(colour)) IN ('raw', 'kora', 'cora', 'greige', 'kora/raw', 'kora / raw', 'cora/raw', 'cora / raw', 'raw/kora', 'raw / kora', 'natural raw')
   AND colour <> 'Cora / Raw';

UPDATE trx_fabric_process_roll_in ri
  JOIN trx_fabric_roll fr ON fr.id = ri.fabric_roll_id
  LEFT JOIN trx_process_receipt pr ON pr.grn_id = fr.grn_id AND pr.src_type = 'KNITTING_PROGRAM'
  LEFT JOIN trx_knitting_program kp ON kp.id = pr.src_id
   SET ri.fabric_color = 'Cora / Raw'
 WHERE NULLIF(TRIM(fr.color_name), '') IS NULL
   AND (ri.fabric_color = 'GREY' OR (kp.fabric_colour IS NOT NULL AND ri.fabric_color = kp.fabric_colour));

-- 04-Nov-2026: the client spells it C-O-R-A. Relabel rolls saved with the earlier 'Kora / Raw' spelling.
UPDATE trx_fabric_process_roll_in SET fabric_color = 'Cora / Raw'
 WHERE LOWER(TRIM(fabric_color)) IN ('kora / raw', 'kora/raw') AND BINARY fabric_color <> BINARY 'Cora / Raw';
