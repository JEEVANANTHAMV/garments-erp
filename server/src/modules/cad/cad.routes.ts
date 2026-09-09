import { Router } from 'express';
import { query, queryOne, transaction, txQuery, txQueryOne, txExecute } from '../../config/db.js';
import { ah } from '../../core/asyncHandler.js';
import { NotFound, BadRequest } from '../../core/errors.js';
import { requirePermission } from '../../middleware/auth.js';
import { audit } from '../../core/audit.js';
import { nextDocNumber } from '../../core/numbering.js';

export const cadRouter = Router();

/* ==============================================================================
   CAD REQUIREMENT & AUTO-CONSUMPTION ENGINE
   ============================================================================== */

/**
 * 1. GET /api/cad-requirements
 * List all CAD requirements with style and buyer joins
 */
cadRouter.get('/cad-requirements', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const { style_id, status, search } = req.query;

  let sql = `
    SELECT cr.*,
           st.style_code, st.style_name,
           b.party_name AS buyer_name,
           sg.group_name AS size_group_name,
           (SELECT COUNT(*) FROM trx_cad_piece cp WHERE cp.cad_req_id = cr.id) AS piece_count
      FROM trx_cad_requirement cr
      LEFT JOIN mst_style st ON st.id = cr.style_id
      LEFT JOIN mst_party b ON b.id = cr.buyer_id
      LEFT JOIN mst_size_group sg ON sg.id = cr.size_group_id
     WHERE cr.company_id = ?
  `;
  const params: any[] = [companyId];

  if (style_id) {
    sql += ` AND cr.style_id = ?`;
    params.push(Number(style_id));
  }
  if (status) {
    sql += ` AND cr.status = ?`;
    params.push(String(status));
  }
  if (search) {
    sql += ` AND (cr.req_no LIKE ? OR cr.internal_ir_no LIKE ? OR st.style_code LIKE ? OR st.style_name LIKE ?)`;
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  sql += ` ORDER BY cr.id DESC`;

  const rows = await query<any>(sql, params);
  res.json({ data: rows });
}));

/**
 * 2. GET /api/cad-requirements/style-data/:styleId
 * Pre-populates style specs, buyer, size group and sizes, and materials
 */
cadRouter.get('/cad-requirements/style-data/:styleId', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const styleId = Number(req.params.styleId);

  const style = await queryOne<any>(`
    SELECT st.*, b.party_name AS buyer_name, sg.id AS sg_id, sg.group_name AS size_group_name
      FROM mst_style st
      LEFT JOIN mst_party b ON b.id = st.buyer_id
      LEFT JOIN mst_size_group sg ON sg.id = st.size_group_id
     WHERE st.id = ? AND st.company_id = ?
  `, [styleId, companyId]);

  if (!style) throw NotFound('Style not found');

  // Load Sizes
  const sizes = await query<any>(`
    SELECT s.id, s.size_code, s.size_name, s.sort_order
      FROM mst_size s
     WHERE s.size_group_id = ?
     ORDER BY s.sort_order ASC
  `, [style.size_group_id || 1]);

  // Load BOM Items
  const bom = await queryOne<any>(`
    SELECT b.* FROM trx_bom b
     WHERE b.style_id = ? AND b.company_id = ? AND b.is_active = 1
     ORDER BY b.id DESC LIMIT 1
  `, [styleId, companyId]);

  let bomLines: any[] = [];
  if (bom) {
    bomLines = await query<any>(`
      SELECT bl.*,
             COALESCE(fb.fabric_name, y.yarn_name, tr.trim_name, bl.item_name) AS material_name,
             COALESCE(fb.fabric_code, y.yarn_code, tr.trim_code, '') AS material_code,
             COALESCE(fb.gsm, 180) AS fabric_gsm,
             u.code AS uom_code
        FROM trx_bom_line bl
        LEFT JOIN mst_fabric fb ON fb.id = bl.fabric_id
        LEFT JOIN mst_yarn y ON y.id = bl.yarn_id
        LEFT JOIN mst_trim tr ON tr.id = bl.trim_id
        LEFT JOIN cfg_uom u ON u.id = bl.uom_id
       WHERE bl.bom_id = ?
    `, [bom.id]);
  }

  res.json({
    data: {
      style,
      sizes: sizes.length > 0 ? sizes : [
        { id: 1, size_code: 'S', size_name: 'Small', sort_order: 1 },
        { id: 2, size_code: 'M', size_name: 'Medium', sort_order: 2 },
        { id: 3, size_code: 'L', size_name: 'Large', sort_order: 3 },
        { id: 4, size_code: 'XL', size_name: 'X-Large', sort_order: 4 },
        { id: 5, size_code: 'XXL', size_name: '2X-Large', sort_order: 5 },
      ],
      bomLines,
    },
  });
}));

