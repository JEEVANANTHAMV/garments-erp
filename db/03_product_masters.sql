-- =====================================================================
-- 5. PRODUCT / STYLE / MATERIAL MASTERS
--    Colors, Sizes, GSM, Composition, Yarn, Fabric, Trims, Product, Style
-- =====================================================================

CREATE TABLE mst_color (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  color_code      VARCHAR(30) NOT NULL,
  color_name      VARCHAR(80) NOT NULL,
  pantone_ref     VARCHAR(40),
  hex_value       CHAR(7),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_color (company_id,color_code),
  CONSTRAINT fk_color__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Color master (with Pantone reference)';

CREATE TABLE mst_size_group (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  group_code      VARCHAR(30) NOT NULL,   -- ALPHA, NUMERIC-EU, KIDS
  group_name      VARCHAR(80) NOT NULL,
  UNIQUE KEY uq_sizegrp (company_id,group_code),
  CONSTRAINT fk_sizegrp__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Size group / scale';

CREATE TABLE mst_size (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  size_group_id   INT UNSIGNED NOT NULL,
  size_code       VARCHAR(20) NOT NULL,   -- S,M,L,XL / 32,34
  size_label      VARCHAR(40) NOT NULL,
  sort_order      INT DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_size (size_group_id,size_code),
  CONSTRAINT fk_size__grp FOREIGN KEY (size_group_id) REFERENCES mst_size_group(id)
) ENGINE=InnoDB COMMENT='Individual sizes within a group';

CREATE TABLE mst_composition (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  composition_code VARCHAR(30) NOT NULL,
  description     VARCHAR(150) NOT NULL,   -- 100% Cotton, 95% Cot 5% Elastane
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_comp (company_id,composition_code),
  CONSTRAINT fk_comp__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='Fibre composition master';

CREATE TABLE mst_composition_detail (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  composition_id  INT UNSIGNED NOT NULL,
  fibre_name      VARCHAR(60) NOT NULL,   -- Cotton, Polyester, Elastane
  percentage      DECIMAL(5,2) NOT NULL,
  CONSTRAINT fk_compd__comp FOREIGN KEY (composition_id) REFERENCES mst_composition(id)
) ENGINE=InnoDB COMMENT='Fibre % breakdown';

CREATE TABLE mst_gsm (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  gsm_value       INT UNSIGNED NOT NULL,   -- grams per square metre
  tolerance       INT DEFAULT 5,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_gsm (company_id,gsm_value),
  CONSTRAINT fk_gsm__company FOREIGN KEY (company_id) REFERENCES mst_company(id)
) ENGINE=InnoDB COMMENT='GSM master (fabric weight)';

-- Generic material category tree (yarn/fabric/trims share item master)
CREATE TABLE mst_material_category (
  id              INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  parent_id       INT UNSIGNED,
  category_code   VARCHAR(30) NOT NULL,
  category_name   VARCHAR(100) NOT NULL,
  material_type   ENUM('YARN','FABRIC','TRIM','ACCESSORY','PACKING','CONSUMABLE') NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_matcat (company_id,category_code),
  CONSTRAINT fk_matcat__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_matcat__parent  FOREIGN KEY (parent_id)  REFERENCES mst_material_category(id)
) ENGINE=InnoDB COMMENT='Hierarchical material category';

-- Yarn master
CREATE TABLE mst_yarn (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  yarn_code       VARCHAR(40) NOT NULL,
  yarn_name       VARCHAR(150) NOT NULL,
  category_id     INT UNSIGNED,
  count_value     VARCHAR(20),            -- 30s, 40s combed
  count_type      ENUM('Ne','Nm','Denier','Tex') DEFAULT 'Ne',
  composition_id  INT UNSIGNED,
  ply             TINYINT DEFAULT 1,
  yarn_type       ENUM('COMBED','CARDED','OE','COMPACT','MELANGE','SLUB','OTHER') DEFAULT 'COMBED',
  hsn_code        VARCHAR(10),
  base_uom        SMALLINT UNSIGNED NOT NULL,  -- KG / CONE
  std_rate        DECIMAL(18,4) DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_yarn (company_id,yarn_code),
  CONSTRAINT fk_yarn__company FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_yarn__cat     FOREIGN KEY (category_id)    REFERENCES mst_material_category(id),
  CONSTRAINT fk_yarn__comp    FOREIGN KEY (composition_id) REFERENCES mst_composition(id),
  CONSTRAINT fk_yarn__uom     FOREIGN KEY (base_uom)       REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Yarn master';

-- Fabric master
CREATE TABLE mst_fabric (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  fabric_code     VARCHAR(40) NOT NULL,
  fabric_name     VARCHAR(150) NOT NULL,
  category_id     INT UNSIGNED,
  fabric_type     ENUM('KNIT','WOVEN','NONWOVEN') NOT NULL DEFAULT 'KNIT',
  knit_structure  VARCHAR(60),            -- Single Jersey, Rib 1x1, Interlock, Fleece
  composition_id  INT UNSIGNED,
  gsm_id          INT UNSIGNED,
  width_cm        DECIMAL(6,2),           -- open/tube width
  dia_inch        DECIMAL(6,2),           -- tube diameter
  yarn_id         BIGINT UNSIGNED,        -- primary yarn used
  finish_type     VARCHAR(80),            -- Bio-wash, Enzyme, Peached
  hsn_code        VARCHAR(10),
  base_uom        SMALLINT UNSIGNED NOT NULL,  -- KG / MTR
  std_rate        DECIMAL(18,4) DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fabric (company_id,fabric_code),
  CONSTRAINT fk_fabric__company FOREIGN KEY (company_id)     REFERENCES mst_company(id),
  CONSTRAINT fk_fabric__cat     FOREIGN KEY (category_id)    REFERENCES mst_material_category(id),
  CONSTRAINT fk_fabric__comp    FOREIGN KEY (composition_id) REFERENCES mst_composition(id),
  CONSTRAINT fk_fabric__gsm     FOREIGN KEY (gsm_id)         REFERENCES mst_gsm(id),
  CONSTRAINT fk_fabric__yarn    FOREIGN KEY (yarn_id)        REFERENCES mst_yarn(id),
  CONSTRAINT fk_fabric__uom     FOREIGN KEY (base_uom)       REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Fabric master';

-- Trims & Accessories master
CREATE TABLE mst_trim (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  trim_code       VARCHAR(40) NOT NULL,
  trim_name       VARCHAR(150) NOT NULL,
  category_id     INT UNSIGNED,
  trim_type       ENUM('BUTTON','ZIPPER','LABEL','THREAD','ELASTIC','DRAWCORD',
                       'HANGTAG','STICKER','POLYBAG','CARTON','HANGER','TAPE',
                       'RIVET','VELCRO','LACE','OTHER') NOT NULL,
  specification   VARCHAR(200),
  hsn_code        VARCHAR(10),
  base_uom        SMALLINT UNSIGNED NOT NULL,   -- PCS, GROSS, MTR, ROLL
  std_rate        DECIMAL(18,4) DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trim (company_id,trim_code),
  CONSTRAINT fk_trim__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_trim__cat     FOREIGN KEY (category_id) REFERENCES mst_material_category(id),
  CONSTRAINT fk_trim__uom     FOREIGN KEY (base_uom)    REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Trims & accessories master';

-- Product master (garment type catalog)
CREATE TABLE mst_product (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  product_code    VARCHAR(40) NOT NULL,
  product_name    VARCHAR(150) NOT NULL,
  product_type    ENUM('TSHIRT','POLO','SWEATSHIRT','HOODIE','SHORTS','TRACKPANT',
                       'LEGGING','INNERWEAR','NIGHTWEAR','KIDSWEAR','JACKET','OTHER') NOT NULL,
  gender          ENUM('MEN','WOMEN','UNISEX','BOYS','GIRLS','INFANT') NOT NULL DEFAULT 'UNISEX',
  hsn_code        VARCHAR(10),
  default_uom     SMALLINT UNSIGNED NOT NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product (company_id,product_code),
  CONSTRAINT fk_product__company FOREIGN KEY (company_id)  REFERENCES mst_company(id),
  CONSTRAINT fk_product__uom     FOREIGN KEY (default_uom) REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Product / garment-type master';

-- Style master (buyer-specific style with season)
CREATE TABLE mst_style (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  style_code      VARCHAR(50) NOT NULL,
  style_name      VARCHAR(150) NOT NULL,
  product_id      BIGINT UNSIGNED NOT NULL,
  buyer_id        BIGINT UNSIGNED,        -- party is_buyer
  buyer_style_ref VARCHAR(80),            -- buyer's own style number
  season          VARCHAR(40),            -- SS26, AW26
  size_group_id   INT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,        -- primary body fabric
  description     TEXT,
  sketch_doc_id   BIGINT UNSIGNED,        -- link to mst_document
  status_id       INT UNSIGNED,           -- cfg_status domain STYLE
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_deleted      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_style (company_id,style_code),
  KEY ix_style_buyer (buyer_id),
  CONSTRAINT fk_style__company FOREIGN KEY (company_id)    REFERENCES mst_company(id),
  CONSTRAINT fk_style__product FOREIGN KEY (product_id)    REFERENCES mst_product(id),
  CONSTRAINT fk_style__buyer   FOREIGN KEY (buyer_id)      REFERENCES mst_party(id),
  CONSTRAINT fk_style__szgrp   FOREIGN KEY (size_group_id) REFERENCES mst_size_group(id),
  CONSTRAINT fk_style__fabric  FOREIGN KEY (fabric_id)     REFERENCES mst_fabric(id),
  CONSTRAINT fk_style__status  FOREIGN KEY (status_id)     REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Style master (buyer/season specific)';

-- Style-colorway mapping (which colors a style is offered in)
CREATE TABLE map_style_color (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_style_color (style_id,color_id),
  CONSTRAINT fk_sc__style FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_sc__color FOREIGN KEY (color_id) REFERENCES mst_color(id)
) ENGINE=InnoDB COMMENT='Style colorways';

-- Style SKU = style x color x size (used everywhere downstream)
CREATE TABLE mst_style_sku (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  style_id        BIGINT UNSIGNED NOT NULL,
  color_id        BIGINT UNSIGNED NOT NULL,
  size_id         INT UNSIGNED NOT NULL,
  sku_code        VARCHAR(60) NOT NULL,
  buyer_sku_ref   VARCHAR(60),
  barcode         VARCHAR(60),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_sku (style_id,color_id,size_id),
  UNIQUE KEY uq_sku_code (sku_code),
  CONSTRAINT fk_sku__style FOREIGN KEY (style_id) REFERENCES mst_style(id),
  CONSTRAINT fk_sku__color FOREIGN KEY (color_id) REFERENCES mst_color(id),
  CONSTRAINT fk_sku__size  FOREIGN KEY (size_id)  REFERENCES mst_size(id)
) ENGINE=InnoDB COMMENT='Style SKU (style×color×size) — inventory unit';

-- =====================================================================
-- 6. BILL OF MATERIALS (BOM) & TECH PACK
-- =====================================================================

CREATE TABLE trx_bom (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  so_id           BIGINT UNSIGNED,        -- optional link to specific sales order
  bom_no          VARCHAR(40) NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  effective_date  DATE,
  status_id       INT UNSIGNED,           -- cfg_status domain BOM
  remarks         VARCHAR(500),
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bom (company_id,bom_no,version),
  KEY ix_bom_so (so_id),
  CONSTRAINT fk_bom__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_bom__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_bom__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='BOM header (versioned per style)';

CREATE TABLE trx_bom_line (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  bom_id          BIGINT UNSIGNED NOT NULL,
  material_type   ENUM('YARN','FABRIC','TRIM') NOT NULL,
  yarn_id         BIGINT UNSIGNED,
  fabric_id       BIGINT UNSIGNED,
  trim_id         BIGINT UNSIGNED,
  color_id        BIGINT UNSIGNED,        -- color-specific consumption if any
  size_id         INT UNSIGNED,           -- size-specific consumption if any
  consumption     DECIMAL(18,5) NOT NULL, -- per garment
  uom_id          SMALLINT UNSIGNED NOT NULL,
  wastage_pct     DECIMAL(6,3) NOT NULL DEFAULT 0,
  remarks         VARCHAR(255),
  CONSTRAINT fk_boml__bom    FOREIGN KEY (bom_id)    REFERENCES trx_bom(id),
  CONSTRAINT fk_boml__yarn   FOREIGN KEY (yarn_id)   REFERENCES mst_yarn(id),
  CONSTRAINT fk_boml__fabric FOREIGN KEY (fabric_id) REFERENCES mst_fabric(id),
  CONSTRAINT fk_boml__trim   FOREIGN KEY (trim_id)   REFERENCES mst_trim(id),
  CONSTRAINT fk_boml__color  FOREIGN KEY (color_id)  REFERENCES mst_color(id),
  CONSTRAINT fk_boml__size   FOREIGN KEY (size_id)   REFERENCES mst_size(id),
  CONSTRAINT fk_boml__uom    FOREIGN KEY (uom_id)    REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='BOM detail lines (consumption per garment)';

CREATE TABLE trx_techpack (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  company_id      BIGINT UNSIGNED NOT NULL,
  style_id        BIGINT UNSIGNED NOT NULL,
  techpack_no     VARCHAR(40) NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  status_id       INT UNSIGNED,
  received_from   VARCHAR(120),           -- buyer / internal
  received_date   DATE,
  remarks         TEXT,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by      BIGINT UNSIGNED,
  updated_at      DATETIME ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_techpack (company_id,techpack_no,version),
  CONSTRAINT fk_tp__company FOREIGN KEY (company_id) REFERENCES mst_company(id),
  CONSTRAINT fk_tp__style   FOREIGN KEY (style_id)   REFERENCES mst_style(id),
  CONSTRAINT fk_tp__status  FOREIGN KEY (status_id)  REFERENCES cfg_status(id)
) ENGINE=InnoDB COMMENT='Tech pack header';

-- Point-of-Measure spec sheet
CREATE TABLE trx_techpack_measurement (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  techpack_id     BIGINT UNSIGNED NOT NULL,
  pom_code        VARCHAR(30),            -- point of measure code
  pom_description VARCHAR(150) NOT NULL,  -- Chest width, Body length
  size_id         INT UNSIGNED NOT NULL,
  spec_value      DECIMAL(8,2) NOT NULL,
  tol_plus        DECIMAL(6,2) DEFAULT 0,
  tol_minus       DECIMAL(6,2) DEFAULT 0,
  uom_id          SMALLINT UNSIGNED,      -- CM / INCH
  CONSTRAINT fk_tpm__tp   FOREIGN KEY (techpack_id) REFERENCES trx_techpack(id),
  CONSTRAINT fk_tpm__size FOREIGN KEY (size_id)     REFERENCES mst_size(id),
  CONSTRAINT fk_tpm__uom  FOREIGN KEY (uom_id)      REFERENCES cfg_uom(id)
) ENGINE=InnoDB COMMENT='Tech pack measurement spec (graded POM)';
