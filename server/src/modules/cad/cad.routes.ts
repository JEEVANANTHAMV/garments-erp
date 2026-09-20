import { Router } from 'express';
import XLSX from 'xlsx';
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
           (SELECT COUNT(*) FROM trx_cad_piece cp WHERE cp.cad_req_id = cr.id) AS piece_count,
           (SELECT COUNT(*) FROM trx_cad_marker cm WHERE cm.cad_req_id = cr.id) AS marker_count,
           (SELECT COALESCE(SUM(total_req_qty), 0) FROM trx_cad_marker cm WHERE cm.cad_req_id = cr.id) AS total_fabric_kg
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
 * Retrieve a CAD requirement by ID with markers and fabric program
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

  // Load Markers
  const markerRows = await query<any>(`
    SELECT cm.*
      FROM trx_cad_marker cm
     WHERE cm.cad_req_id = ?
     ORDER BY cm.sort_order ASC, cm.id ASC
  `, [id]);

  const markers = markerRows.map((m) => {
    let mJson: any = {};
    try {
      if (m.data_json) {
        mJson = typeof m.data_json === 'string' ? JSON.parse(m.data_json) : m.data_json;
      }
    } catch {
      // ignore
    }
    return {
      ...m,
      sizes: mJson.sizes || [],
      ratios: mJson.ratios || [],
      colorways: mJson.colorways || [],
    };
  });

  // Load Fabric Program & Cutting Lay
  const fabricPrograms = await query<any>(`
    SELECT fp.*
      FROM trx_cad_fabric_program fp
     WHERE fp.cad_req_id = ?
     ORDER BY fp.sort_order ASC, fp.id ASC
  `, [id]);

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
      markers: markers.length > 0 ? markers : (dataJson.markers || []),
      fabric_program: fabricPrograms.filter((f) => f.sheet_type === 'FABRIC_PROGRAM'),
      cutting_lay: fabricPrograms.filter((f) => f.sheet_type === 'CUTTING_LAY'),
      size_breakdown: dataJson.size_breakdown,
      stripes: dataJson.stripes,
      loss_rules: dataJson.loss_rules,
      pieces: (dataJson.pieces && dataJson.pieces.length > 0) ? dataJson.pieces : pieces,
      summary_metrics: dataJson.summary_metrics || {},
      dataJson,
    },
  });
}));

