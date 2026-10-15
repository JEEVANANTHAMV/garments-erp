-- 128 · Working calendar / T&A defaults for EVERY company (client call 15-Oct-2026, multi-company)
--
-- Migration 26 seeds the weekly working calendar, the T&A activity library and five T&A templates for company 1 only
-- (hard-coded company_id = 1 and template ids 1..5). A company created later (Admin -> Companies) had none, so its
-- T&A screens were empty. This migration mirrors 26's values into every company that has no rows yet.
--
-- Also fixes a re-run bug in 26: mst_tna_template_activity had no unique key, so every deploy re-inserted all
-- template lines (company 1 had ~50 copies of each line, and a T&A created from a template got every copy).
-- Duplicates are removed (lowest id kept) and UNIQUE (template_id, sequence_no) is added so 26's INSERT IGNORE is a
-- no-op from now on. Nothing references mst_tna_template_activity.id (trx_tna_activity copies the values).
--
-- Idempotent; everything runs inside a procedure that first checks the tables exist (on a fresh database the files
-- run in name order, so this file runs before 26 creates them).

DROP PROCEDURE IF EXISTS mig128_tna_defaults;

CREATE PROCEDURE mig128_tna_defaults()
BEGIN
  IF (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('cfg_working_calendar','mst_tna_activity','mst_tna_template_header','mst_tna_template_activity')) = 4 THEN

    -- 1. De-duplicate template lines and stop 26 from adding them again.
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
                    AND TABLE_NAME = 'mst_tna_template_activity' AND INDEX_NAME = 'uq_tplact_seq') THEN
      DELETE a FROM mst_tna_template_activity a
        JOIN mst_tna_template_activity b ON b.template_id = a.template_id AND b.sequence_no = a.sequence_no AND b.id < a.id;
      ALTER TABLE mst_tna_template_activity ADD UNIQUE KEY uq_tplact_seq (template_id, sequence_no);
    END IF;

    -- 2. Weekly working calendar (Mon-Sat 8 h, Sunday off) for every company; unique (company_id, day_of_week).
    INSERT IGNORE INTO cfg_working_calendar (company_id, day_of_week, day_name, is_working_day, standard_hours)
    SELECT c.id, v.day_of_week, v.day_name, v.is_working_day, v.standard_hours
      FROM mst_company c
      CROSS JOIN (
              SELECT 0 AS day_of_week, 'Sunday' AS day_name, 0 AS is_working_day, 0.00 AS standard_hours
    UNION ALL SELECT 1, 'Monday', 1, 8.00
    UNION ALL SELECT 2, 'Tuesday', 1, 8.00
    UNION ALL SELECT 3, 'Wednesday', 1, 8.00
    UNION ALL SELECT 4, 'Thursday', 1, 8.00
    UNION ALL SELECT 5, 'Friday', 1, 8.00
    UNION ALL SELECT 6, 'Saturday', 1, 8.00
      ) v
     WHERE NOT EXISTS (SELECT 1 FROM cfg_working_calendar w WHERE w.company_id = c.id);

    -- 3. T&A activity library, only for companies that have none (never re-adds activities a company removed).
    INSERT IGNORE INTO mst_tna_activity
      (company_id, activity_code, activity_name, category, default_duration, lead_time_type, department_name, default_owner_role, mandatory, weight, alert_before_days)
    SELECT c.id, v.activity_code, v.activity_name, v.category, v.default_duration, v.lead_time_type, v.department_name, v.default_owner_role, v.mandatory, v.weight, v.alert_before_days
      FROM mst_company c
      CROSS JOIN (
              SELECT 'ACT_PO_REC' AS activity_code, 'PO Received & Confirmation' AS activity_name, 'ORDER' AS category, 2 AS default_duration, 'FORWARD' AS lead_time_type, 'Merchandising' AS department_name, 'Merchandiser' AS default_owner_role, 1 AS mandatory, 1.0 AS weight, 2 AS alert_before_days
    UNION ALL SELECT 'ACT_TECH_PACK', 'Tech Pack & Spec Received', 'ORDER', 3, 'FORWARD', 'Merchandising', 'Merchandiser', 1, 1.0, 2
    UNION ALL SELECT 'ACT_BOM_COST', 'BOM & Pre-Costing Approval', 'ORDER', 3, 'FORWARD', 'Merchandising', 'Costing Executive', 1, 1.5, 2
    UNION ALL SELECT 'ACT_PROTO_SMP', 'Proto Sample Submission & Approval', 'SAMPLING', 5, 'FORWARD', 'Sampling', 'Sample Coordinator', 1, 2.0, 3
    UNION ALL SELECT 'ACT_FIT_SMP', 'Fit Sample Submission & Approval', 'SAMPLING', 6, 'FORWARD', 'Sampling', 'Sample Coordinator', 1, 2.0, 3
    UNION ALL SELECT 'ACT_PP_SMP', 'Pre-Production (PP) Sample Approval', 'SAMPLING', 5, 'FORWARD', 'Sampling', 'QA Manager', 1, 2.5, 3
    UNION ALL SELECT 'ACT_YARN_BOOK', 'Yarn Requirement & PO Booking', 'FABRIC', 4, 'FORWARD', 'Purchase', 'Purchase Manager', 1, 2.0, 2
    UNION ALL SELECT 'ACT_KNIT_FAB', 'Knitting & Greige Fabric Production', 'FABRIC', 7, 'FORWARD', 'Knitting', 'Knitting In-charge', 1, 2.5, 2
    UNION ALL SELECT 'ACT_DYE_FIN', 'Fabric Dyeing, Compacting & Finishing', 'FABRIC', 8, 'FORWARD', 'Dyeing', 'Processing Manager', 1, 3.0, 3
    UNION ALL SELECT 'ACT_FAB_INHOUSE', 'Fabric In-House & Quality Inspection', 'FABRIC', 3, 'BACKWARD', 'Stores', 'Store In-charge', 1, 3.5, 2
    UNION ALL SELECT 'ACT_TRIM_BOOK', 'Trims Requirement & PO Booking', 'TRIM', 5, 'FORWARD', 'Purchase', 'Purchase Executive', 1, 1.5, 2
    UNION ALL SELECT 'ACT_TRIM_INHOUSE', 'Trims In-House & Inspection', 'TRIM', 3, 'BACKWARD', 'Stores', 'Store In-charge', 1, 2.0, 2
    UNION ALL SELECT 'ACT_SIZE_SET', 'Size Set / Pilot Run Approval', 'PRODUCTION', 2, 'BACKWARD', 'QA', 'QA Executive', 1, 2.0, 2
    UNION ALL SELECT 'ACT_CUTTING', 'Spreading, Marker & Cutting', 'PRODUCTION', 5, 'BACKWARD', 'Cutting', 'Cutting Manager', 1, 3.0, 2
    UNION ALL SELECT 'ACT_PRINT_EMB', 'Printing / Embroidery Embellishment', 'PRODUCTION', 4, 'BACKWARD', 'Printing', 'Printing In-charge', 0, 2.0, 2
    UNION ALL SELECT 'ACT_SEWING', 'Sewing & Assembly Production', 'PRODUCTION', 12, 'BACKWARD', 'Sewing', 'Sewing Floor Manager', 1, 5.0, 3
    UNION ALL SELECT 'ACT_WASHING', 'Garment Washing & Drying', 'PRODUCTION', 3, 'BACKWARD', 'Washing', 'Washing In-charge', 0, 1.5, 2
    UNION ALL SELECT 'ACT_FINISHING', 'Thread Trimming, Ironing & Checking', 'PRODUCTION', 5, 'BACKWARD', 'Finishing', 'Finishing Manager', 1, 2.5, 2
    UNION ALL SELECT 'ACT_PACKING', 'Packing, Tagging & Carton Box Packing', 'PRODUCTION', 4, 'BACKWARD', 'Packing', 'Packing Supervisor', 1, 2.5, 2
    UNION ALL SELECT 'ACT_FINAL_QC', 'Final Buyer/AQL Quality Inspection', 'QUALITY', 2, 'BACKWARD', 'QA', 'QA Manager', 1, 4.0, 2
    UNION ALL SELECT 'ACT_DOC_BOOK', 'Shipping Booking & Export Documents', 'SHIPMENT', 3, 'BACKWARD', 'Commercial', 'Shipping Executive', 1, 2.0, 2
    UNION ALL SELECT 'ACT_SHIPMENT', 'Container Stuffing & Final Shipment', 'SHIPMENT', 1, 'BACKWARD', 'Commercial', 'Logistics Manager', 1, 5.0, 1
      ) v
     WHERE NOT EXISTS (SELECT 1 FROM mst_tna_activity a WHERE a.company_id = c.id);

    -- 4. The five T&A templates, only for companies that have no templates at all.
    CREATE TEMPORARY TABLE IF NOT EXISTS tmp128_new_tpl_co (company_id BIGINT UNSIGNED PRIMARY KEY);
    DELETE FROM tmp128_new_tpl_co;
    INSERT INTO tmp128_new_tpl_co (company_id)
    SELECT c.id FROM mst_company c WHERE NOT EXISTS (SELECT 1 FROM mst_tna_template_header h WHERE h.company_id = c.id);

    INSERT IGNORE INTO mst_tna_template_header (company_id, template_code, template_name, product_type, description, active)
    SELECT t.company_id, v.template_code, v.template_name, v.product_type, v.description, v.active
      FROM tmp128_new_tpl_co t
      CROSS JOIN (
              SELECT 'TPL_BASIC_TSHIRT' AS template_code, 'Basic Knit T-Shirt Standard' AS template_name, 'T-Shirt' AS product_type, 'Standard knit crew neck / round neck T-Shirt Time & Action template with 55-day order-to-ship cycle' AS description, 1 AS active
    UNION ALL SELECT 'TPL_POLO', 'Polo Garment (Collar & Cuff)', 'Polo', 'Polo shirt T&A template including flat knit collar/cuff procurement and placket preparation', 1
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'Woven Casual/Formal Shirt', 'Shirt', 'Woven Shirt T&A workflow with fabric weaving/sourcing, fusing, cuff/collar and button attach', 1
    UNION ALL SELECT 'TPL_BOTTOMS', 'Casual Pants / Chinos / Joggers', 'Bottoms', 'Bottom wear with zipper, waistband fusing, wash cycle and bar-tack operations', 1
    UNION ALL SELECT 'TPL_FLEECE', 'Fleece Hoodie & Sweatshirt', 'Fleece', 'Heavyweight fleece garment with brushed back fabric, hood lining, eyelets and drawcord', 1
      ) v;

    INSERT IGNORE INTO mst_tna_template_activity
      (template_id, activity_code, activity_name, category, sequence_no, default_duration, duration_uom, department_name, default_owner_role, dependency_sequence, mandatory, weight, alert_before_days)
    SELECT h.id, v.activity_code, v.activity_name, v.category, v.sequence_no, v.default_duration, v.duration_uom, v.department_name, v.default_owner_role, v.dependency_sequence, v.mandatory, v.weight, v.alert_before_days
      FROM tmp128_new_tpl_co t
      JOIN mst_tna_template_header h ON h.company_id = t.company_id
      JOIN (
              SELECT 'TPL_BASIC_TSHIRT' AS template_code, 'ACT_PO_REC' AS activity_code, 'PO Received & Confirmation' AS activity_name, 'ORDER' AS category, 1 AS sequence_no, 2 AS default_duration, 'DAYS' AS duration_uom, 'Merchandising' AS department_name, 'Merchandiser' AS default_owner_role, NULL AS dependency_sequence, 1 AS mandatory, 1.0 AS weight, 2 AS alert_before_days
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_TECH_PACK', 'Tech Pack & Spec Finalized', 'ORDER', 2, 2, 'DAYS', 'Merchandising', 'Merchandiser', 1, 1, 1.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_BOM_COST', 'BOM & Costing Approval', 'ORDER', 3, 2, 'DAYS', 'Merchandising', 'Costing Executive', 2, 1, 1.5, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_PROTO_SMP', 'Proto Sample Approval', 'SAMPLING', 4, 4, 'DAYS', 'Sampling', 'Sample Coordinator', 2, 1, 2.0, 3
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_FIT_SMP', 'Fit Sample Approval', 'SAMPLING', 5, 5, 'DAYS', 'Sampling', 'Sample Coordinator', 4, 1, 2.0, 3
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_PP_SMP', 'PP Sample Approval', 'SAMPLING', 6, 4, 'DAYS', 'Sampling', 'QA Manager', 5, 1, 2.5, 3
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_YARN_BOOK', 'Yarn Requirement & PO', 'FABRIC', 7, 3, 'DAYS', 'Purchase', 'Purchase Manager', 3, 1, 2.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_KNIT_FAB', 'Knitting Production', 'FABRIC', 8, 6, 'DAYS', 'Knitting', 'Knitting In-charge', 7, 1, 2.5, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_DYE_FIN', 'Dyeing & Finishing', 'FABRIC', 9, 7, 'DAYS', 'Dyeing', 'Processing Manager', 8, 1, 3.0, 3
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_FAB_INHOUSE', 'Fabric In-House & QC', 'FABRIC', 10, 2, 'DAYS', 'Stores', 'Store In-charge', 9, 1, 3.5, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_TRIM_BOOK', 'Trim PO Booking', 'TRIM', 11, 4, 'DAYS', 'Purchase', 'Purchase Executive', 3, 1, 1.5, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_TRIM_INHOUSE', 'Trim In-House & QC', 'TRIM', 12, 2, 'DAYS', 'Stores', 'Store In-charge', 11, 1, 2.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_SIZE_SET', 'Size Set Cutting & QC', 'PRODUCTION', 13, 2, 'DAYS', 'QA', 'QA Executive', 6, 1, 2.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_CUTTING', 'Bulk Spreading & Cutting', 'PRODUCTION', 14, 4, 'DAYS', 'Cutting', 'Cutting Manager', 10, 1, 3.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_PRINT_EMB', 'Chest Print / Embroidery', 'PRODUCTION', 15, 3, 'DAYS', 'Printing', 'Printing In-charge', 14, 0, 2.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_SEWING', 'Sewing Assembly Lines', 'PRODUCTION', 16, 10, 'DAYS', 'Sewing', 'Sewing Floor Manager', 15, 1, 5.0, 3
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_FINISHING', 'Ironing & Inspection', 'PRODUCTION', 17, 4, 'DAYS', 'Finishing', 'Finishing Manager', 16, 1, 2.5, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_PACKING', 'Tagging & Carton Packing', 'PRODUCTION', 18, 3, 'DAYS', 'Packing', 'Packing Supervisor', 17, 1, 2.5, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_FINAL_QC', 'Final Buyer Inspection (AQL 2.5)', 'QUALITY', 19, 2, 'DAYS', 'QA', 'QA Manager', 18, 1, 4.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_DOC_BOOK', 'Shipping Documentation & Booking', 'SHIPMENT', 20, 2, 'DAYS', 'Commercial', 'Shipping Executive', 19, 1, 2.0, 2
    UNION ALL SELECT 'TPL_BASIC_TSHIRT', 'ACT_SHIPMENT', 'Container Stuffing & On-Board Dispatch', 'SHIPMENT', 21, 1, 'DAYS', 'Commercial', 'Logistics Manager', 20, 1, 5.0, 1
    UNION ALL SELECT 'TPL_POLO', 'ACT_PO_REC', 'PO Received & Order Confirmation', 'ORDER', 1, 2, 'DAYS', 'Merchandising', 'Merchandiser', NULL, 1, 1.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_TECH_PACK', 'Tech Pack & Artwork Approved', 'ORDER', 2, 2, 'DAYS', 'Merchandising', 'Merchandiser', 1, 1, 1.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_BOM_COST', 'BOM & Costing Approval', 'ORDER', 3, 2, 'DAYS', 'Merchandising', 'Costing Executive', 2, 1, 1.5, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_PROTO_SMP', 'Proto Sample Approval', 'SAMPLING', 4, 4, 'DAYS', 'Sampling', 'Sample Coordinator', 2, 1, 2.0, 3
    UNION ALL SELECT 'TPL_POLO', 'ACT_FIT_SMP', 'Fit Sample Approval', 'SAMPLING', 5, 5, 'DAYS', 'Sampling', 'Sample Coordinator', 4, 1, 2.0, 3
    UNION ALL SELECT 'TPL_POLO', 'ACT_PP_SMP', 'PP Sample Approval', 'SAMPLING', 6, 4, 'DAYS', 'Sampling', 'QA Manager', 5, 1, 2.5, 3
    UNION ALL SELECT 'TPL_POLO', 'ACT_YARN_BOOK', 'Yarn PO & Booking', 'FABRIC', 7, 4, 'DAYS', 'Purchase', 'Purchase Manager', 3, 1, 2.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_KNIT_FAB', 'Knitting (Body + Collar/Cuffs)', 'FABRIC', 8, 8, 'DAYS', 'Knitting', 'Knitting In-charge', 7, 1, 3.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_DYE_FIN', 'Dyeing & Heat-setting', 'FABRIC', 9, 8, 'DAYS', 'Dyeing', 'Processing Manager', 8, 1, 3.0, 3
    UNION ALL SELECT 'TPL_POLO', 'ACT_FAB_INHOUSE', 'Fabric & Collar In-House', 'FABRIC', 10, 2, 'DAYS', 'Stores', 'Store In-charge', 9, 1, 3.5, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_TRIM_BOOK', 'Trims & Buttons PO', 'TRIM', 11, 4, 'DAYS', 'Purchase', 'Purchase Executive', 3, 1, 1.5, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_TRIM_INHOUSE', 'Buttons & Labels In-House', 'TRIM', 12, 2, 'DAYS', 'Stores', 'Store In-charge', 11, 1, 2.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_CUTTING', 'Cutting Body & Placket Panels', 'PRODUCTION', 13, 5, 'DAYS', 'Cutting', 'Cutting Manager', 10, 1, 3.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_PRINT_EMB', 'Chest Embroidery Logo', 'PRODUCTION', 14, 4, 'DAYS', 'Printing', 'Printing In-charge', 13, 1, 2.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_SEWING', 'Sewing (Placket, Collar, Hem)', 'PRODUCTION', 15, 12, 'DAYS', 'Sewing', 'Sewing Floor Manager', 14, 1, 5.0, 3
    UNION ALL SELECT 'TPL_POLO', 'ACT_FINISHING', 'Button Hole, Ironing & Inspection', 'PRODUCTION', 16, 4, 'DAYS', 'Finishing', 'Finishing Manager', 15, 1, 2.5, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_PACKING', 'Collar Support, Polybag & Packing', 'PRODUCTION', 17, 3, 'DAYS', 'Packing', 'Packing Supervisor', 16, 1, 2.5, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_FINAL_QC', 'Final Inspection Passed', 'QUALITY', 18, 2, 'DAYS', 'QA', 'QA Manager', 17, 1, 4.0, 2
    UNION ALL SELECT 'TPL_POLO', 'ACT_SHIPMENT', 'Container Stuffing & Shipment', 'SHIPMENT', 19, 2, 'DAYS', 'Commercial', 'Logistics Manager', 18, 1, 5.0, 1
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_TECH_PACK', 'Tech Pack Freeze', 'MERCHANDISING', 1, 2, 'DAYS', 'Merchandising', 'Merchant', NULL, 1, 1.0, 1
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_PROTO_SAMPLE', 'Proto Sample Approved', 'SAMPLING', 2, 5, 'DAYS', 'Sampling', 'Sample Master', 1, 1, 2.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_FIT_SAMPLE', 'Fit Sample Approved', 'SAMPLING', 3, 7, 'DAYS', 'Sampling', 'Sample Master', 2, 1, 3.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_PP_SAMPLE', 'Pre-Production Sample Approved', 'SAMPLING', 4, 6, 'DAYS', 'Sampling', 'Merchant', 3, 1, 4.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_FABRIC_WOVEN', 'Woven Fabric Inward (Shell & Contrast)', 'FABRIC', 5, 20, 'DAYS', 'Procurement', 'Purchase Manager', 4, 1, 6.0, 4
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_FUSING_INWARD', 'Interlining & Fusing Inward', 'TRIMS', 6, 8, 'DAYS', 'Procurement', 'Purchase Officer', 4, 1, 3.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_TRIMS_INWARD', 'Buttons, Labels & Thread Inward', 'TRIMS', 7, 10, 'DAYS', 'Procurement', 'Purchase Officer', 4, 1, 3.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_PPM', 'Pre-Production Meeting (PPM)', 'PRODUCTION', 8, 1, 'DAYS', 'QA / Production', 'Factory Manager', 7, 1, 2.0, 1
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_FABRIC_INSPECT', '4-Point Fabric Inspection', 'QUALITY', 9, 2, 'DAYS', 'Fabric QC', 'QA Officer', 5, 1, 2.0, 1
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_CUTTING', 'Spreading & Precision Cutting', 'PRODUCTION', 10, 4, 'DAYS', 'Cutting', 'Cutting Master', 9, 1, 4.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_COLLAR_FUSING', 'Collar & Cuff Fusing Process', 'PRODUCTION', 11, 3, 'DAYS', 'Cutting', 'Cutting Supervisor', 10, 1, 2.5, 1
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_SEWING', 'Sewing Assembly (Collar, Front, Sleeves)', 'PRODUCTION', 12, 14, 'DAYS', 'Sewing', 'Floor In-Charge', 11, 1, 6.0, 3
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_BUTTON_ATTACH', 'Button Hole & Button Attach', 'PRODUCTION', 13, 3, 'DAYS', 'Finishing', 'Finishing Supervisor', 12, 1, 3.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_PRESSING', 'Steam Pressing & Thread Trimming', 'PRODUCTION', 14, 3, 'DAYS', 'Finishing', 'Finishing Manager', 13, 1, 2.5, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_FINAL_QC', 'Final QA Audit (AQL 2.5)', 'QUALITY', 15, 2, 'DAYS', 'QA', 'QA Manager', 14, 1, 4.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_PACKING', 'Pinning, Cardboard & Polybag Packing', 'PRODUCTION', 16, 3, 'DAYS', 'Packing', 'Packing In-Charge', 15, 1, 3.0, 2
    UNION ALL SELECT 'TPL_WOVEN_SHIRT', 'ACT_SHIPMENT', 'Container Handover & Dispatch', 'SHIPMENT', 17, 2, 'DAYS', 'Commercial', 'Logistics Manager', 16, 1, 5.0, 1
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_TECH_PACK', 'Tech Pack Freeze', 'MERCHANDISING', 1, 2, 'DAYS', 'Merchandising', 'Merchant', NULL, 1, 1.0, 1
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_FIT_SAMPLE', 'Fit Sample Approved', 'SAMPLING', 2, 7, 'DAYS', 'Sampling', 'Sample Master', 1, 1, 3.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_PP_SAMPLE', 'Pre-Production Sample Approved', 'SAMPLING', 3, 6, 'DAYS', 'Sampling', 'Merchant', 2, 1, 4.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_FABRIC_INWARD', 'Twill/Denim Fabric Inward', 'FABRIC', 4, 18, 'DAYS', 'Procurement', 'Purchase Manager', 3, 1, 6.0, 4
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_TRIMS_ZIPPER', 'Zippers, Rivets & Pocketing Inward', 'TRIMS', 5, 12, 'DAYS', 'Procurement', 'Purchase Officer', 3, 1, 3.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_PPM', 'Pre-Production Meeting (PPM)', 'PRODUCTION', 6, 1, 'DAYS', 'QA / Production', 'Factory Manager', 5, 1, 2.0, 1
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_CUTTING', 'Spreading & Bulk Cutting', 'PRODUCTION', 7, 4, 'DAYS', 'Cutting', 'Cutting Master', 6, 1, 4.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_SEWING', 'Sewing (Pockets, Fly, Inseam, Waistband)', 'PRODUCTION', 8, 14, 'DAYS', 'Sewing', 'Floor In-Charge', 7, 1, 6.0, 3
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_WASHING', 'Garment Wash / Enzyme Wash', 'PRODUCTION', 9, 5, 'DAYS', 'Washing', 'Washing Master', 8, 1, 4.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_RIVET_BUTTON', 'Rivet & Metal Button Attachment', 'PRODUCTION', 10, 2, 'DAYS', 'Finishing', 'Finishing Supervisor', 9, 1, 2.5, 1
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_PRESSING', 'Pressing & Dimension Check', 'PRODUCTION', 11, 3, 'DAYS', 'Finishing', 'Finishing Manager', 10, 1, 2.5, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_FINAL_QC', 'Final QA Audit Passed', 'QUALITY', 12, 2, 'DAYS', 'QA', 'QA Manager', 11, 1, 4.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_PACKING', 'Folding, Tagging & Carton Packing', 'PRODUCTION', 13, 3, 'DAYS', 'Packing', 'Packing In-Charge', 12, 1, 3.0, 2
    UNION ALL SELECT 'TPL_BOTTOMS', 'ACT_SHIPMENT', 'Container Loading & Dispatch', 'SHIPMENT', 14, 2, 'DAYS', 'Commercial', 'Logistics Manager', 13, 1, 5.0, 1
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_TECH_PACK', 'Tech Pack Freeze', 'MERCHANDISING', 1, 2, 'DAYS', 'Merchandising', 'Merchant', NULL, 1, 1.0, 1
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_PP_SAMPLE', 'Pre-Production Sample Approved', 'SAMPLING', 2, 7, 'DAYS', 'Sampling', 'Merchant', 1, 1, 4.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_YARN_INWARD', 'Yarn Inward & Inspection', 'MATERIAL', 3, 12, 'DAYS', 'Procurement', 'Purchase Officer', 2, 1, 4.0, 3
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_KNITTING_FLEECE', '3-Thread Fleece Knitting', 'PRODUCTION', 4, 10, 'DAYS', 'Knitting', 'Knitting Manager', 3, 1, 5.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_DYEING_BRUSHING', 'Dyeing & Napping / Brushing Process', 'PRODUCTION', 5, 8, 'DAYS', 'Dyeing', 'Dyeing Manager', 4, 1, 5.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_RIB_DRAWCORD', 'Rib, Eyelets & Drawcord Inward', 'TRIMS', 6, 8, 'DAYS', 'Procurement', 'Purchase Officer', 2, 1, 3.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_PPM', 'Pre-Production Meeting (PPM)', 'PRODUCTION', 7, 1, 'DAYS', 'QA / Production', 'Factory Manager', 6, 1, 2.0, 1
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_CUTTING', 'Cutting Fleece, Hood & Pocket Panels', 'PRODUCTION', 8, 4, 'DAYS', 'Cutting', 'Cutting Master', 7, 1, 4.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_HOOD_ASSEMBLY', 'Pocket & Hood Assembly with Eyelets', 'PRODUCTION', 9, 4, 'DAYS', 'Sewing', 'Floor In-Charge', 8, 1, 3.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_SEWING', 'Garment Body & Rib Assembly', 'PRODUCTION', 10, 12, 'DAYS', 'Sewing', 'Floor In-Charge', 9, 1, 6.0, 3
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_FINISHING', 'Drawcord Threading, Steam Pressing & QC', 'PRODUCTION', 11, 4, 'DAYS', 'Finishing', 'Finishing Manager', 10, 1, 3.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_FINAL_QC', 'Final Inspection Passed', 'QUALITY', 12, 2, 'DAYS', 'QA', 'QA Manager', 11, 1, 4.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_PACKING', 'Flat Pack / Hanger Pack & Box Packing', 'PRODUCTION', 13, 3, 'DAYS', 'Packing', 'Packing In-Charge', 12, 1, 3.0, 2
    UNION ALL SELECT 'TPL_FLEECE', 'ACT_SHIPMENT', 'Dispatch & Port Clearance', 'SHIPMENT', 14, 2, 'DAYS', 'Commercial', 'Logistics Manager', 13, 1, 5.0, 1
      ) v ON v.template_code = h.template_code;

    DROP TEMPORARY TABLE IF EXISTS tmp128_new_tpl_co;
  END IF;
END;

CALL mig128_tna_defaults();
DROP PROCEDURE IF EXISTS mig128_tna_defaults;