/**
 * 3. GET /api/cad-requirements/:id
 * Retrieve a CAD requirement by ID
 */
cadRouter.get('/cad-requirements/:id', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);

  const reqRow = await queryOne<any>(`
    SELECT cr.*,
           st.style_code, st.style_name,
           b.party_name AS buyer_name,
           sg.group_name AS size_group_name
      FROM trx_cad_requirement cr
      LEFT JOIN mst_style st ON st.id = cr.style_id
      LEFT JOIN mst_party b ON b.id = cr.buyer_id
      LEFT JOIN mst_size_group sg ON sg.id = cr.size_group_id
     WHERE cr.id = ? AND cr.company_id = ?
  `, [id, companyId]);

  if (!reqRow) throw NotFound('CAD Requirement not found');

  const pieces = await query<any>(`
    SELECT cp.*
      FROM trx_cad_piece cp
     WHERE cp.cad_req_id = ?
     ORDER BY cp.id ASC
  `, [id]);

  let dataJson: any = {};
  try {
    if (reqRow.data_json) {
      dataJson = typeof reqRow.data_json === 'string' ? JSON.parse(reqRow.data_json) : reqRow.data_json;
    }
  } catch {
    // ignore
  }

  res.json({
    data: {
      ...reqRow,
      size_breakdown: dataJson.size_breakdown,
      stripes: dataJson.stripes,
      loss_rules: dataJson.loss_rules,
      pieces: (dataJson.pieces && dataJson.pieces.length > 0) ? dataJson.pieces : pieces,
      dataJson,
    },
  });
}));

/**
 * 4. POST /api/cad-requirements
 * Create or save draft of CAD Requirement
 */
