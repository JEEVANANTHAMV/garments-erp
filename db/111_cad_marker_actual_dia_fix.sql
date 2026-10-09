-- Migration 111: CAD marker actual fabric dia (client call 09-Oct-2026)
-- Until 09-Oct-2026 the CAD screen stored dia_in = ROUND(table width), i.e. 60 for a 58" fabric on a 60" table
-- (table width = actual dia + width allowance). A correct row never has dia_in = ROUND(table_width_in) when the
-- allowance is >= 1", so only the wrong rows are touched. Table width (used for weight / lay calcs) is unchanged.
UPDATE trx_cad_marker
   SET dia_in = ROUND(table_width_in - width_allowance_in)
 WHERE dia_in IS NOT NULL
   AND table_width_in > 0
   AND width_allowance_in >= 1
   AND dia_in = ROUND(table_width_in);