/**
 * 4. POST /api/cad-requirements
 * Create or save draft of CAD Requirement with markers and fabric programs
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
      markers: body.markers,
      fabric_program: body.fabric_program,
      cutting_lay: body.cutting_lay,
      summary_metrics: body.summary_metrics,
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
               cad_type = ?,
               uom = ?,
               rejection_pct = ?,
               fabric_allowance_pct = ?,
               special_notes = ?,
               signoff_json = ?,
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
        body.cad_type || 'KNIT_SJ',
        body.uom || 'KG',
        Number(body.rejection_pct ?? 3.0),
        Number(body.fabric_allowance_pct ?? 10.0),
        body.special_notes || null,
        body.signoff_json ? JSON.stringify(body.signoff_json) : null,
        Number(body.marker_efficiency) || 85.0,
        body.status || 'DRAFT',
        body.remarks || null,
        dataJsonStr,
        recId,
        companyId,
      ]);
    } else {
      const ins = await txExecute(tx, `
        INSERT INTO trx_cad_requirement (
          company_id, req_no, req_date, internal_ir_no, style_id, buyer_id,
          order_qty, size_group_id, cad_version, import_source,
          consumption_source, cad_type, uom, rejection_pct, fabric_allowance_pct,
          special_notes, signoff_json, marker_efficiency, status, remarks, data_json, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
        body.cad_type || 'KNIT_SJ',
        body.uom || 'KG',
        Number(body.rejection_pct ?? 3.0),
        Number(body.fabric_allowance_pct ?? 10.0),
        body.special_notes || null,
        body.signoff_json ? JSON.stringify(body.signoff_json) : null,
        Number(body.marker_efficiency) || 85.0,
        body.status || 'DRAFT',
        body.remarks || null,
        dataJsonStr,
        userId,
      ]);
      recId = ins.insertId;
    }

    // Save Markers
    if (Array.isArray(body.markers)) {
      await txExecute(tx, `DELETE FROM trx_cad_marker WHERE cad_req_id = ?`, [recId]);
      for (let i = 0; i < body.markers.length; i++) {
        const m = body.markers[i];
        const mJsonStr = JSON.stringify({
          sizes: m.sizes || [],
          ratios: m.ratios || [],
          colorways: m.colorways || [],
        });

        await txExecute(tx, `
          INSERT INTO trx_cad_marker (
            cad_req_id, marker_ref, marker_name, length_mm, width_mm,
            fabric_dia_type, fabric_type, gsm, direction, parts_in_lay,
            lay_allowance_cm, width_allowance_in, lay_length_cm, table_width_in,
            fabric_wt_per_lay_g, no_of_pcs_lay, avg_wt_per_pc_g, req_length_per_pc_cm,
            total_req_qty, uom, sort_order, data_json
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          recId,
          m.marker_ref || `M${i + 1}`,
          m.marker_name || `${finalReqNo} ${m.marker_ref || '1A'}`,
          Number(m.length_mm) || 0,
          Number(m.width_mm) || 0,
          m.fabric_dia_type || 'OPEN',
          m.fabric_type || null,
          m.gsm ? Number(m.gsm) : null,
          m.direction || 'ONEWAY',
          m.parts_in_lay || null,
          Number(m.lay_allowance_cm ?? 10.0),
          Number(m.width_allowance_in ?? (m.fabric_dia_type === 'TUBE' ? 1.0 : 2.0)),
          Number(m.lay_length_cm) || 0,
          Number(m.table_width_in) || 0,
          Number(m.fabric_wt_per_lay_g) || 0,
          Number(m.no_of_pcs_lay) || 1,
          Number(m.avg_wt_per_pc_g) || 0,
          Number(m.req_length_per_pc_cm) || 0,
          Number(m.total_req_qty) || 0,
          m.uom || body.uom || 'KG',
          i + 1,
          mJsonStr,
        ]);
      }
    }

    // Save Fabric Program & Cutting Lay Lines
    const allPrograms: any[] = [];
    if (Array.isArray(body.fabric_program)) {
      body.fabric_program.forEach((p: any) => allPrograms.push({ ...p, sheet_type: 'FABRIC_PROGRAM' }));
    }
    if (Array.isArray(body.cutting_lay)) {
      body.cutting_lay.forEach((p: any) => allPrograms.push({ ...p, sheet_type: 'CUTTING_LAY' }));
    }

    if (allPrograms.length > 0) {
      await txExecute(tx, `DELETE FROM trx_cad_fabric_program WHERE cad_req_id = ?`, [recId]);
      for (let i = 0; i < allPrograms.length; i++) {
        const fp = allPrograms[i];
        await txExecute(tx, `
          INSERT INTO trx_cad_fabric_program (
            cad_req_id, sheet_type, fabric_type, gsm, dia_spec, color_name,
            order_qty_pcs, net_qty, buffer_qty, grand_total_qty, uom, remarks, sort_order
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          recId,
          fp.sheet_type || 'FABRIC_PROGRAM',
          fp.fabric_type || 'Main Fabric',
          fp.gsm ? Number(fp.gsm) : null,
          fp.dia_spec || null,
          fp.color_name || 'Solid',
          Number(fp.order_qty_pcs) || 0,
          Number(fp.net_qty) || 0,
          Number(fp.buffer_qty) || 0,
          Number(fp.grand_total_qty) || 0,
          fp.uom || body.uom || 'KG',
          fp.remarks || null,
          i + 1,
        ]);
      }
    }

    // Preserve Pieces if provided
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
 * Executes calculation across all markers (Knit / Woven formulas) and generates F.PRGM & CUT sheets
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

  const cadType = body.cad_type || cr.cad_type || 'KNIT_SJ';
  const isWoven = cadType === 'WOVEN';
  const uom = isWoven ? 'MTR' : 'KG';
  const rejectionPct = Number(body.rejection_pct ?? cr.rejection_pct ?? 3.0);
  const fabricAllowancePct = Number(body.fabric_allowance_pct ?? cr.fabric_allowance_pct ?? 10.0);
  const totalAllowancePct = rejectionPct + fabricAllowancePct;

  const markers = Array.isArray(body.markers) ? body.markers : [];

  // Calculate Marker Details
  const calculatedMarkers = markers.map((m: any, idx: number) => {
    const lengthMm = Number(m.length_mm) || 0;
    const widthMm = Number(m.width_mm) || 0;
    const diaType = m.fabric_dia_type === 'TUBE' ? 'TUBE' : 'OPEN';
    const gsm = Number(m.gsm) || 160;

    const layAllowanceCm = Number(m.lay_allowance_cm ?? 10.0);
    const widthAllowanceIn = Number(m.width_allowance_in ?? (diaType === 'TUBE' ? 1.0 : 2.0));

    // Lay Length in cm: (Length mm / 10) + allowance
    const layLengthCm = Math.round(((lengthMm / 10.0) + layAllowanceCm) * 10) / 10;

    // Table Width in inches: (Width mm / 10 / 2.54) + allowance
    const tableWidthIn = Math.round(((widthMm / 25.4) + widthAllowanceIn) * 100) / 100;

    const ratios: number[] = Array.isArray(m.ratios) ? m.ratios.map((r: any) => Number(r) || 0) : [];
    const sumRatios = ratios.reduce((a, b) => a + b, 0);

    let fabricWtPerLayG = 0;
    let noOfPcsLay = 1;
    let avgWtPerPc = 0;
    let reqLengthPerPcCm = 0;

    if (!isWoven) {
      // KNIT MODE (Weight in Grams)
      const layerMultiplier = diaType === 'TUBE' ? 2 : 1;
      // Formula: LayLength(cm) * TableWidth(cm) * GSM / 10000 * layers
      fabricWtPerLayG = Math.round(((layLengthCm * (tableWidthIn * 2.54) * gsm / 10000.0) * layerMultiplier) * 1000) / 1000;
      noOfPcsLay = Math.max(1, sumRatios * layerMultiplier);
      const netWtG = fabricWtPerLayG / noOfPcsLay;
      avgWtPerPc = Math.round((netWtG * (1 + (fabricAllowancePct / 100.0))) * 10000) / 10000;
    } else {
      // WOVEN MODE (Length in CMS)
      noOfPcsLay = Math.max(1, sumRatios);
      const netLengthCm = layLengthCm / noOfPcsLay;
      reqLengthPerPcCm = Math.round((netLengthCm * (1 + (fabricAllowancePct / 100.0))) * 10000) / 10000;
    }

    // Colorway Totals
    const colorways = Array.isArray(m.colorways) ? m.colorways : [];
    let markerTotalReqQty = 0;

    const calculatedColorways = colorways.map((cw: any) => {
      const qtys: number[] = Array.isArray(cw.quantities) ? cw.quantities.map((q: any) => Number(q) || 0) : [];
      // Cut pcs with rejection ceiling: CEILING(qty * (1 + rej))
      const cutQtys = qtys.map((q) => Math.ceil(q * (1 + (rejectionPct / 100.0))));
      const totalOrderPcs = qtys.reduce((a, b) => a + b, 0);
      const totalCutPcs = cutQtys.reduce((a, b) => a + b, 0);

      let requiredQty = 0;
      if (!isWoven) {
        // KG = (avgWtG * totalCutPcs) / 1000
        requiredQty = Math.round(((avgWtPerPc * totalCutPcs) / 1000.0) * 1000) / 1000;
      } else {
        // MTRS = (reqLengthCm * totalCutPcs) / 100
        requiredQty = Math.round(((reqLengthPerPcCm * totalCutPcs) / 100.0) * 1000) / 1000;
      }

      markerTotalReqQty += requiredQty;

      return {
        ...cw,
        quantities: qtys,
        cut_quantities: cutQtys,
        total_order_pcs: totalOrderPcs,
        total_cut_pcs: totalCutPcs,
        required_qty: requiredQty,
        uom,
      };
    });

    return {
      ...m,
      lay_allowance_cm: layAllowanceCm,
      width_allowance_in: widthAllowanceIn,
      lay_length_cm: layLengthCm,
      table_width_in: tableWidthIn,
      fabric_wt_per_lay_g: fabricWtPerLayG,
      no_of_pcs_lay: noOfPcsLay,
      avg_wt_per_pc_g: avgWtPerPc,
      req_length_per_pc_cm: reqLengthPerPcCm,
      total_req_qty: Math.round(markerTotalReqQty * 100) / 100,
      uom,
      colorways: calculatedColorways,
    };
  });

  // Generate Consolidated Fabric Program (F.PRGM) and Cutting Lay Sheet (CUT)
  const fabricMap: Record<string, any> = {};

  calculatedMarkers.forEach((m: any) => {
    const fabKey = `${m.fabric_type || 'Main Fabric'}_${m.gsm || 0}_${m.fabric_dia_type || 'OPEN'}`;
    if (!fabricMap[fabKey]) {
      fabricMap[fabKey] = {
        fabric_type: m.fabric_type || 'Main Fabric',
        gsm: m.gsm || 160,
        dia_spec: `${m.fabric_dia_type || 'OPEN'}`,
        colorways: {},
      };
    }

    m.colorways.forEach((cw: any) => {
      const cName = cw.color_name || 'Solid';
      if (!fabricMap[fabKey].colorways[cName]) {
        fabricMap[fabKey].colorways[cName] = {
          order_pcs: 0,
          cut_pcs: 0,
          net_qty: 0,
        };
      }
      fabricMap[fabKey].colorways[cName].order_pcs += Number(cw.total_order_pcs) || 0;
      fabricMap[fabKey].colorways[cName].cut_pcs += Number(cw.total_cut_pcs) || 0;
      fabricMap[fabKey].colorways[cName].net_qty += Number(cw.required_qty) || 0;
    });
  });

  const fabricProgramLines: any[] = [];
  const cuttingLayLines: any[] = [];
  let grandTotalFabric = 0;
  let totalOrderPcs = 0;

  Object.values(fabricMap).forEach((fab: any) => {
    Object.entries(fab.colorways).forEach(([colorName, data]: [string, any]) => {
      const netVal = Math.round(data.net_qty * 10) / 10;
      // Buffer add-on in F.PRGM: rounded up to nearest whole or +5% safety
      const roundedNet = Math.ceil(netVal);
      const buffer = Math.max(1, Math.round(roundedNet * 0.02));
      const grandVal = roundedNet + buffer;

      grandTotalFabric += grandVal;
      totalOrderPcs += data.order_pcs;

      fabricProgramLines.push({
        fabric_type: fab.fabric_type,
        gsm: fab.gsm,
        dia_spec: fab.dia_spec,
        color_name: colorName,
        order_qty_pcs: data.order_pcs,
        net_qty: netVal,
        buffer_qty: buffer,
        grand_total_qty: grandVal,
        uom,
      });

      cuttingLayLines.push({
        fabric_type: fab.fabric_type,
        gsm: fab.gsm,
        dia_spec: fab.dia_spec,
        color_name: colorName,
        order_qty_pcs: data.cut_pcs,
        net_qty: netVal,
        buffer_qty: 0,
        grand_total_qty: netVal,
        uom,
      });
    });
  });

  const avgWtPerGarment = totalOrderPcs > 0 ? (grandTotalFabric / totalOrderPcs) : 0;
  const actWtPerGarment = avgWtPerGarment * (1 - (totalAllowancePct / 100.0));

  const calculationResult = {
    cad_type: cadType,
    uom,
    rejection_pct: rejectionPct,
    fabric_allowance_pct: fabricAllowancePct,
    total_allowance_pct: totalAllowancePct,
    markers: calculatedMarkers,
    fabric_program: fabricProgramLines,
    cutting_lay: cuttingLayLines,
    summary_metrics: {
      total_order_pcs: totalOrderPcs,
      grand_total_fabric: Math.round(grandTotalFabric * 100) / 100,
      avg_garment_consumption: Math.round(avgWtPerGarment * 10000) / 10000,
      act_garment_consumption: Math.round(actWtPerGarment * 10000) / 10000,
      uom,
    },
  };

  res.json({
    data: calculationResult,
  });
}));

/**
 * 6. POST /api/cad-requirements/import-excel
 * Parses any uploaded CAD Excel sheet (.xls / .xlsx) into structured CAD parameters
 */