cadRouter.post('/cad-requirements', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const body = req.body;

  let finalReqNo = body.req_no;

  const savedId = await transaction(async (tx) => {
    let recId = body.id ? Number(body.id) : null;
    if (!finalReqNo) {
      finalReqNo = await nextDocNumber(tx, companyId, 'CAD_REQ');
    }

    const dataJsonStr = JSON.stringify(body.data_json || {
      size_breakdown: body.size_breakdown,
      stripes: body.stripes,
      loss_rules: body.loss_rules,
      pieces: body.pieces,
      total_fabric_kg: body.total_fabric_kg,
    });

    if (recId) {
      await txExecute(tx, `
        UPDATE trx_cad_requirement
           SET req_date = ?,
               internal_ir_no = ?,
               style_id = ?,
               buyer_id = ?,
               order_qty = ?,
               size_group_id = ?,
               cad_version = ?,
               import_source = ?,
               consumption_source = ?,
               marker_efficiency = ?,
               status = ?,
               remarks = ?,
               data_json = ?
         WHERE id = ? AND company_id = ?
      `, [
        body.req_date || new Date().toISOString().slice(0, 10),
        body.internal_ir_no || 'IR-2026-0001',
        Number(body.style_id),
        body.buyer_id ? Number(body.buyer_id) : null,
        Number(body.order_qty) || 1000,
        body.size_group_id ? Number(body.size_group_id) : null,
        body.cad_version || 'V01',
        body.import_source || 'MANUAL',
        body.consumption_source || 'PIECE_AREA',
        Number(body.marker_efficiency) || 85.0,
        body.status || 'DRAFT',
        body.remarks || null,
        dataJsonStr,
        recId,
        companyId,
      ]);
    } else {
      const ins = await txQueryOne<{ insertId: number }>(tx, `
        INSERT INTO trx_cad_requirement (
          company_id, req_no, req_date, internal_ir_no, style_id, buyer_id,
          order_qty, size_group_id, cad_version, import_source,
          consumption_source, marker_efficiency, status, remarks, data_json, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        companyId,
        finalReqNo,
        body.req_date || new Date().toISOString().slice(0, 10),
        body.internal_ir_no || 'IR-2026-0001',
        Number(body.style_id),
        body.buyer_id ? Number(body.buyer_id) : null,
        Number(body.order_qty) || 1000,
        body.size_group_id ? Number(body.size_group_id) : null,
        body.cad_version || 'V01',
        body.import_source || 'MANUAL',
        body.consumption_source || 'PIECE_AREA',
        Number(body.marker_efficiency) || 85.0,
        body.status || 'DRAFT',
        body.remarks || null,
        dataJsonStr,
        userId,
      ]);
      recId = ins!.insertId;
    }

    // Save Pieces
    if (Array.isArray(body.pieces)) {
      await txExecute(tx, `DELETE FROM trx_cad_piece WHERE cad_req_id = ?`, [recId]);
      for (const p of body.pieces) {
        if (!p.piece_name) continue;
        await txExecute(tx, `
          INSERT INTO trx_cad_piece (
            cad_req_id, piece_id, piece_name, component, size_name,
            length_mm, width_mm, area_sqm, piece_qty, marker_no,
            material_type, material_id, material_code, color_name, shade_code, status
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          recId,
          p.piece_id || p.piece_name,
          p.piece_name,
          p.component || 'BODY',
          p.size_name || 'M',
          p.length_mm ? Number(p.length_mm) : null,
          p.width_mm ? Number(p.width_mm) : null,
          Number(p.area_sqm) || 0.0,
          Number(p.piece_qty) || 1,
          p.marker_no || null,
          p.material_type || 'FABRIC',
          p.material_id ? Number(p.material_id) : null,
          p.material_code || null,
          p.color_name || null,
          p.shade_code || null,
          p.status || 'MAPPED',
        ]);
      }
    }

    return recId;
  });

  await audit(req, 'trx_cad_requirement', savedId, body.id ? 'UPDATE' : 'INSERT', null, { req_no: finalReqNo, style_id: body.style_id });

  res.json({ data: { id: savedId, req_no: finalReqNo } });
}));

/**
 * 5. POST /api/cad-requirements/:id/calculate
 * Executes the full Auto-Consumption Engine as per spec
 */
