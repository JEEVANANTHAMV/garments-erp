-- =====================================================================
-- 153 · Gate Security permissions (04-Nov-2026)
--   The gate screens (gate inward / outward, gate pass, visitor register + visitor report) check
--   GATE_INWARD.VIEW / .CREATE and GATE_OUTWARD.VIEW / .CREATE, but those permissions were never seeded —
--   so only super admins could use the gate, and a security guard could not be given access on the Roles screen.
--   Seeds the 4 permissions under the existing GATE_INWARD / GATE_OUTWARD modules, a "Gate Security" role in
--   every company, and grants them ONE time per company (flag GATE_PERMS_GRANTED) to SUPER_ADMIN, ADMIN,
--   GATE_SECURITY and the store roles (they receive goods at the gate). Later Roles-screen changes are kept.
-- Idempotent: the runner re-applies files >= 10 on every deploy.
-- =====================================================================
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'GATE_INWARD' mod_code, 'GATE_INWARD.VIEW' code, 'View gate inward entries, visitors and the visitor report' name UNION ALL
        SELECT 'GATE_INWARD', 'GATE_INWARD.CREATE', 'Record gate inward entries and visitors (photo, in / out)' UNION ALL
        SELECT 'GATE_OUTWARD', 'GATE_OUTWARD.VIEW', 'View gate outward entries and gate passes' UNION ALL
        SELECT 'GATE_OUTWARD', 'GATE_OUTWARD.CREATE', 'Record gate outward entries / gate passes (scan DCs)') t
    ON t.mod_code = m.module_code
 WHERE NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);

INSERT INTO mst_role (company_id, role_code, role_name, description, is_system)
SELECT c.id, 'GATE_SECURITY', 'Gate Security', 'Security at the gate: inward / outward, gate pass, visitors, vehicle requests', 0
  FROM mst_company c
 WHERE NOT EXISTS (SELECT 1 FROM mst_role x WHERE x.company_id = c.id AND x.role_code = 'GATE_SECURITY');

INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r
  JOIN mst_permission p ON p.permission_code IN ('GATE_INWARD.VIEW', 'GATE_INWARD.CREATE', 'GATE_OUTWARD.VIEW', 'GATE_OUTWARD.CREATE')
 WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN', 'GATE_SECURITY', 'STORE_KEEPER', 'FABRIC_STORE')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'GATE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
-- security also raises vehicle requests (pickup / courier) when transport is installed (migration 150)
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code = 'TRANSPORT.REQUEST'
 WHERE r.role_code = 'GATE_SECURITY'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'GATE_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'GATE_PERMS_GRANTED', '1', 'Gate permissions granted to the standard roles (one time, migration 153)' FROM mst_company;