cadRouter.post('/cad-requirements/import-excel', requirePermission('PRODUCTION.CREATE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const { file_data, file_name } = req.body;

  if (!file_data) throw BadRequest('Missing file_data (base64 string required)');

  const buf = Buffer.from(file_data, 'base64');
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true });

  const summarySheetName = wb.SheetNames.find((s) => s === 'F.PRGM' || s === 'FABRIC');
  const cutSheetName = wb.SheetNames.find((s) => s === 'CUT');
  const markerSheetNames = wb.SheetNames.filter((s) => s !== 'F.PRGM' && s !== 'FABRIC' && s !== 'CUT');

  const result: any = {
    file_name: file_name || 'CAD_Sheet.xls',
    sheets: wb.SheetNames,
    header: {},
    markers: [],
    special_notes: '',
  };

  // 1. First Marker header check
  const firstMarker = markerSheetNames.length > 0 ? wb.Sheets[markerSheetNames[0]] : null;
  if (firstMarker) {
    const getV = (c: string) => firstMarker[c]?.v ?? '';
    result.header.style_code = String(getV('B1')).trim();
    result.header.buyer_name = String(getV('B3')).trim();
    result.header.req_date = String(getV('B4')).trim();
  }

  // 2. Summary Sheet check (F.PRGM or FABRIC)
  if (summarySheetName) {
    const s = wb.Sheets[summarySheetName];
    const getV = (c: string) => s[c]?.v ?? '';

    if (!result.header.style_code) result.header.style_code = String(getV('C4')).trim();
    if (!result.header.internal_ir_no) result.header.internal_ir_no = String(getV('C5')).trim();
    if (!result.header.req_date) result.header.req_date = String(getV('N4') || getV('P4')).trim();

    // Rejection & Fabric allowance
    for (let r = 12; r <= 22; r++) {
      const lbl = String(getV('A' + r) || '').toUpperCase();
      if (lbl.includes('REJECTION')) {
        const val = Number(getV('B' + r));
        result.header.rejection_pct = val < 1 ? Math.round(val * 100) : val;
      }
      if (lbl.includes('FABRIC')) {
        const val = Number(getV('B' + r));
        result.header.fabric_allowance_pct = val < 1 ? Math.round(val * 100) : val;
      }
      for (const col of ['F', 'G', 'H']) {
        const noteVal = String(getV(col + r) || '').trim();
        if (noteVal && (noteVal.includes('NOTE') || noteVal.includes('WASH') || noteVal.includes('GRM') || noteVal.includes('TAPE') || noteVal.includes('CORD') || noteVal.includes('ZIP') || noteVal.includes('COLLAR'))) {
          result.special_notes += (result.special_notes ? '\n' : '') + noteVal;
        }
      }
    }
  }

  // Detect CAD Mode (WOVEN vs KNIT)
  const fnUpper = (file_name || '').toUpperCase();
  const isWoven = fnUpper.includes('WOVEN') || markerSheetNames.some((sn) => {
    const ms = wb.Sheets[sn];
    const fab = String(ms['B36']?.v || ms['D9']?.v || ms['B35']?.v || '').toUpperCase();
    return fab.includes('WOVEN') || fab.includes('SEER SUCKER') || fab.includes('VOILE');
  });

  result.header.cad_type = isWoven ? 'WOVEN' : (fnUpper.includes('ACNT') ? 'KNIT_FLEECE' : 'KNIT_SJ');
  result.header.uom = isWoven ? 'MTR' : 'KG';
  result.header.rejection_pct = result.header.rejection_pct ?? (isWoven ? 3.0 : 3.0);
  result.header.fabric_allowance_pct = result.header.fabric_allowance_pct ?? (isWoven ? 0.0 : 10.0);

  // Match Style with DB if exists
  if (result.header.style_code) {
    const dbStyle = await queryOne<any>(`
      SELECT id, style_code, style_name, buyer_id FROM mst_style
       WHERE (style_code = ? OR style_code LIKE ?) AND company_id = ?
       LIMIT 1
    `, [result.header.style_code, `%${result.header.style_code}%`, companyId]);

    if (dbStyle) {
      result.header.style_id = dbStyle.id;
      result.header.buyer_id = dbStyle.buyer_id;
    }
  }

  // 3. Parse Markers
  markerSheetNames.forEach((sn, idx) => {
    const ms = wb.Sheets[sn];
    const getV = (c: string) => ms[c]?.v ?? '';

    const markerRef = String(getV('B2') || sn).trim();
    const lengthMm = Number(getV('B5')) || 0;
    const widthMm = Number(getV('B6')) || 0;
    const diaType = String(getV('B35') || getV('L4') || 'OPEN').toUpperCase().includes('TUBE') ? 'TUBE' : 'OPEN';
    const direction = String(getV('B34') || getV('D8') || 'ONEWAY').trim();
    const fabricType = String(getV('B36') || getV('D9') || getV('B35') || '').trim();
    const gsm = Number(getV('B37') || getV('K9') || getV('J26')) || (isWoven ? 100 : 160);
    const partsInLay = String(getV('B38') || getV('D10') || '').trim();

    // Sizes & Ratio
    const sizes: string[] = [];
    const ratios: number[] = [];
    ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].forEach((col) => {
      const sz = getV(col + '5');
      const rt = Number(getV(col + '6')) || 0;
      if (sz && sz !== '.' && sz !== '') {
        sizes.push(String(sz));
        ratios.push(rt);
      }
    });

    if (sizes.length === 0) {
      ['B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15'].forEach((c, i) => {
        const sz = getV(c);
        const rt = Number(getV('B' + (16 + i))) || 0;
        if (sz && sz !== '.' && sz !== '') {
          sizes.push(String(sz));
          ratios.push(rt);
        }
      });
    }

    // Colorway Order Rows (row 39 onwards)
    const colorways: any[] = [];
    for (let r = 39; r <= 120; r += 9) {
      const colorName = String(getV('A' + r) || '').trim();
      if (colorName && colorName !== '.' && colorName !== '-' && isNaN(Number(colorName))) {
        const sizeQtys: number[] = [];
        for (let sIdx = 0; sIdx < sizes.length; sIdx++) {
          const q = Number(getV('B' + (r + sIdx))) || 0;
          sizeQtys.push(q);
        }
        const totalPcs = sizeQtys.reduce((a, b) => a + b, 0);
        if (totalPcs > 0 || colorways.length === 0) {
          colorways.push({ color_name: colorName, quantities: sizeQtys, total_order_pcs: totalPcs });
        }
      }
    }

    const layLengthCm = Number(getV('J24') || getV('J23')) || (lengthMm / 10 + 10);
    const tableWidthIn = Number(getV('J25') || getV('J24')) || (widthMm / 25.4 + (diaType === 'TUBE' ? 1 : 2));
    const fabricWtPerLay = Number(getV('J27')) || 0;
    const noOfPcsLay = Number(getV('J28') || getV('J25')) || 1;
    const avgWtPerPc = Number(getV('J29')) || 0;
    const reqLengthPerPc = Number(getV('J26')) || 0;
    const totalReqQty = Number(getV('J30') || getV('J27')) || 0;

    result.markers.push({
      marker_ref: markerRef,
      marker_name: `${result.header.style_code} ${markerRef}`,
      length_mm: lengthMm,
      width_mm: widthMm,
      fabric_dia_type: diaType,
      fabric_type: fabricType,
      gsm: gsm,
      direction: direction,
      parts_in_lay: partsInLay,
      lay_allowance_cm: 10,
      width_allowance_in: diaType === 'TUBE' ? 1 : 2,
      lay_length_cm: layLengthCm,
      table_width_in: tableWidthIn,
      fabric_wt_per_lay_g: fabricWtPerLay,
      no_of_pcs_lay: noOfPcsLay,
      avg_wt_per_pc_g: avgWtPerPc,
      req_length_per_pc_cm: reqLengthPerPc,
      total_req_qty: totalReqQty,
      uom: isWoven ? 'MTR' : 'KG',
      sizes,
      ratios,
      colorways,
      sort_order: idx + 1,
    });
  });

  res.json({ data: result });
}));