cadRouter.post('/cad-requirements/:id/calculate', requirePermission('PRODUCTION.VIEW'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const id = Number(req.params.id);
  const body = req.body;

  const cr = await queryOne<any>(`
    SELECT cr.*, st.style_code
      FROM trx_cad_requirement cr
      LEFT JOIN mst_style st ON st.id = cr.style_id
     WHERE cr.id = ? AND cr.company_id = ?
  `, [id, companyId]);

  if (!cr) throw NotFound('CAD Requirement not found');

  const orderQty = Number(body.order_qty || cr.order_qty || 1000);
  const efficiency = (Number(body.marker_efficiency || cr.marker_efficiency || 85.0)) / 100.0;
  const sizes = Array.isArray(body.sizes) ? body.sizes : [];
  const pieces = Array.isArray(body.pieces) ? body.pieces : [];
  const multiMaterials = Array.isArray(body.multi_materials) ? body.multi_materials : [];
  const stripeRules = Array.isArray(body.stripe_rules) ? body.stripe_rules : [];
  const mixRules = Array.isArray(body.mix_rules) ? body.mix_rules : [];
  const wastageRules = body.wastage_rules || { fabric: 5.0, foam: 3.0, interlining: 2.0, yarn: 3.0 };
  const yarnConversion = body.yarn_conversion || { factor: 0.98, process_loss: 3.0 };

  // 1. Calculate Component-wise Area & Fabric Consumption
  // Formula: Piece Weight (KG) = Area (m²) * GSM / 1000
  // If marker efficiency: Consumption KG = Net Weight / Efficiency
  let totalFabricGrossKg = 0;
  let totalFoamKg = 0;
  let totalInterliningKg = 0;

  const componentBreakdown: Record<string, { area: number; pieces: number; gsm: number; grossKg: number }> = {};

  for (const p of pieces) {
    const comp = p.component || 'BODY';
    const area = Number(p.area_sqm) || 0.0;
    const qty = Number(p.piece_qty) || 1;
    const gsm = Number(p.gsm) || 180;

    if (!componentBreakdown[comp]) {
      componentBreakdown[comp] = { area: 0, pieces: 0, gsm, grossKg: 0 };
    }
    componentBreakdown[comp].area += area * qty;
    componentBreakdown[comp].pieces += qty;
  }

  // Calculate requirement for each component based on order qty and sizes
  const sizeTotal = sizes.reduce((s: number, x: any) => s + (Number(x.qty) || 0), 0);
  const effectiveQty = sizeTotal > 0 ? sizeTotal : orderQty;

  const materialOutputs: any[] = [];

  // A. Primary Fabric Calculations per Component
  for (const [comp, info] of Object.entries(componentBreakdown)) {
    const netWeightPerPc = (info.area * info.gsm) / 1000.0; // KG per piece
    const markerWeightPerPc = efficiency > 0 ? netWeightPerPc / efficiency : netWeightPerPc;
    const compGrossKg = markerWeightPerPc * effectiveQty;
    info.grossKg = compGrossKg;

    // Check if component has 3-colour stripe rule
    const compStripes = stripeRules.filter((s: any) => s.component === comp);
    if (compStripes.length > 0) {
      for (const st of compStripes) {
        const ratio = (Number(st.ratio) || 0) / 100.0;
        const stripeGrossKg = compGrossKg * ratio;
        const wastagePct = Number(wastageRules.fabric || 5.0);
        const wastageKg = (stripeGrossKg * wastagePct) / 100.0;
        const finalKg = stripeGrossKg + wastageKg;

        materialOutputs.push({
          material_type: 'FABRIC',
          material_code: st.material_code || `${comp}-STRIPE`,
          material_name: `${comp} Stripe Fabric (${st.color_name || 'Stripe'})`,
          component: comp,
          color_name: st.color_name || 'Striped',
          shade_code: st.shade_code || '',
          pattern: st.stripe_code || 'STRIPE',
          ratio_pct: st.ratio,
          gross_qty: stripeGrossKg,
          wastage_pct: wastagePct,
          wastage_qty: wastageKg,
          final_qty: finalKg,
          uom: 'KG',
        });
        totalFabricGrossKg += finalKg;
      }
    } else {
      // Check multi-fabric mix rule (e.g. 70/30)
      const compMixes = mixRules.filter((m: any) => m.component === comp);
      if (compMixes.length > 0) {
        for (const mx of compMixes) {
          const pct = (Number(mx.percentage) || 0) / 100.0;
          const mixGrossKg = compGrossKg * pct;
          const wastagePct = Number(wastageRules.fabric || 5.0);
          const wastageKg = (mixGrossKg * wastagePct) / 100.0;
          const finalKg = mixGrossKg + wastageKg;

          materialOutputs.push({
            material_type: 'FABRIC',
            material_code: mx.material_code || `${comp}-${mx.material_name || 'MIX'}`,
            material_name: `${comp} Fabric (${mx.material_name || 'Mix'})`,
            component: comp,
            color_name: mx.color_name || 'Navy',
            shade_code: mx.shade_code || '',
            ratio_pct: mx.percentage,
            gross_qty: mixGrossKg,
            wastage_pct: wastagePct,
            wastage_qty: wastageKg,
            final_qty: finalKg,
            uom: 'KG',
          });
          totalFabricGrossKg += finalKg;
        }
      } else {
        // Standard Solid Fabric
        const wastagePct = Number(wastageRules.fabric || 5.0);
        const wastageKg = (compGrossKg * wastagePct) / 100.0;
        const finalKg = compGrossKg + wastageKg;

        materialOutputs.push({
          material_type: 'FABRIC',
          material_code: `FAB-${comp.toUpperCase()}`,
          material_name: `${comp} Single Jersey Fabric`,
          component: comp,
          color_name: 'Navy',
          shade_code: 'NB-01',
          ratio_pct: 100,
          gross_qty: compGrossKg,
          wastage_pct: wastagePct,
          wastage_qty: wastageKg,
          final_qty: finalKg,
          uom: 'KG',
        });
        totalFabricGrossKg += finalKg;
      }
    }
  }

  // B. Additional Construction Materials (Foam, Interlining, Padding)
  for (const mm of multiMaterials) {
    const comp = mm.component || 'BODY';
    const mType = (mm.material_type || 'FOAM').toUpperCase();
    const consPerPc = Number(mm.consumption_per_pc) || 0.045;
    const grossQty = consPerPc * effectiveQty;
    const wastagePct = Number(wastageRules[mType.toLowerCase()] || 3.0);
    const wastageQty = (grossQty * wastagePct) / 100.0;
    const finalQty = grossQty + wastageQty;

    if (mType === 'FOAM') totalFoamKg += finalQty;
    if (mType === 'INTERLINING') totalInterliningKg += finalQty;

    materialOutputs.push({
      material_type: mType,
      material_code: mm.material_code || `${mType}-3MM`,
      material_name: mm.material_name || `${comp} ${mType} Construction`,
      component: comp,
      construction: mm.construction || '3 MM',
      color_name: 'White/Natural',
      shade_code: '—',
      ratio_pct: 100,
      gross_qty: grossQty,
      wastage_pct: wastagePct,
      wastage_qty: wastageQty,
      final_qty: finalQty,
      uom: mm.uom || 'KG',
    });
  }

  // C. Fabric to Yarn Conversion
  // Formula: Yarn Req = Fabric Req * Factor * (1 + Process Loss %)
  const yFactor = Number(yarnConversion.factor || 0.98);
  const yProcessLoss = (Number(yarnConversion.process_loss || 3.0)) / 100.0;
  const totalYarnKg = totalFabricGrossKg * yFactor * (1 + yProcessLoss);

  materialOutputs.push({
    material_type: 'YARN',
    material_code: 'YARN-30S-COMBED',
    material_name: '30s Combed Cotton Yarn (Auto Converted from Fabric)',
    component: 'SPINNING/KNITTING',
    count: '30s',
    composition: '100% Cotton',
    color_name: 'Raw/Grey',
    shade_code: '—',
    ratio_pct: 100,
    gross_qty: totalFabricGrossKg * yFactor,
    wastage_pct: yarnConversion.process_loss || 3.0,
    wastage_qty: totalFabricGrossKg * yFactor * yProcessLoss,
    final_qty: totalYarnKg,
    uom: 'KG',
  });

  const calculationResult = {
    order_qty: effectiveQty,
    marker_efficiency: efficiency * 100,
    total_fabric_kg: totalFabricGrossKg,
    total_yarn_kg: totalYarnKg,
    total_foam_kg: totalFoamKg,
    total_interlining_kg: totalInterliningKg,
    component_breakdown: componentBreakdown,
    material_outputs: materialOutputs,
  };

  res.json({
    data: calculationResult,
  });
}));

