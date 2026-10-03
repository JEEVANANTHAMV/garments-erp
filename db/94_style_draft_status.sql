-- 94: style "Save as Draft" (client voice note 03-Oct-2026).
-- A draft used to be saved as an inactive style (is_active = 0) and the Styles list shows active styles only,
-- so drafts disappeared. A draft is now a real status (STYLE / DRAFT); the style stays active and listed.
-- Re-runnable.

INSERT IGNORE INTO cfg_status (domain, code, label, sort_order, is_terminal) VALUES ('STYLE', 'DRAFT', 'Draft', 0, 0);

-- one time per company: styles saved as draft the old way (inactive, no status) become Draft styles
UPDATE mst_style st
  JOIN cfg_status d ON d.domain = 'STYLE' AND d.code = 'DRAFT'
   SET st.status_id = d.id, st.is_active = 1
 WHERE st.is_active = 0 AND st.status_id IS NULL AND COALESCE(st.is_deleted, 0) = 0
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting x WHERE x.company_id = st.company_id AND x.setting_key = 'STYLE_DRAFTS_MIGRATED');

INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description, is_editable)
SELECT c.id, 'STYLE_DRAFTS_MIGRATED', '1', 'One-time: inactive styles without a status were turned into Draft styles (migration 94)', 0
  FROM mst_company c;
