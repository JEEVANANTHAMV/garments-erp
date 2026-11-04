-- =====================================================================
-- 150 · Transport management inside Gate Security (client voice notes 04-Nov-2026 +
--       "C-ONE ERP Transport Management Developer Implementation Specification" v1.0, Phase 1)
--   "For our own vehicles — pickup, drop, courier collection — anyone raises a request, the Vehicle Manager
--    sees it and allocates a vehicle."  + visitor photo and visitor / vehicle reports.
--
--   cfg_transport_request_type        configurable request types (§2.1): which of pickup / destination /
--                                     material details / proof are mandatory
--   mst_transport_vehicle             one master for OWNED and RENTAL vehicles (§4.3)
--   mst_transport_driver              staff driver profile linked to a login user (§4.4) — the ERP has no
--                                     separate employee master; mst_user is the staff identity
--   trx_transport_request             staff vehicle request (§4.1) with its own status (§5)
--   trx_transport_request_attachment  request attachments (metadata; file under /uploads)
--   trx_transport_trip                trip / program: one driver + one vehicle (§4.5)
--   trx_transport_trip_request        requests on a trip; ONE active trip per request (unique generated col)
--   trx_transport_trip_stop           ordered stops of a trip
--   trx_transport_stop_request        which request is picked up / delivered at a stop, and the result
--   trx_transport_status_log          request / trip / stop status timeline (§7: three logs in one table)
--   trx_transport_proof               delivery / pickup proof (photo / signature) metadata
--   trx_transport_trip_issue          driver-reported issues (delay, breakdown …)
--   trx_transport_idempotency         driver action idempotency keys (safe mobile retries, §4.6)
--   trx_notification                  + event_key (one notification per recipient + event) and action_url
--   trx_gate_visitor                  + photo_url (visitor photo) and host_department_id (visitor report)
-- Idempotent: the runner re-applies files >= 10 on every deploy. Non-destructive.
-- =====================================================================