/**
 * 6. POST /api/cad-requirements/:id/approve
 * Approves requirement and generates Material Requirement records
 */
cadRouter.post('/cad-requirements/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const id = Number(req.params.id);
  const { data_json, total_fabric_kg, total_yarn_kg } = req.body;

  const cr = await queryOne<any>(`
    SELECT * FROM trx_cad_requirement WHERE id = ? AND company_id = ?
  `, [id, companyId]);

  if (!cr) throw NotFound('CAD Requirement not found');

  await transaction(async (tx) => {
    await txExecute(tx, `
      UPDATE trx_cad_requirement
         SET status = 'APPROVED',
             data_json = ?
       WHERE id = ? AND company_id = ?
    `, [JSON.stringify(data_json || cr.data_json || {}), id, companyId]);

    // Insert or update Material Requirement Output
    await txExecute(tx, `
      INSERT INTO trx_cad_material_requirement (
        company_id, cad_req_id, style_id, version_no, status,
        total_fabric_kg, total_yarn_kg, data_json, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `, [
      companyId,
      id,
      cr.style_id,
      cr.cad_version || 'V01',
      'APPROVED',
      Number(total_fabric_kg || 0),
      Number(total_yarn_kg || 0),
      JSON.stringify(data_json || {}),
      userId,
    ]);
  });

  await audit(req, 'trx_cad_requirement', id, 'UPDATE', null, { status: 'APPROVED', cad_version: cr.cad_version });

  res.json({ data: { status: 'APPROVED', cad_req_id: id } });
}));
