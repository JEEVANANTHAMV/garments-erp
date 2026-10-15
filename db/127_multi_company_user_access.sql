-- 127 · Multi-company user access (client call 15-Oct-2026)
--
-- A user can log in to any company they are mapped to. If a user has access to
-- more than one company, the login screen shows a company picker after credentials
-- are verified. The JWT carries the chosen company id.
--
-- map_user_company: which companies a user may enter.
-- On first run the migration seeds the mapping from each user's home company.

CREATE TABLE IF NOT EXISTS map_user_company (
  user_id     BIGINT UNSIGNED NOT NULL,
  company_id  BIGINT UNSIGNED NOT NULL,
  is_default  TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = pre-selected at login',
  granted_by  BIGINT UNSIGNED NULL,
  granted_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, company_id),
  KEY ix_muc__company (company_id),
  CONSTRAINT fk_muc__user    FOREIGN KEY (user_id)    REFERENCES mst_user(id) ON DELETE CASCADE,
  CONSTRAINT fk_muc__company FOREIGN KEY (company_id) REFERENCES mst_company(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Which companies a user may log in to';

-- Seed: every existing user gets access to their home company (idempotent).
INSERT IGNORE INTO map_user_company (user_id, company_id, is_default)
SELECT id, company_id, 1 FROM mst_user WHERE is_deleted = 0;

-- Add COMPANY.CREATE permission for administrators to create new companies.
INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, 'COMPANY.CREATE', 'Create a new company entity'
  FROM mst_module m
 WHERE m.module_code = 'ADMIN'
   AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = 'COMPANY.CREATE');

-- Grant COMPANY.CREATE to SUPER_ADMIN and ADMIN roles.
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code = 'COMPANY.CREATE'
 WHERE r.role_code IN ('SUPER_ADMIN', 'ADMIN')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