CREATE TABLE IF NOT EXISTS cfg_transport_request_type (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id             BIGINT UNSIGNED NOT NULL,
  type_code              VARCHAR(30) NOT NULL,
  type_name              VARCHAR(80) NOT NULL,
  requires_pickup        TINYINT(1) NOT NULL DEFAULT 1,
  requires_destination   TINYINT(1) NOT NULL DEFAULT 1,
  requires_material      TINYINT(1) NOT NULL DEFAULT 0,
  requires_proof         TINYINT(1) NOT NULL DEFAULT 0,
  sort_order             INT NOT NULL DEFAULT 0,
  is_active              TINYINT(1) NOT NULL DEFAULT 1,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by             BIGINT UNSIGNED NULL,
  updated_at             DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trt_code (company_id, type_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Transport request types (configurable mandatory fields)';

CREATE TABLE IF NOT EXISTS mst_transport_vehicle (
  id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id               BIGINT UNSIGNED NOT NULL,
  vehicle_code             VARCHAR(30) NOT NULL,
  registration_no          VARCHAR(20) NOT NULL COMMENT 'Upper-case, no spaces',
  ownership_type           ENUM('OWNED','RENTAL') NOT NULL DEFAULT 'OWNED',
  vehicle_type             VARCHAR(30) NOT NULL DEFAULT 'CAR' COMMENT 'CAR / VAN / PICKUP / MINI_TRUCK / TWO_WHEELER / OTHER',
  make                     VARCHAR(60) NULL,
  model                    VARCHAR(60) NULL,
  capacity                 DECIMAL(12,2) NULL,
  capacity_uom             VARCHAR(20) NULL,
  seating                  INT NULL,
  rental_party_id          BIGINT UNSIGNED NULL COMMENT 'Transporter party (optional) for RENTAL',
  rental_provider_name     VARCHAR(160) NULL,
  rental_provider_contact  VARCHAR(60) NULL,
  rental_rate              DECIMAL(12,2) NULL,
  rental_rate_basis        VARCHAR(20) NULL COMMENT 'TRIP / DAY / KM / MONTH',
  availability_status      ENUM('AVAILABLE','MAINTENANCE','INACTIVE') NOT NULL DEFAULT 'AVAILABLE' COMMENT 'ASSIGNED / IN_TRIP are derived from active trips',
  insurance_expiry         DATE NULL,
  permit_expiry            DATE NULL,
  fitness_expiry           DATE NULL,
  pollution_expiry         DATE NULL,
  remarks                  VARCHAR(500) NULL,
  is_active                TINYINT(1) NOT NULL DEFAULT 1,
  row_version              INT NOT NULL DEFAULT 1,
  created_by               BIGINT UNSIGNED NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by               BIGINT UNSIGNED NULL,
  updated_at               DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tv_reg (company_id, registration_no),
  UNIQUE KEY uq_tv_code (company_id, vehicle_code),
  KEY ix_tv_status (company_id, is_active, availability_status),
  CONSTRAINT ck_tv_capacity CHECK (capacity IS NULL OR capacity >= 0),
  CONSTRAINT ck_tv_rate CHECK (rental_rate IS NULL OR rental_rate >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Vehicle master (owned + rental)';

CREATE TABLE IF NOT EXISTS mst_transport_driver (
  id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id                BIGINT UNSIGNED NOT NULL,
  user_id                   BIGINT UNSIGNED NOT NULL COMMENT 'Staff login (mst_user) — the driver signs in to the driver screen',
  licence_no                VARCHAR(30) NOT NULL,
  licence_class             VARCHAR(40) NULL COMMENT 'LMV / HMV / MCWG …',
  licence_expiry            DATE NOT NULL,
  mobile_no                 VARCHAR(20) NOT NULL,
  emergency_contact_name    VARCHAR(80) NULL,
  emergency_contact_mobile  VARCHAR(20) NULL,
  availability_status       ENUM('AVAILABLE','ON_LEAVE','INACTIVE') NOT NULL DEFAULT 'AVAILABLE' COMMENT 'ASSIGNED / ON_TRIP are derived from active trips',
  remarks                   VARCHAR(500) NULL,
  is_active                 TINYINT(1) NOT NULL DEFAULT 1,
  row_version               INT NOT NULL DEFAULT 1,
  created_by                BIGINT UNSIGNED NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by                BIGINT UNSIGNED NULL,
  updated_at                DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_td_user (company_id, user_id),
  KEY ix_td_status (company_id, is_active, availability_status),
  CONSTRAINT fk_td_user FOREIGN KEY (user_id) REFERENCES mst_user (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Staff driver profiles';

CREATE TABLE IF NOT EXISTS trx_transport_request (
  id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id               BIGINT UNSIGNED NOT NULL,
  request_no               VARCHAR(30) NOT NULL,
  requested_by             BIGINT UNSIGNED NOT NULL COMMENT 'Authenticated user — never client supplied',
  department_id            BIGINT UNSIGNED NULL,
  request_type_id          BIGINT UNSIGNED NOT NULL,
  purpose                  VARCHAR(255) NOT NULL,
  priority                 ENUM('NORMAL','URGENT','CRITICAL') NOT NULL DEFAULT 'NORMAL',
  priority_reason          VARCHAR(255) NULL,
  status                   ENUM('DRAFT','SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED','APPROVED','REJECTED','ASSIGNED',
                                'IN_PROGRESS','PICKUP_COMPLETED','DELIVERED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  required_at              DATETIME NOT NULL COMMENT 'UTC',
  pickup_unit_id           BIGINT UNSIGNED NULL,
  pickup_party_id          BIGINT UNSIGNED NULL,
  pickup_location          VARCHAR(160) NULL,
  pickup_address           VARCHAR(500) NULL,
  destination_unit_id      BIGINT UNSIGNED NULL,
  destination_party_id     BIGINT UNSIGNED NULL,
  destination_location     VARCHAR(160) NULL,
  destination_address      VARCHAR(500) NULL,
  contact_name             VARCHAR(80) NOT NULL,
  contact_mobile           VARCHAR(20) NOT NULL,
  material_description     VARCHAR(500) NULL,
  package_qty              DECIMAL(12,2) NULL,
  package_uom              VARCHAR(20) NULL,
  passenger_count          INT NULL,
  remarks                  VARCHAR(1000) NULL,
  submitted_at             DATETIME NULL,
  reviewed_by              BIGINT UNSIGNED NULL,
  reviewed_at              DATETIME NULL,
  approved_by              BIGINT UNSIGNED NULL,
  approved_at              DATETIME NULL,
  approval_remarks         VARCHAR(500) NULL,
  rejected_by              BIGINT UNSIGNED NULL,
  rejected_at              DATETIME NULL,
  rejection_reason         VARCHAR(500) NULL,
  clarification_question   VARCHAR(500) NULL,
  clarification_by         BIGINT UNSIGNED NULL,
  clarification_at         DATETIME NULL,
  clarification_response   VARCHAR(500) NULL,
  cancelled_by             BIGINT UNSIGNED NULL,
  cancelled_at             DATETIME NULL,
  cancel_reason            VARCHAR(500) NULL,
  current_trip_id          BIGINT UNSIGNED NULL,
  completed_at             DATETIME NULL,
  row_version              INT NOT NULL DEFAULT 1,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by               BIGINT UNSIGNED NULL,
  updated_at               DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tr_no (company_id, request_no),
  KEY ix_tr_status_req (company_id, status, required_at),
  KEY ix_tr_requester (company_id, requested_by, created_at),
  KEY ix_tr_dept (company_id, department_id, status),
  KEY ix_tr_type (request_type_id),
  KEY ix_tr_trip (current_trip_id),
  CONSTRAINT fk_tr_type FOREIGN KEY (request_type_id) REFERENCES cfg_transport_request_type (id),
  CONSTRAINT fk_tr_user FOREIGN KEY (requested_by) REFERENCES mst_user (id),
  CONSTRAINT ck_tr_qty CHECK (package_qty IS NULL OR package_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Staff vehicle requests';

CREATE TABLE IF NOT EXISTS trx_transport_request_attachment (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id    BIGINT UNSIGNED NOT NULL,
  request_id    BIGINT UNSIGNED NOT NULL,
  file_name     VARCHAR(200) NOT NULL,
  file_url      VARCHAR(300) NOT NULL,
  mime_type     VARCHAR(80) NULL,
  file_size     INT NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  uploaded_by   BIGINT UNSIGNED NULL,
  uploaded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_tra_req (request_id),
  CONSTRAINT fk_tra_req FOREIGN KEY (request_id) REFERENCES trx_transport_request (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Transport request attachments';

CREATE TABLE IF NOT EXISTS trx_transport_trip (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id              BIGINT UNSIGNED NOT NULL,
  trip_no                 VARCHAR(30) NOT NULL,
  status                  ENUM('DRAFT','ASSIGNED','DRIVER_ACCEPTED','STARTED','IN_PROGRESS','COMPLETED','CANCELLED','EXCEPTION') NOT NULL DEFAULT 'DRAFT',
  planned_start_at        DATETIME NOT NULL,
  planned_end_at          DATETIME NOT NULL,
  origin                  VARCHAR(160) NULL,
  destination             VARCHAR(160) NULL,
  purpose                 VARCHAR(255) NULL,
  vehicle_id              BIGINT UNSIGNED NULL,
  driver_id               BIGINT UNSIGNED NULL,
  assigned_by             BIGINT UNSIGNED NULL,
  assigned_at             DATETIME NULL,
  accepted_at             DATETIME NULL,
  driver_rejected_at      DATETIME NULL,
  driver_reject_reason    VARCHAR(500) NULL,
  started_at              DATETIME NULL,
  completed_at            DATETIME NULL,
  start_odometer          DECIMAL(12,1) NULL,
  end_odometer            DECIMAL(12,1) NULL,
  exception_closed        TINYINT(1) NOT NULL DEFAULT 0,
  exception_reason        VARCHAR(500) NULL,
  cancelled_by            BIGINT UNSIGNED NULL,
  cancelled_at            DATETIME NULL,
  cancellation_reason     VARCHAR(500) NULL,
  remarks                 VARCHAR(1000) NULL,
  row_version             INT NOT NULL DEFAULT 1,
  created_by              BIGINT UNSIGNED NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by              BIGINT UNSIGNED NULL,
  updated_at              DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tt_no (company_id, trip_no),
  KEY ix_tt_driver (company_id, driver_id, planned_start_at),
  KEY ix_tt_vehicle (company_id, vehicle_id, planned_start_at),
  KEY ix_tt_status (company_id, status, planned_start_at),
  CONSTRAINT fk_tt_vehicle FOREIGN KEY (vehicle_id) REFERENCES mst_transport_vehicle (id),
  CONSTRAINT fk_tt_driver FOREIGN KEY (driver_id) REFERENCES mst_transport_driver (id),
  CONSTRAINT ck_tt_odo CHECK ((start_odometer IS NULL OR start_odometer >= 0) AND (end_odometer IS NULL OR end_odometer >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Trips / programs (one driver + one vehicle)';

CREATE TABLE IF NOT EXISTS trx_transport_trip_request (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id          BIGINT UNSIGNED NOT NULL,
  trip_id             BIGINT UNSIGNED NOT NULL,
  request_id          BIGINT UNSIGNED NOT NULL,
  sequence_no         INT NOT NULL DEFAULT 1,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  active_request_id   BIGINT UNSIGNED AS (IF(is_active = 1, request_id, NULL)) STORED,
  linked_by           BIGINT UNSIGNED NULL,
  linked_at           DATETIME NULL,
  unlinked_by         BIGINT UNSIGNED NULL,
  unlinked_at         DATETIME NULL,
  unlink_reason       VARCHAR(500) NULL,
  UNIQUE KEY uq_ttr_one_active (active_request_id),
  KEY ix_ttr_trip (trip_id),
  KEY ix_ttr_req (request_id),
  CONSTRAINT fk_ttr_trip FOREIGN KEY (trip_id) REFERENCES trx_transport_trip (id),
  CONSTRAINT fk_ttr_req FOREIGN KEY (request_id) REFERENCES trx_transport_request (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Requests on a trip (one active trip per request)';

CREATE TABLE IF NOT EXISTS trx_transport_trip_stop (
  id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id             BIGINT UNSIGNED NOT NULL,
  trip_id                BIGINT UNSIGNED NOT NULL,
  stop_no                INT NOT NULL,
  stop_type              ENUM('PICKUP','DELIVERY','PICKUP_DELIVERY','OTHER') NOT NULL DEFAULT 'PICKUP',
  location_name          VARCHAR(160) NOT NULL,
  address                VARCHAR(500) NULL,
  expected_arrival_at    DATETIME NULL,
  actual_arrival_at      DATETIME NULL,
  actual_departure_at    DATETIME NULL,
  contact_name           VARCHAR(80) NULL,
  contact_mobile         VARCHAR(20) NULL,
  is_mandatory           TINYINT(1) NOT NULL DEFAULT 1,
  status                 ENUM('PENDING','EN_ROUTE','ARRIVED','SERVICED','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  is_active              TINYINT(1) NOT NULL DEFAULT 1,
  arrival_note           VARCHAR(500) NULL,
  remarks                VARCHAR(500) NULL,
  KEY ix_tts_trip (trip_id, stop_no),
  CONSTRAINT fk_tts_trip FOREIGN KEY (trip_id) REFERENCES trx_transport_trip (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Ordered stops of a trip';

CREATE TABLE IF NOT EXISTS trx_transport_stop_request (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT UNSIGNED NOT NULL,
  stop_id         BIGINT UNSIGNED NOT NULL,
  request_id      BIGINT UNSIGNED NOT NULL,
  service_type    ENUM('PICKUP','DELIVERY') NOT NULL,
  expected_qty    DECIMAL(12,2) NULL,
  actual_qty      DECIMAL(12,2) NULL,
  receiver_name   VARCHAR(80) NULL,
  result          ENUM('PENDING','DONE','PARTIAL','FAILED') NOT NULL DEFAULT 'PENDING',
  result_note     VARCHAR(500) NULL,
  done_at         DATETIME NULL,
  done_by         BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_tsr (stop_id, request_id, service_type),
  KEY ix_tsr_req (request_id),
  CONSTRAINT fk_tsr_stop FOREIGN KEY (stop_id) REFERENCES trx_transport_trip_stop (id),
  CONSTRAINT fk_tsr_req FOREIGN KEY (request_id) REFERENCES trx_transport_request (id),
  CONSTRAINT ck_tsr_qty CHECK ((expected_qty IS NULL OR expected_qty >= 0) AND (actual_qty IS NULL OR actual_qty >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Request service at a stop (pickup / delivery)';

CREATE TABLE IF NOT EXISTS trx_transport_status_log (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id        BIGINT UNSIGNED NOT NULL,
  entity_type       ENUM('REQUEST','TRIP','STOP') NOT NULL,
  entity_id         BIGINT UNSIGNED NOT NULL,
  trip_id           BIGINT UNSIGNED NULL,
  old_status        VARCHAR(30) NULL,
  new_status        VARCHAR(30) NULL,
  event_code        VARCHAR(40) NOT NULL,
  event_note        VARCHAR(1000) NULL,
  before_json       JSON NULL,
  after_json        JSON NULL,
  actor_user_id     BIGINT UNSIGNED NULL,
  event_at          DATETIME NOT NULL,
  KEY ix_tsl_entity (entity_type, entity_id, event_at),
  KEY ix_tsl_trip (trip_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Transport status timeline (request / trip / stop)';

CREATE TABLE IF NOT EXISTS trx_transport_proof (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT UNSIGNED NOT NULL,
  trip_id         BIGINT UNSIGNED NOT NULL,
  stop_id         BIGINT UNSIGNED NULL,
  request_id      BIGINT UNSIGNED NULL,
  proof_type      ENUM('PHOTO','SIGNATURE','DOCUMENT') NOT NULL DEFAULT 'PHOTO',
  receiver_name   VARCHAR(80) NULL,
  delivered_qty   DECIMAL(12,2) NULL,
  file_url        VARCHAR(300) NOT NULL,
  captured_at     DATETIME NOT NULL,
  uploaded_by     BIGINT UNSIGNED NULL,
  KEY ix_tp_trip (trip_id),
  KEY ix_tp_req (request_id),
  CONSTRAINT fk_tp_trip FOREIGN KEY (trip_id) REFERENCES trx_transport_trip (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Pickup / delivery proof';

CREATE TABLE IF NOT EXISTS trx_transport_trip_issue (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id       BIGINT UNSIGNED NOT NULL,
  trip_id          BIGINT UNSIGNED NOT NULL,
  stop_id          BIGINT UNSIGNED NULL,
  issue_type       ENUM('DELAY','RECIPIENT_UNAVAILABLE','ITEM_NOT_READY','WRONG_ADDRESS','BREAKDOWN','ACCIDENT','PARTIAL_PICKUP','OTHER') NOT NULL,
  severity         ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL DEFAULT 'MEDIUM',
  description      VARCHAR(1000) NOT NULL,
  reported_by      BIGINT UNSIGNED NULL,
  reported_at      DATETIME NOT NULL,
  resolved_by      BIGINT UNSIGNED NULL,
  resolved_at      DATETIME NULL,
  resolution_note  VARCHAR(500) NULL,
  KEY ix_tti_trip (trip_id),
  KEY ix_tti_open (company_id, resolved_at),
  CONSTRAINT fk_tti_trip FOREIGN KEY (trip_id) REFERENCES trx_transport_trip (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Trip issues reported by the driver';

CREATE TABLE IF NOT EXISTS trx_transport_idempotency (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id      BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  idem_key        VARCHAR(80) NOT NULL,
  endpoint        VARCHAR(120) NOT NULL,
  response_json   JSON NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tid (company_id, user_id, idem_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Driver action idempotency keys';

-- ------------------------------------------------------------ guarded column / index additions
DROP PROCEDURE IF EXISTS _t150_add_col;
CREATE PROCEDURE _t150_add_col(IN t VARCHAR(64), IN c VARCHAR(64), IN ddl VARCHAR(500))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = t AND COLUMN_NAME = c) THEN
    SET @q = CONCAT('ALTER TABLE ', t, ' ADD COLUMN ', c, ' ', ddl);
    PREPARE s1 FROM @q; EXECUTE s1; DEALLOCATE PREPARE s1;
  END IF;
END;
CALL _t150_add_col('trx_notification', 'event_key', 'VARCHAR(120) NULL COMMENT ''One notification per recipient + event (transport)''');
CALL _t150_add_col('trx_notification', 'action_url', 'VARCHAR(255) NULL COMMENT ''Deep link opened from the header messages''');
CALL _t150_add_col('trx_gate_visitor', 'photo_url', 'VARCHAR(255) NULL COMMENT ''Visitor photo captured at the gate''');
CALL _t150_add_col('trx_gate_visitor', 'host_department_id', 'BIGINT UNSIGNED NULL COMMENT ''Department of the person met''');
DROP PROCEDURE IF EXISTS _t150_add_col;

SET @x = (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trx_notification' AND INDEX_NAME = 'uq_notif_event');
SET @s = IF(@x = 0, 'ALTER TABLE trx_notification ADD UNIQUE KEY uq_notif_event (user_id, event_key)', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ------------------------------------------------------------ default request types (§2.1) per company
INSERT INTO cfg_transport_request_type (company_id, type_code, type_name, requires_pickup, requires_destination, requires_material, requires_proof, sort_order)
SELECT c.id, t.code, t.name, t.p, t.d, t.m, t.pr, t.so FROM mst_company c
  JOIN (SELECT 'PICKUP' code, 'Pickup' name, 1 p, 1 d, 0 m, 0 pr, 10 so UNION ALL
        SELECT 'DROP', 'Drop', 1, 1, 0, 0, 20 UNION ALL
        SELECT 'PICKUP_DROP', 'Pickup & Drop', 1, 1, 0, 0, 30 UNION ALL
        SELECT 'COURIER_COLLECTION', 'Courier Collection', 1, 1, 1, 1, 40 UNION ALL
        SELECT 'COURIER_DISPATCH', 'Courier Dispatch', 1, 1, 1, 1, 50 UNION ALL
        SELECT 'DOCUMENT_MOVEMENT', 'Document Movement', 1, 1, 1, 0, 60 UNION ALL
        SELECT 'MATERIAL_MOVEMENT', 'Material Movement', 1, 1, 1, 1, 70 UNION ALL
        SELECT 'OTHER', 'Other', 0, 0, 0, 0, 80) t
 WHERE NOT EXISTS (SELECT 1 FROM cfg_transport_request_type x WHERE x.company_id = c.id AND x.type_code = t.code);

-- ------------------------------------------------------------ module + permissions
INSERT INTO mst_module (module_code, module_name, parent_id, sort_order)
SELECT 'TRANSPORT', 'Transport (Gate)', (SELECT id FROM (SELECT id FROM mst_module WHERE module_code = 'GATE') g), 48
 WHERE NOT EXISTS (SELECT 1 FROM mst_module WHERE module_code = 'TRANSPORT');

INSERT INTO mst_permission (module_id, permission_code, permission_name)
SELECT m.id, t.code, t.name FROM mst_module m
  JOIN (SELECT 'TRANSPORT.REQUEST' code, 'Raise vehicle requests and see own requests' name UNION ALL
        SELECT 'TRANSPORT.VIEW', 'View all vehicle requests, trips, dashboard and transport reports' UNION ALL
        SELECT 'TRANSPORT.APPROVE', 'Review, clarify, approve, reject and cancel vehicle requests' UNION ALL
        SELECT 'TRANSPORT.APPROVE_OWN', 'Approve own vehicle requests' UNION ALL
        SELECT 'TRANSPORT.ASSIGN', 'Plan trips, allocate vehicle + driver, reassign, cancel and exception-close trips' UNION ALL
        SELECT 'TRANSPORT.MASTER', 'Vehicle, driver and request type masters' UNION ALL
        SELECT 'TRANSPORT.DRIVER', 'Driver screen: own trips, accept / reject, milestones, proof, issues') t
 WHERE m.module_code = 'TRANSPORT' AND NOT EXISTS (SELECT 1 FROM mst_permission x WHERE x.permission_code = t.code);

-- roles: Transport Coordinator / Vehicle Manager and Driver in every company
INSERT INTO mst_role (company_id, role_code, role_name, description, is_system)
SELECT c.id, r.code, r.name, r.descr, 0 FROM mst_company c
  JOIN (SELECT 'TRANSPORT_COORDINATOR' code, 'Transport Coordinator / Vehicle Manager' name, 'Approves vehicle requests and allocates vehicles and drivers' descr UNION ALL
        SELECT 'DRIVER', 'Driver', 'Staff driver: own trips on the driver screen') r
 WHERE NOT EXISTS (SELECT 1 FROM mst_role x WHERE x.company_id = c.id AND x.role_code = r.code);

-- one-time grants per company (a later change on the Roles screen is not undone by the next deploy)
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code LIKE 'TRANSPORT.%'
 WHERE r.role_code IN ('SUPER_ADMIN','ADMIN')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'TRANSPORT_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r
  JOIN mst_permission p ON p.permission_code IN ('TRANSPORT.REQUEST','TRANSPORT.VIEW','TRANSPORT.APPROVE','TRANSPORT.ASSIGN','TRANSPORT.MASTER')
 WHERE r.role_code = 'TRANSPORT_COORDINATOR'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'TRANSPORT_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r
  JOIN mst_permission p ON p.permission_code IN ('TRANSPORT.REQUEST','TRANSPORT.DRIVER')
 WHERE r.role_code = 'DRIVER'
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'TRANSPORT_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
-- "a merchandiser (or anyone) raises a request": every other standard staff role may raise requests
INSERT INTO map_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM mst_role r JOIN mst_permission p ON p.permission_code = 'TRANSPORT.REQUEST'
 WHERE r.role_code IN ('MERCHANDISER','PRODUCTION_MANAGER','PRODUCTION_USER','PURCHASE_OFFICER','STORE_KEEPER','FABRIC_STORE','QA','QC_INSPECTOR',
                       'EXPORT_EXECUTIVE','ACCOUNTANT','PROCESS_MANAGER','CUTTING_SUPERVISOR','CUTTING_PLANNER','CAD_OPERATOR','CAD_APPROVER',
                       'EMBROIDERY_SUPERVISOR','PRINTING_SUPERVISOR')
   AND NOT EXISTS (SELECT 1 FROM cfg_system_setting g WHERE g.company_id = r.company_id AND g.setting_key = 'TRANSPORT_PERMS_GRANTED')
   AND NOT EXISTS (SELECT 1 FROM map_role_permission m WHERE m.role_id = r.id AND m.permission_id = p.id);
INSERT IGNORE INTO cfg_system_setting (company_id, setting_key, setting_value, description)
SELECT id, 'TRANSPORT_PERMS_GRANTED', '1', 'Transport permissions granted to the standard roles (one time, migration 150)' FROM mst_company;
