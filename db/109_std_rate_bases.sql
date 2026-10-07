-- Migration 109: Add std_rate to mst_yarn_base and mst_fabric_base for BOM standard costing reference

ALTER TABLE mst_yarn_base
  ADD COLUMN std_rate DECIMAL(18,4) NOT NULL DEFAULT 0.0000 AFTER base_uom;

ALTER TABLE mst_fabric_base
  ADD COLUMN std_rate DECIMAL(18,4) NOT NULL DEFAULT 0.0000 AFTER base_uom;

-- Copy existing std_rate from first active variant if available
UPDATE mst_yarn_base yb
  LEFT JOIN (SELECT yarn_base_id, MAX(std_rate) AS max_rate FROM mst_yarn WHERE std_rate > 0 GROUP BY yarn_base_id) y
    ON y.yarn_base_id = yb.id
   SET yb.std_rate = COALESCE(y.max_rate, 0.0000);

UPDATE mst_fabric_base fb
  LEFT JOIN (SELECT fabric_base_id, MAX(std_rate) AS max_rate FROM mst_fabric WHERE std_rate > 0 GROUP BY fabric_base_id) f
    ON f.fabric_base_id = fb.id
   SET fb.std_rate = COALESCE(f.max_rate, 0.0000);
