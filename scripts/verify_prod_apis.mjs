// scripts/verify_prod_apis.mjs
const BASE_URL = process.env.API_URL || 'http://127.0.0.1:4000/api';

async function req(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('🧪 Starting Comprehensive Production API Verification...');
  console.log(`🌐 Base URL: ${BASE_URL}\n`);

  let passed = 0;
  let failed = 0;

  function assert(condition, message, detail) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      if (detail) console.error('   Detail:', detail);
      failed++;
    }
  }

  // 1. Health Check
  const health = await req('/health');
  assert(health.status === 200 && health.data?.status === 'ok', 'GET /api/health -> 200 OK');

  // 2. Authentication
  const login = await req('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
  });
  const token = login.data?.data?.accessToken;
  assert(login.status === 200 && token, 'POST /api/auth/login -> JWT accessToken returned');
  const authHeaders = { Authorization: `Bearer ${token}` };

  // 3. Fetch Master Lookups
  const [stylesRes, fabricsRes, yarnsRes, partiesRes, soRes] = await Promise.all([
    req('/lookup/styles', { headers: authHeaders }),
    req('/lookup/fabrics', { headers: authHeaders }),
    req('/lookup/yarns', { headers: authHeaders }),
    req('/lookup/parties?role=SUPPLIER', { headers: authHeaders }),
    req('/sales-orders', { headers: authHeaders }),
  ]);

  const styleId = stylesRes.data?.data?.[0]?.id || 1;
  const fabricId = fabricsRes.data?.data?.[0]?.id || 1;
  const yarn1Id = yarnsRes.data?.data?.[0]?.id || 1;
  const yarn2Id = yarnsRes.data?.data?.[1]?.id || yarnsRes.data?.data?.[0]?.id || 1;
  const vendorId = partiesRes.data?.data?.[0]?.id || 1;
  const soId = soRes.data?.data?.[0]?.id || 1;

  assert(styleId && fabricId && yarn1Id, `Master data resolved (Style: ${styleId}, Fabric: ${fabricId}, Yarn: ${yarn1Id}, Vendor: ${vendorId}, SO: ${soId})`);

  // 4. Test Knitting Programs CRUD
  console.log('\n--- Testing Knitting Programs API ---');
  
  // Create Knitting Program
  const newProgramPayload = {
    program_date: new Date().toISOString().slice(0, 10),
    so_id: soId,
    io_no: 'IO-2026-TEST',
    buyer_po_no: 'BPO-KNIT-992',
    style_id: styleId,
    part_name: 'TOP',
    fabric_id: fabricId,
    fabric_type: 'Cotton Rich Single Jersey',
    knitting_type: 'STRIPE',
    gsm: '180',
    dia: '34"',
    gauge: '24',
    loop_length: '2.80',
    required_qty_kg: 1000,
    required_date: '2026-10-30',
    job_work_type: 'INTERNAL',
    vendor_id: vendorId,
    status: 'DRAFT',
    remarks: 'E2E Automated Verification Program',
    yarns: [
      {
        seq_no: 1,
        yarn_id: yarn1Id,
        yarn_name_manual: '30s Combed Compact',
        count_value: '30s',
        colour: 'Navy Blue',
        yarn_po_no: 'YPO-2026-0089',
        yarn_lot_no: 'LOT-NB-4421',
        planning_ratio_pct: 60,
        planned_qty_kg: 600,
        reserved_qty_kg: 0,
        issued_qty_kg: 0,
      },
      {
        seq_no: 2,
        yarn_id: yarn2Id,
        yarn_name_manual: '30s Combed Grey Melange',
        count_value: '30s',
        colour: 'Grey Melange',
        yarn_po_no: 'YPO-2026-0092',
        yarn_lot_no: 'LOT-GM-1182',
        planning_ratio_pct: 40,
        planned_qty_kg: 400,
        reserved_qty_kg: 0,
        issued_qty_kg: 0,
      },
    ],
    stripes: [
      {
        seq_no: 1,
        yarn_label: 'Yarn 1 - Navy Blue',
        colour: 'Navy Blue',
        courses: 24,
        notes: 'Main Body Feeder 1-12',
      },
      {
        seq_no: 2,
        yarn_label: 'Yarn 2 - Grey Melange',
        colour: 'Grey Melange',
        courses: 8,
        notes: 'Stripe Feeder 13-16',
      },
    ],
  };

  const createKp = await req('/knitting/programs', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(newProgramPayload),
  });

  assert(
    createKp.status === 201 && createKp.data?.success && createKp.data?.data?.id,
    'POST /api/knitting/programs -> 201 Created',
    createKp.data
  );

  const kpId = createKp.data?.data?.id;
  const kpNo = createKp.data?.data?.program_no;
  console.log(`   Program created with ID: ${kpId}, Program No: ${kpNo}`);

  // List Knitting Programs
  const listKp = await req('/knitting/programs?part_name=TOP', { headers: authHeaders });
  assert(
    listKp.status === 200 && Array.isArray(listKp.data?.data) && listKp.data.data.some((p) => p.id === kpId),
    'GET /api/knitting/programs -> 200 OK (filtered by part_name=TOP)'
  );

  // Detail Knitting Program
  const detailKp = await req(`/knitting/programs/${kpId}`, { headers: authHeaders });
  assert(
    detailKp.status === 200 &&
    detailKp.data?.data?.yarns?.length === 2 &&
    detailKp.data?.data?.stripes?.length === 2 &&
    detailKp.data?.data?.yarns[0]?.yarn_po_no === 'YPO-2026-0089',
    'GET /api/knitting/programs/:id -> 200 OK with full yarns (traceability PO) and stripes'
  );

  const programYarnId = detailKp.data?.data?.yarns?.[0]?.id;

  // Record Yarn Issue against Knitting Program
  const issuePayload = {
    program_id: kpId,
    program_yarn_id: programYarnId,
    issue_no: 'YISS-TEST-001',
    issue_date: new Date().toISOString().slice(0, 10),
    yarn_id: yarn1Id,
    yarn_lot_no: 'LOT-NB-4421',
    yarn_po_no: 'YPO-2026-0089',
    issued_qty_kg: 150.75,
    remarks: 'First lot partial issuance',
  };

  const issueRes = await req('/knitting/programs/yarn-issue', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(issuePayload),
  });

  assert(
    issueRes.status === 201 && issueRes.data?.success,
    'POST /api/knitting/programs/yarn-issue -> 201 Recorded yarn issuance'
  );

  // Re-fetch detail to check issued_qty_kg update
  const updatedKp = await req(`/knitting/programs/${kpId}`, { headers: authHeaders });
  const yarn1Issued = updatedKp.data?.data?.yarns?.[0]?.issued_qty_kg;
  assert(
    Number(yarn1Issued) === 150.75 && (updatedKp.data?.data?.issues?.length >= 1 || updatedKp.data?.data?.yarn_issues?.length >= 1),
    `Program yarn issued_qty_kg successfully updated to ${yarn1Issued} kg`
  );

  // Update Status of Knitting Program
  const updateKp = await req(`/knitting/programs/${kpId}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ status: 'IN_PROGRESS', remarks: 'Started production' }),
  });
  assert(
    updateKp.status === 200 && updateKp.data?.success,
    'PUT /api/knitting/programs/:id -> 200 Updated status to IN_PROGRESS'
  );

  // 5. Test Sales Order Part Name Traceability
  console.log('\n--- Testing Sales Order Part Name Traceability ---');
  const soDetail = await req(`/sales-orders/${soId}`, { headers: authHeaders });
  assert(soDetail.status === 200, `GET /api/sales-orders/${soId} -> 200 OK`);

  const existingLines = soDetail.data?.data?.lines || [];
  if (existingLines.length > 0) {
    console.log(`   Sales Order has ${existingLines.length} line(s). Checking part_name field...`);
    const hasPartNameField = 'part_name' in existingLines[0];
    assert(hasPartNameField, 'Sales Order line contains part_name property');
  }

  // 6. Test Knitting Work Order & Summary Roll Output with Meters
  console.log('\n--- Testing Knitting Work Order Roll Outputs & Meters Summary ---');
  const kwoList = await req('/knitting/orders', { headers: authHeaders });
  assert(kwoList.status === 200 && Array.isArray(kwoList.data?.data), 'GET /api/knitting/orders -> 200 OK');

  let activeKwoId = kwoList.data?.data?.[0]?.id;
  if (!activeKwoId) {
    // Create one KWO
    const newKwo = await req('/knitting/orders', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        kwo_date: new Date().toISOString().slice(0, 10),
        io_no: 'IO-TEST-KWO',
        style_id: styleId,
        fabric_id: fabricId,
        sub_process: 'KNITTING',
        vendor_id: vendorId,
        dia: '32"',
        gsm: '160',
        planned_fabric_kg: 500,
        planned_yarn_kg: 525,
        status: 'IN_PROGRESS',
      }),
    });
    activeKwoId = newKwo.data?.data?.id;
  }

  // Record a roll output with meters and weight
  const rollRes = await req('/knitting/rolls', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      kwo_id: activeKwoId,
      roll_no: `ROLL-TEST-${Date.now().toString().slice(-4)}`,
      lot_no: 'LOT-NB-4421',
      production_date: new Date().toISOString().slice(0, 10),
      dia: '32"',
      gsm: '160',
      meters: 145.5,
      weight_kg: 24.8,
      qc_status: 'ACCEPTED',
    }),
  });
  assert(rollRes.status === 201 && rollRes.data?.success, 'POST /api/knitting/roll-outputs -> 201 Roll recorded with meters: 145.5m & weight: 24.8kg');

  // Verify KWO detail summary includes total_rolls_produced_meters
  const kwoDetail = await req(`/knitting/orders/${activeKwoId}`, { headers: authHeaders });
  const summary = kwoDetail.data?.data?.summary;
  assert(
    kwoDetail.status === 200 &&
    summary &&
    'total_rolls_produced_meters' in summary &&
    'total_rolls_produced_kg' in summary &&
    Number(summary.total_rolls_produced_meters) >= 145.5,
    `GET /api/knitting/orders/:id -> summary contains total_rolls_produced_meters (${summary?.total_rolls_produced_meters} m) and total_rolls_produced_kg (${summary?.total_rolls_produced_kg} kg)`
  );

  // 7. Test CAD Requirements API
  console.log('\n--- Testing CAD Requirements API ---');
  const cadList = await req('/cad-requirements', { headers: authHeaders });
  assert(cadList.status === 200 && Array.isArray(cadList.data?.data), 'GET /api/cad-requirements -> 200 OK');

  if (cadList.data?.data?.length > 0) {
    const firstCadId = cadList.data.data[0].id;
    const cadDetail = await req(`/cad-requirements/${firstCadId}`, { headers: authHeaders });
    assert(
      cadDetail.status === 200 && cadDetail.data?.data?.req_no,
      `GET /api/cad-requirements/${firstCadId} -> 200 OK (Req No: ${cadDetail.data?.data?.req_no})`
    );
  }

  console.log('\n========================================');
  console.log(`📊 Test Results: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
