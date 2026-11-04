/**
 * Lab PDFs (pdfkit, built-in Helvetica): the A4 portrait lab report — built only from the frozen report snapshot plus
 * the (append-only) approval rows, so regenerating never changes a value — and the sample label with its QR code.
 * Every report page carries the report no, revision and "Page x of y"; anything not dual-approved carries a
 * "not valid for bulk production" watermark (spec §10).
 */
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';

const A4_W = 595.28;
const A4_H = 841.89;
const M = 34;
const W = A4_W - 2 * M;
const BOTTOM = A4_H - M - 24;
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#9ca3af';
const HEAD_BG = '#eef2f7';
const OK = '#047857';
const BAD = '#b91c1c';
const WARN = '#b45309';

const EXTRA = new Set(['—', '–', '‘', '’', '“', '”', '•', '…', '±', '°', '²', '×']);
/** Built-in fonts are WinAnsi: keep Latin-1 + common punctuation; anything else becomes '?'. */
export function t(v: unknown): string {
  return String(v ?? '').replace(/₹\s?/g, 'Rs. ').replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .split('').map((ch) => (ch === '\n' || (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0xff) || EXTRA.has(ch) ? ch : '?')).join('');
}
const d10 = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 10) : '');
const d16 = (v: unknown) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
const num = (v: unknown, dp = 2) => (v == null || v === '' ? '' : Number(v).toFixed(dp).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m)));

interface Col { h: string; w: number; align?: 'left' | 'right' | 'center' }

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export interface ReportPdfInput {
  report: { report_no: string; revision_no: number; report_status: string; overall_result: string | null; disposition: string | null; prepared_at: string;
    qa_approved_at: string | null; released_at: string | null; conditional_reason: string | null; conditional_scope: string | null; conditional_expiry: string | null;
    recommendation: string | null; revision_reason: string | null; snapshot_hash: string };
  snapshot: any;
  approvals: { approval_level: string; approver_name: string | null; approver_roles: string | null; decision: string; remarks: string | null; decided_at: string; report_revision: number; override_used: number }[];
  images: { caption: string; path: string; mime: string }[];
}

