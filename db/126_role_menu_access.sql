-- 126 · Menu access per role (client call 15-Oct-2026: "nothing is deleted — only visibility; admin shows / hides modules
-- user-wise"). On top of permissions: HIDE takes a screen off a role's menu, SHOW puts a normally hidden (older / tab)
-- screen on it. Permissions still decide what a user may open and do.
CREATE TABLE IF NOT EXISTS cfg_role_menu (
  company_id  BIGINT UNSIGNED NOT NULL,
  role_id     INT UNSIGNED NOT NULL,
  path        VARCHAR(120) NOT NULL,
  mode        ENUM('HIDE','SHOW') NOT NULL,
  updated_by  BIGINT UNSIGNED NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (company_id, role_id, path),
  KEY ix_role_menu_role (role_id),
  CONSTRAINT fk_role_menu__role FOREIGN KEY (role_id) REFERENCES mst_role(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='Per-role menu visibility overrides (visibility only)';