/**
 * 7. POST /api/cad-requirements/:id/approve
 * Approves requirement and generates Material Requirement & active BOM lines
 */
cadRouter.post('/cad-requirements/:id/approve', requirePermission('PRODUCTION.APPROVE'), ah(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.id;
  const id = Number(req.params.id);
  const { data_json, total_fabric_kg, total_fabric_mtrs, total_yarn_kg } = req.body;

  const cr = await queryOne<any>(`
    SELECT * FROM trx_cad_requirement WHERE id = ? AND company_id = ?
  `, [id, companyId]);

  if (!cr) throw NotFound('CAD Requirement not found');

  const isWoven = cr.cad_type === 'WOVEN' || cr.uom === 'MTR';
  const finalFabricQty = Number(isWoven ? (total_fabric_mtrs || total_fabric_kg) : (total_fabric_kg || 0));

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
      finalFabricQty,
      Number(total_yarn_kg || 0),
      JSON.stringify(data_json || {}),
      userId,
    ]);

    // Auto-sync into active BOM for this style
    const activeBom = await txQueryOne<any>(tx, `
      SELECT id FROM trx_bom WHERE company_id = ? AND style_id = ? AND is_active = 1
      ORDER BY version DESC, id DESC LIMIT 1
    `, [companyId, cr.style_id]);

    if (activeBom) {
      const orderQty = Number(cr.order_qty) || 1000;
      const fCons = finalFabricQty > 0 ? Number((finalFabricQty / orderQty).toFixed(5)) : (isWoven ? 0.65 : 0.82);
      const yCons = isWoven ? 0 : Number((fCons * 1.05).toFixed(5));

      const defFabric = await txQueryOne<any>(tx, `SELECT id, base_uom FROM mst_fabric WHERE company_id = ? AND is_active = 1 LIMIT 1`, [companyId]);
      const defYarn = await txQueryOne<any>(tx, `SELECT id, base_uom FROM mst_yarn WHERE company_id = ? AND is_active = 1 LIMIT 1`, [companyId]);

      const targetUomCode = isWoven ? 'MTR' : 'KG';
      const uomRow = await txQueryOne<any>(tx, `SELECT id FROM cfg_uom WHERE (code = ? OR code = 'MTRS' OR code = 'KGS') LIMIT 1`, [targetUomCode]);
      const uId = uomRow?.id || defFabric?.base_uom || 1;

      const existFab = await txQueryOne<any>(tx, `SELECT id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'FABRIC' LIMIT 1`, [activeBom.id]);
      if (existFab) {
        await txExecute(tx, `UPDATE trx_bom_line SET consumption = ?, uom_id = ?, remarks = CONCAT('CAD Auto-Synced (${targetUomCode}): ', ?) WHERE id = ?`, [fCons, uId, cr.req_no || 'CAD', existFab.id]);
      } else if (defFabric) {
        await txExecute(tx, `INSERT INTO trx_bom_line (bom_id, material_type, fabric_id, consumption, uom_id, wastage_pct, remarks) VALUES (?, 'FABRIC', ?, ?, ?, 5.0, ?)`, [activeBom.id, defFabric.id, fCons, uId, `CAD Auto-Synced (${cr.req_no || 'CAD'})`]);
      }

      if (!isWoven) {
        const existYrn = await txQueryOne<any>(tx, `SELECT id FROM trx_bom_line WHERE bom_id = ? AND material_type = 'YARN' LIMIT 1`, [activeBom.id]);
        if (existYrn) {
          await txExecute(tx, `UPDATE trx_bom_line SET consumption = ?, remarks = CONCAT('CAD Auto-Synced: ', ?) WHERE id = ?`, [yCons, cr.req_no || 'CAD', existYrn.id]);
        } else if (defYarn) {
          await txExecute(tx, `INSERT INTO trx_bom_line (bom_id, material_type, yarn_id, consumption, uom_id, wastage_pct, remarks) VALUES (?, 'YARN', ?, ?, ?, 3.0, ?)`, [activeBom.id, defYarn.id, yCons, uId, `CAD Auto-Synced (${cr.req_no || 'CAD'})`]);
        }
      }
    }
  });

  await audit(req, 'trx_cad_requirement', id, 'UPDATE', null, { status: 'APPROVED', cad_version: cr.cad_version });

  res.json({ data: { status: 'APPROVED', cad_req_id: id } });
}));