export async function renderLabReportPdf(inp: ReportPdfInput): Promise<Buffer> {
  const { report: r, snapshot: s } = inp;
  const valid = ['APPROVED', 'RELEASED'].includes(r.report_status);
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `Lab report ${r.report_no} rev ${r.revision_no}`, Author: t(s.company?.name ?? '') } });
  const done = collect(doc);
  doc.font('Helvetica').fillColor(INK);
  let y = M;

  const ensure = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const section = (title: string) => {
    ensure(40);
    y += 6;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(t(title.toUpperCase()), M, y, { width: W });
    y += 13;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 4;
  };
  const kv = (pairs: [string, unknown][], cols = 2) => {
    const cw = W / cols;
    for (let i = 0; i < pairs.length; i += cols) {
      const row = pairs.slice(i, i + cols);
      const hs = row.map(([, v]) => doc.font('Helvetica').fontSize(8.5).heightOfString(t(v || '—'), { width: cw - 92 }));
      const h = Math.max(12, ...hs) + 2;
      ensure(h);
      row.forEach(([k, v], j) => {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(t(k), M + j * cw, y, { width: 88 });
        doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(t(v || '—'), M + j * cw + 90, y, { width: cw - 92 });
      });
      y += h;
    }
  };
  const table = (cols: Col[], rows: { cells: string[]; colors?: (string | null)[] }[], fs = 7.6) => {
    const total = cols.reduce((a, c) => a + c.w, 0);
    const ws = cols.map((c) => (c.w / total) * W);
    const head = () => {
      const hh = Math.max(...cols.map((c, i) => doc.font('Helvetica-Bold').fontSize(fs).heightOfString(t(c.h), { width: ws[i] - 6 }))) + 6;
      ensure(hh + 14);
      doc.rect(M, y, W, hh).fill(HEAD_BG);
      let x = M;
      cols.forEach((c, i) => { doc.font('Helvetica-Bold').fontSize(fs).fillColor(INK).text(t(c.h), x + 3, y + 3, { width: ws[i] - 6, align: c.align ?? 'left' }); x += ws[i]; });
      y += hh;
    };
    head();
    if (!rows.length) { doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text('None', M + 3, y + 3); y += 14; return; }
    for (const row of rows) {
      const rh = Math.max(...row.cells.map((c, i) => doc.font('Helvetica').fontSize(fs).heightOfString(t(c || ''), { width: ws[i] - 6 }))) + 5;
      if (y + rh > BOTTOM) { doc.addPage(); y = M; head(); }
      let x = M;
      row.cells.forEach((c, i) => {
        const col = row.colors?.[i];
        doc.font(col ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(col ?? INK).text(t(c || ''), x + 3, y + 2.5, { width: ws[i] - 6, align: cols[i].align ?? 'left' });
        x += ws[i];
      });
      y += rh;
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.3).strokeColor('#d1d5db').stroke();
    }
    y += 2;
  };
  const para = (text: string, color = INK, size = 8.5) => {
    const h = doc.font('Helvetica').fontSize(size).heightOfString(t(text), { width: W });
    ensure(h + 4);
    doc.fillColor(color).text(t(text), M, y, { width: W });
    y += h + 4;
  };

  /* ---------- header */
  const co = s.company ?? {};
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(t(co.name ?? ''), M, y, { width: W * 0.62 });
  const addr = [co.address, co.phone ? `Ph ${co.phone}` : '', co.email].filter(Boolean).join(' · ');
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(t(addr), M, y + 17, { width: W * 0.62 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text('LAB TEST REPORT', M + W * 0.62, y, { width: W * 0.38, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(INK)
    .text(t(`Report No: ${r.report_no}   Rev ${r.revision_no}`), M + W * 0.5, y + 16, { width: W * 0.5, align: 'right' })
    .text(t(`Issue date: ${d10(r.released_at ?? r.qa_approved_at ?? r.prepared_at)}`), M + W * 0.5, y + 27, { width: W * 0.5, align: 'right' })
    .text(t(`Status: ${r.report_status.replace(/_/g, ' ')}`), M + W * 0.5, y + 38, { width: W * 0.5, align: 'right' });
  y += 52;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(INK).stroke();
  y += 4;
  if (!valid) {
    doc.rect(M, y, W, 15).fill('#fef3c7');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(WARN).text('UNAPPROVED DRAFT — NOT VALID FOR BULK PRODUCTION', M, y + 4, { width: W, align: 'center' });
    y += 19;
  }
  if (r.revision_reason) para(`Revision ${r.revision_no}: ${r.revision_reason}`, MUTED, 8);

  /* ---------- reference */
  const q = s.request ?? {}; const tr = s.trial ?? {};
  section('Reference');
  kv([
    ['Buyer', q.buyer_name], ['Buyer PO', q.buyer_po_no], ['Order (I/O)', q.job_no], ['Style', [q.style_code, q.style_name].filter(Boolean).join(' — ')],
    ['Colour', q.color_name], ['Product / item', q.item_description ?? q.product_name], ['Fabric', q.fabric_name], ['Composition / GSM', [q.composition, q.gsm ? `${num(q.gsm)} GSM` : ''].filter(Boolean).join(' · ')],
    ['Fabric lot', q.fabric_lot], ['Lab request', `${q.request_no ?? ''}${q.is_development ? ` (development ${q.development_ref ?? ''})` : ''}`],
    ['Sample ID(s)', (s.samples ?? []).map((x: any) => x.sample_no).join(', ')], ['Sample received', (s.samples ?? []).map((x: any) => d10(x.received_at)).filter(Boolean).join(', ')],
    ['Trial', `${tr.trial_no ?? ''} · ${String(tr.trial_type ?? '').replace(/_/g, ' ')} · recipe rev ${tr.recipe_revision ?? ''}`], ['Test date', `${d10(tr.started_at)}${tr.completed_at ? ` to ${d10(tr.completed_at)}` : ''}`],
    ['Test plan', s.plan ? `${s.plan.plan_code} v${s.plan.version_no} — ${s.plan.name}` : ''], ['Test scope', (q.test_scope ?? []).join(', ')],
  ]);

  /* ---------- process */
  section('Wash / treatment process');
  kv([
    ['Wash type', tr.wash_process_name ?? tr.wash_process_code], ['Machine', tr.machine ? `${tr.machine.machine_code} — ${tr.machine.name}` : ''],
    ['Load weight', tr.load_weight_kg != null ? `${num(tr.load_weight_kg, 3)} kg` : ''], ['Water', tr.water_qty_l != null ? `${num(tr.water_qty_l, 2)} L` : ''],
    ['Liquor ratio', tr.liquor_ratio != null ? `1 : ${num(tr.liquor_ratio, 2)}` : ''], ['Total time', tr.total_duration_min != null ? `${num(tr.total_duration_min)} min` : ''],
    ['Drying', [tr.drying_method, tr.drying_temp != null ? `${num(tr.drying_temp)} °C` : '', tr.drying_duration_min != null ? `${num(tr.drying_duration_min)} min` : ''].filter(Boolean).join(' · ')],
    ['Finish', tr.finish_notes], ['Technician', tr.technician_name], ['Operator', tr.operator_name],
  ]);
  if ((s.stages ?? []).length) {
    y += 3;
    table([{ h: '#', w: 4, align: 'right' }, { h: 'Stage', w: 14 }, { h: 'Temp °C T / A', w: 12, align: 'right' }, { h: 'Time min T / A', w: 12, align: 'right' },
      { h: 'Water L', w: 8, align: 'right' }, { h: 'L:R', w: 7, align: 'right' }, { h: 'pH start / end', w: 11, align: 'right' }, { h: 'RPM', w: 6, align: 'right' }, { h: 'Notes', w: 20 }],
    s.stages.map((x: any) => ({ cells: [String(x.stage_no), x.process_code, `${num(x.target_temp)} / ${num(x.actual_temp)}`, `${num(x.target_duration_min)} / ${num(x.actual_duration_min)}`,
      num(x.water_qty_l), x.liquor_ratio != null ? `1:${num(x.liquor_ratio)}` : '', `${num(x.ph_start)} / ${num(x.ph_end)}`, num(x.rpm), x.notes ?? ''] })));
  }
  if ((s.chemicals ?? []).length) {
    table([{ h: 'Stage', w: 6, align: 'right' }, { h: 'Chemical', w: 30 }, { h: 'Lot', w: 12 }, { h: 'Target dosage', w: 12, align: 'right' }, { h: 'Actual dosage', w: 12, align: 'right' }, { h: 'Unit', w: 8 }, { h: 'Added at', w: 12 }],
      s.chemicals.map((c: any) => ({ cells: [c.stage_no != null ? String(c.stage_no) : '', c.chemical_name, c.chemical_lot ?? '', num(c.target_dosage, 4), num(c.actual_dosage, 4),
        String(c.dosage_uom ?? '').replace('G_L', 'g/l').replace('ML_L', 'ml/l').replace('PCT_OWG', '% owg'), c.added_at ?? ''] })));
  }

  /* ---------- results */
  section('Test results');
  const statusColor = (st: string) => (st === 'PASS' ? OK : st === 'FAIL' ? BAD : st === 'BORDERLINE' ? WARN : null);
  table([{ h: 'Test', w: 24 }, { h: 'Method', w: 12 }, { h: 'Unit', w: 6 }, { h: 'Acceptance', w: 15 }, { h: 'Before', w: 8, align: 'right' }, { h: 'After', w: 8, align: 'right' },
    { h: 'Result', w: 10, align: 'right' }, { h: 'Status', w: 11 }],
  (s.results ?? []).map((x: any) => ({
    cells: [`${x.name}${x.is_mandatory ? '' : ' (optional)'}${x.result_source === 'EXTERNAL' ? ` [external: ${x.external_lab_name ?? ''} cert ${x.certificate_no ?? ''}]` : ''}`,
      [x.method_code, x.standard_reference].filter(Boolean).join(' · '), x.unit ?? '', x.criteria_text ?? '', x.raw_before != null ? num(x.raw_before, 3) : '',
      x.raw_after != null ? num(x.raw_after, 3) : '', x.display_value ?? '', `${String(x.evaluation_status).replace(/_/g, ' ')}${x.is_override ? ' (override)' : ''}`],
    colors: [null, null, null, null, null, null, null, statusColor(x.evaluation_status)],
  })));
  const readings = (s.results ?? []).filter((x: any) => (x.readings ?? []).length);
  if (readings.length) {
    ensure(30);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Raw readings', M, y); y += 11;
    for (const x of readings) para(`${x.name}: ${x.readings.map((g: any) => `${g.reading_stage === 'SINGLE' ? '' : g.reading_stage[0]}${g.reading_no} ${g.text_value ?? num(g.numeric_value, 3)}`).join(' · ')}`, MUTED, 7.5);
  }
  const overrides = (s.results ?? []).filter((x: any) => x.is_override);
  for (const o of overrides) para(`Override — ${o.name}: calculated ${o.calc_status}, set to ${o.evaluation_status}. Reason: ${o.override_reason ?? ''}`, WARN, 7.8);
  const obs = (s.results ?? []).filter((x: any) => x.observation);
  if (obs.length) { section('Observations'); for (const o of obs) para(`${o.name}: ${o.observation}`); }

  /* ---------- deviations */
  if ((s.deviations ?? []).length) {
    section('Deviations');
    table([{ h: 'Stage', w: 6 }, { h: 'Type', w: 12 }, { h: 'Target', w: 10 }, { h: 'Actual', w: 10 }, { h: 'Reason', w: 30 }, { h: 'Corrective action', w: 30 }],
      s.deviations.map((x: any) => ({ cells: [x.stage_no != null ? String(x.stage_no) : '', x.deviation_type, x.target_value ?? '', x.actual_value ?? '', x.reason, x.corrective_action ?? ''] })));
  }

  /* ---------- evidence */
  if ((s.attachments ?? []).length) {
    section('Evidence');
    table([{ h: 'Type', w: 14 }, { h: 'File', w: 40 }, { h: 'Caption', w: 30 }, { h: 'Uploaded', w: 14 }],
      s.attachments.map((a: any) => ({ cells: [String(a.attachment_type).replace(/_/g, ' '), a.original_name, a.caption ?? '', d16(a.uploaded_at)] })));
    const imgs = inp.images.slice(0, 6);
    const iw = (W - 12) / 3; const ih = iw * 0.75;
    for (let i = 0; i < imgs.length; i += 3) {
      ensure(ih + 16);
      imgs.slice(i, i + 3).forEach((im, j) => {
        try { doc.image(fs.readFileSync(im.path), M + j * (iw + 6), y, { fit: [iw, ih], align: 'center', valign: 'center' }); } catch { /* unreadable image: skip */ }
        doc.rect(M + j * (iw + 6), y, iw, ih).lineWidth(0.4).strokeColor(LINE).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(t(im.caption), M + j * (iw + 6), y + ih + 2, { width: iw, align: 'center' });
      });
      y += ih + 14;
    }
  }

  /* ---------- disposition */
  section('Disposition');
  const overall = r.overall_result ?? s.overall_result ?? 'INCOMPLETE';
  ensure(18);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(overall === 'PASS' ? OK : overall === 'FAIL' ? BAD : WARN)
    .text(t(`Overall result: ${overall}${r.disposition ? `   ·   Disposition: ${r.disposition.replace(/_/g, ' ')}` : ''}`), M, y, { width: W });
  y += 16;
  if (r.disposition === 'CONDITIONAL') para(`Conditional approval — reason: ${r.conditional_reason ?? ''}; scope: ${r.conditional_scope ?? ''}; valid until ${d10(r.conditional_expiry)}`, WARN);
  if (r.recommendation) para(`Recommendation: ${r.recommendation}`);

  /* ---------- approvals */
  section('Approvals');
  const lab = [...inp.approvals].reverse().find((a) => a.approval_level === 'LAB' && a.report_revision === r.revision_no);
  const qa = [...inp.approvals].reverse().find((a) => a.approval_level === 'QA' && a.report_revision === r.revision_no);
  table([{ h: 'Step', w: 18 }, { h: 'Name', w: 22 }, { h: 'Decision', w: 14 }, { h: 'Date / time', w: 16 }, { h: 'Remarks', w: 30 }], [
    { cells: ['Prepared by (technician)', s.prepared_by_name ?? '', 'SUBMITTED', d16(s.submitted_at), ''] },
    { cells: ['Lab In-charge', lab?.approver_name ?? '', lab?.decision ?? 'PENDING', d16(lab?.decided_at), `${lab?.remarks ?? ''}${lab?.override_used ? ' [maker-checker override]' : ''}`] },
    { cells: ['QA Manager', qa?.approver_name ?? '', qa?.decision ?? 'PENDING', d16(qa?.decided_at), `${qa?.remarks ?? ''}${qa?.override_used ? ' [maker-checker override]' : ''}`] },
  ]);
  para(`Snapshot reference: ${r.snapshot_hash.slice(0, 16)} · This report reflects the sample(s) tested only.`, MUTED, 7);

  /* ---------- footer + watermark on every page */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (!valid) {
      doc.save().rotate(-35, { origin: [A4_W / 2, A4_H / 2] }).font('Helvetica-Bold').fontSize(46).fillColor('#dc2626').opacity(0.08)
        .text('NOT VALID FOR BULK PRODUCTION', 0, A4_H / 2 - 30, { width: A4_W, align: 'center' }).restore();
      doc.opacity(1);
    }
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(t(`${r.report_no} · Rev ${r.revision_no} · ${valid ? 'Approved report' : 'Draft — not valid for bulk production'}`), M, A4_H - M - 10, { width: W / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, M + W / 2, A4_H - M - 10, { width: W / 2, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}

/** 100 × 50 mm sample label: QR (secure token only) + Sample ID, request, style, colour, type. */
export async function renderSampleLabel(x: { sample_no: string; qr_token: string; request_no: string; style_code?: string | null; color_name?: string | null;
  sample_type: string; received_qty: number | string; uom: string; received_at?: string | null }): Promise<Buffer> {
  const mm = 72 / 25.4;
  const doc = new PDFDocument({ size: [100 * mm, 50 * mm], margin: 0 });
  const done = collect(doc);
  const png = await QRCode.toBuffer(`LAB:S:${x.qr_token}`, { type: 'png', margin: 0, width: 240, errorCorrectionLevel: 'M' });
  doc.image(png, 4 * mm, 6 * mm, { width: 38 * mm });
  const tx = 45 * mm; const tw = 52 * mm;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(t(x.sample_no), tx, 6 * mm, { width: tw });
  doc.font('Helvetica').fontSize(8.5)
    .text(t(`Request: ${x.request_no}`), tx, 14 * mm, { width: tw })
    .text(t(`Style: ${x.style_code ?? '—'}`), tx, 19 * mm, { width: tw })
    .text(t(`Colour: ${x.color_name ?? '—'}`), tx, 24 * mm, { width: tw })
    .text(t(`Type: ${String(x.sample_type).replace(/_/g, ' ')}`), tx, 29 * mm, { width: tw })
    .text(t(`Qty: ${Number(x.received_qty)} ${x.uom} · ${d10(x.received_at)}`), tx, 34 * mm, { width: tw });
  doc.end();
  return done;
}
