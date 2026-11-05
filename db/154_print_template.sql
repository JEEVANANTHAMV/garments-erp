-- 154: print template setting (client voice notes 05-Nov-2026).
--   Every PO / DC printout comes in two designs: COLOUR (light professional colour) or BW (classic black & white
--   bordered layout for B/W printers). PRINT_TEMPLATE is the company default — Print / PDF buttons can still pick
--   the other one per print (?template=colour|bw); e-mailed PDFs always use this default.
-- Re-runnable.
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT c.id, 'PRINT_TEMPLATE', 'COLOUR', 'Printout design for POs and DCs: COLOUR (light professional colour) / BW (black & white, bordered) — default for Print / PDF / e-mail'
  FROM mst_company c;
