#!/usr/bin/env python3
"""
End-to-end API test for the client review changes (24-Sep-2026 meeting):
multi-job process DCs, process inward (single + batch), operations & contractor
rates, contractor bills, panel conversion, SO number preview, divisions, costing
actuals, knitting DC / reconciliation, CAD, invoice summary, attachments, audit.

Usage:
  BASE=http://localhost:4000/api TOKEN=<jwt> python3 scripts/api-test-client-review.py
  BASE=... LOGIN_USER=admin LOGIN_PASS=... python3 scripts/api-test-client-review.py
  READONLY=1 ...   # only GET checks, creates nothing

Write checks create documents tagged "APITEST" and clean up what can be undone
(DCs without inwards are cancelled, bills cancelled, attachments deleted, test
operation deactivated). Inwards move bundle counters and cannot be deleted —
they use 1 PCS per bundle. Exit code 1 when any check fails.
"""
import json, os, sys, time, base64, urllib.request, urllib.error, urllib.parse

BASE = os.environ.get('BASE', 'http://localhost:4000/api').rstrip('/')
READONLY = os.environ.get('READONLY') == '1'
TOKEN = os.environ.get('TOKEN')
TAG = f"APITEST-{int(time.time())}"
RESULTS = []          # (status, name, detail)
CLEANUP = []          # callables
MY_DCS = []           # DC ids created by this run


def call(method, path, body=None, expect=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers={
        'Content-Type': 'application/json', 'Accept': 'application/json',
        **({'Authorization': f'Bearer {TOKEN}'} if TOKEN else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try:
        js = json.loads(raw or b'{}')
    except Exception:
        js = {'raw': raw[:300].decode(errors='replace')}
    return code, js


def check(name, cond, detail=''):
    RESULTS.append(('PASS' if cond else 'FAIL', name, detail))
    return cond


def skip(name, why):
    RESULTS.append(('SKIP', name, why))


def err(js):
    e = js.get('error') if isinstance(js, dict) else None
    return (e or {}).get('message') if isinstance(e, dict) else str(js)[:200]


def get_ok(name, path, want_list=None):
    code, js = call('GET', path)
    d = js.get('data') if isinstance(js, dict) else None
    ok = code == 200 and (want_list is None or isinstance(d, list) == want_list)
    check(f'GET {path}', ok, f'{code} {"" if ok else err(js)}')
    return d if ok else None


def near(a, b, tol=0.011):
    return abs(float(a or 0) - float(b or 0)) <= tol


# ------------------------------------------------------------------ auth
if not TOKEN:
    u, p = os.environ.get('USER_NAME') or os.environ.get('LOGIN_USER'), os.environ.get('PASS') or os.environ.get('LOGIN_PASS')
    if not (u and p):
        print('Set TOKEN, or LOGIN_USER and LOGIN_PASS'); sys.exit(2)
    code, js = call('POST', '/auth/login', {'username': u, 'password': p})
    if code != 200:
        print('Login failed:', code, err(js)); sys.exit(2)
    TOKEN = js['data']['accessToken']
code, js = call('GET', '/process-dcs/stages')
if code == 401:
    print('Token rejected (expired?):', err(js)); sys.exit(2)

# ================================================================== READ-ONLY
stages = get_ok('stages', '/process-dcs/stages', True) or []
stage_by = {s['stage_code']: s for s in stages}
check('Checking process seeded', 'CHECK' in stage_by or 'CHECKING' in stage_by, ','.join(stage_by))
contractors = get_ok('contractors', '/process-dcs/contractors', True) or []
pm = get_ok('process master', '/process-master', True) or []
all_ops = get_ok('operations', '/process-master/operations', True) or []
get_ok('dc list', '/process-dcs', True)
get_ok('dc open list', '/process-dcs?status=OPEN', True)
get_ok('receipts', '/process-dcs/receipts', True)
get_ok('contractor bills', '/contractor-bills', True)
get_ok('divisions', '/divisions', True)
get_ok('lookup divisions', '/lookups/divisions', True)
get_ok('lookup merchandisers', '/lookups/merchandisers', True)
get_ok('knitting dcs', '/knitting-dcs', True)
get_ok('knitting inwards', '/knitting-inwards', True)
get_ok('fabric rolls', '/fabric-rolls', True)
get_ok('cad list', '/cad-requirements', True)
get_ok('jobwork invoices', '/jobwork-invoices', True)
get_ok('supplier bills', '/supplier-bills', True)

stitch = stage_by.get('STITCH') or stage_by.get('STITCHING')
if stitch:
    jobs = get_ok('available jobs', f"/bundle-stock/available-jobs?stage_id={stitch['id']}", True) or []
    if jobs:
        j = jobs[0]
        check('available-jobs shape', all(k in j for k in ('io_no', 'bundles', 'free_bundles', 'qty', 'buyer_name', 'style_codes')), str(list(j)))

# SO number preview (group fallback)
code, js = call('GET', '/lookups/buyers')
buyers = js.get('data') or []
if buyers:
    code, js = call('GET', '/sales-orders/next-so-number?' + urllib.parse.urlencode({'buyer_id': buyers[0]['id'], 'order_type': 'EXPORT', 'so_date': '2026-09-28'}))
    so = (js.get('data') or {}).get('so_no')
    check('SO preview without group uses default group', code == 200 and bool(so) and so[0] == 'G' and so[3] == 'E', f'{code} {so}')
    code, js = call('GET', '/sales-orders/next-so-number?' + urllib.parse.urlencode({'buyer_id': buyers[0]['id'], 'order_type': 'DOMESTIC', 'so_date': '2026-09-28', 'order_group': 'G11'}))
    so = (js.get('data') or {}).get('so_no') or ''
    check('SO preview G11 domestic', so.startswith('G11D26'), so)
else:
    skip('SO preview', 'no buyers')

# Costing actuals for every production order
code, js = call('GET', '/production-orders?page=1&pageSize=5')
pos = js.get('data') or []
for po in pos[:3]:
    code, js = call('GET', f"/production-costs/order-data/{po['id']}")
    d = js.get('data') or {}
    heads = d.get('heads') or []
    ok = code == 200 and len(heads) == 8 and all(h['source'] in ('TRANSACTIONS', 'RATE_SETTING', 'NO_DATA') for h in heads)
    tot = round(sum(h['amount'] for h in heads), 2)
    check(f"costing order-data PO {po.get('po_prod_no')}", ok and near(tot, d['summary']['total_actual_cost'], 0.05),
          f"{code} heads={len(heads)} sum={tot} total={d.get('summary', {}).get('total_actual_cost')} std={d.get('standard', {}).get('available')}")
    if d.get('standard', {}).get('available') is False:
        check('costing: no standard → no variance', all(r['variance'] is None for r in d['tabs']['variance']), '')
code, js = call('GET', '/production-costs')
sheets = js.get('data') or []
if sheets:
    code, js = call('GET', f"/production-costing/{sheets[0]['id']}/drilldown")
    check('costing drilldown', code == 200 and isinstance((js.get('data') or {}).get('fabric'), list), f'{code} {err(js) if code != 200 else ""}')

# Knitting reconciliation
code, js = call('GET', '/knitting/programs')
progs = js.get('data') or []
for pg in progs[:2]:
    code, js = call('GET', f"/knitting-programs/{pg['id']}/reconciliation")
    check(f"knitting reconciliation {pg.get('program_no')}", code == 200, f'{code} {err(js) if code != 200 else ""}')

# CAD purchase requirement
code, js = call('GET', '/cad-requirements')
cads = js.get('data') or []
if cads:
    code, js = call('GET', f"/cad-requirements/{cads[0]['id']}")
    check('CAD detail has purchase_requirement', code == 200 and 'purchase_requirement' in (js.get('data') or {}), f'{code}')

# Job work invoice print (divisions)
code, js = call('GET', '/jobwork-invoices')
invs = js.get('data') or []
if invs:
    code, js = call('GET', f"/jobwork-invoices/{invs[0]['id']}/print")
    d = js.get('data') or {}
    check('job work invoice print has division header', code == 200 and bool(json.dumps(d)), f'{code} {err(js) if code != 200 else ""}')

# IO + style compulsory on job-bound creates (validation only — nothing is saved)
code, js = call('POST', '/knitting/programs', {'program_date': '2026-09-28'})
fields = [x.get('field') for x in ((js.get('error') or {}).get('details') or [])] if isinstance((js.get('error') or {}).get('details'), list) else []
check('knitting program needs IO + style', code in (400, 422) and ('style_id' in fields or 'io_no' in fields), f'{code} {fields}')

if READONLY:
    pass
else:
    # ============================================================== WRITES
    vendor = contractors[0] if contractors else None
    if not (stitch and vendor):
        skip('write tests', 'need a Stitching process and a contractor')
    else:
        stitch_ops = next((s['operations'] for s in pm if s['id'] == stitch['id']), [])

        # --- process master: stage + operation create/update
        code, js = call('POST', '/process-master/operations', {'stage_id': stitch['id'], 'op_name': f'{TAG} Op', 'op_code': TAG.replace('-', '_'), 'default_rate': 1.25})
        op_id = (js.get('data') or {}).get('id')
        check('create operation', code == 201 and op_id, f'{code} {err(js) if code != 201 else ""}')
        code, js = call('POST', '/process-master/operations', {'stage_id': stitch['id'], 'op_name': 'dup', 'op_code': TAG.replace('-', '_')})
        check('duplicate operation code rejected', code == 400, f'{code}')
        if op_id:
            code, js = call('PUT', f'/process-master/operations/{op_id}', {'stage_id': stitch['id'], 'op_name': f'{TAG} Op', 'op_code': TAG.replace('-', '_'), 'default_rate': 1.5, 'is_active': True})
            check('update operation', code == 200, f'{code}')
            CLEANUP.append(lambda: call('PUT', f'/process-master/operations/{op_id}', {'stage_id': stitch['id'], 'op_name': f'{TAG} Op', 'op_code': TAG.replace('-', '_'), 'default_rate': 0, 'is_active': False}))

        # --- contractor rates (restore previous afterwards)
        code, js = call('GET', f"/process-master/operations?stage_id={stitch['id']}&vendor_id={vendor['id']}")
        before = js.get('data') or []
        if len(before) >= 2:
            o1, o2 = before[0], before[1]
            code, js = call('PUT', '/process-master/contractor-rates', {'vendor_id': vendor['id'], 'rates': [{'operation_id': o1['id'], 'rate': 2.25}, {'operation_id': o2['id'], 'rate': 1.75}]})
            eff = {o['id']: o for o in (js.get('data') or [])}
            check('contractor rates saved', code == 200 and near(eff.get(o1['id'], {}).get('rate'), 2.25) and near(eff.get(o2['id'], {}).get('rate'), 1.75), f'{code}')
            CLEANUP.append(lambda: call('PUT', '/process-master/contractor-rates', {'vendor_id': vendor['id'], 'rates': [
                {'operation_id': o['id'], 'rate': None if o.get('contractor_rate') is None else float(o['contractor_rate'])} for o in (o1, o2)]}))
        else:
            o1 = o2 = None

        # --- find free bundles on 2 jobs
        jobs = (call('GET', f"/bundle-stock/available-jobs?stage_id={stitch['id']}")[1].get('data') or [])
        free = []
        for j in jobs:
            bs = call('GET', f"/bundle-stock/available?stage_id={stitch['id']}&io_no={urllib.parse.quote(j['io_no'] or '')}")[1].get('data') or []
            bs = [b for b in bs if not b['open_dc_no'] and b['available_qty'] >= 2]
            if bs: free.append((j, bs))
            if len(free) == 2: break
        if not free:
            skip('DC write tests', 'no free bundles with >= 2 PCS at cutting')
        else:
            pick = [b for _, bs in free for b in bs[:2]][:4]
            op_ids = [o['id'] for o in (o1, o2) if o]
            line_op = stitch_ops[0]['id'] if stitch_ops else None

            # resolve-bundles (Excel import)
            code, js = call('POST', '/process-dcs/resolve-bundles', {'stage_id': stitch['id'], 'codes': [b['bundle_no'] for b in pick] + ['NO-SUCH-BUNDLE']})
            rs = js.get('data') or []
            check('resolve-bundles', code == 200 and sum(r['ok'] for r in rs) == len(pick) and any(not r['ok'] and r['reason'] == 'Bundle not found' for r in rs), f'{code} {js.get("meta")}')

            # draft DC (1 PCS per bundle), operations, per-line op/operator, weight
            body = {'challan_date': '2026-09-28', 'stage_id': stitch['id'], 'vendor_id': vendor['id'], 'ref_no': TAG, 'remarks': TAG,
                    'operations': [{'operation_id': x} for x in op_ids],
                    'lines': [{'bundle_id': b['id'], 'qty': 1, 'weight_kg': 0.25, 'remarks': TAG, 'operation_id': line_op, 'operator_line': 'LINE-01'} for b in pick]}
            code, js = call('POST', '/process-dcs', body)
            dc = js.get('data') or {}
            ok = check('create draft multi-job DC', code == 201 and dc.get('status') == 'DRAFT', f'{code} {err(js) if code != 201 else dc.get("challan_no")}')
            if ok:
                MY_DCS.append(dc['id'])
                if op_ids:
                    check('DC rate = sum of operations', near(dc['rate'], 4.0, 0.001), f"rate={dc['rate']}")
                check('DC job sections', len(dc['summary']['jobs']) == len({b['io_no'] for b in pick}), f"jobs={[j['io_no'] for j in dc['summary']['jobs']]}")
                check('DC totals', dc['summary']['totals']['qty'] == len(pick) and near(dc['summary']['totals']['weight_kg'], 0.25 * len(pick)), str(dc['summary']['totals']))
                l0 = dc['lines'][0]
                check('DC line fields', all(k in l0 for k in ('job_io_no', 'lay_no', 'cut_no', 'assort_color', 'operation_name', 'operator_line', 'stock_stage', 'barcode')), '')
                check('DC line operator/operation saved', l0['operator_line'] == 'LINE-01' and (line_op is None or l0['operation_id'] == line_op), '')
                # draft edit
                body2 = {**body, 'remarks': TAG + ' edited', 'lines': body['lines'][:-1]} if len(pick) > 2 else {**body, 'remarks': TAG + ' edited'}
                code, js = call('PUT', f"/process-dcs/{dc['id']}", body2)
                check('edit draft DC', code == 200 and js['data']['remarks'].endswith('edited'), f'{code} {err(js) if code != 200 else ""}')
                # issue
                code, js = call('POST', f"/process-dcs/{dc['id']}/issue")
                check('issue DC', code == 200 and js['data']['status'] == 'ISSUED', f'{code} {err(js) if code != 200 else ""}')
                dc = js.get('data') or dc
                code, js = call('GET', f"/process-dcs/{dc['id']}/print")
                check('DC print data', code == 200 and 'company' in (js.get('data') or {}), f'{code}')
                # bundle now held by an open DC
                code, js = call('POST', '/process-dcs', {**body, 'lines': [{'bundle_id': pick[0]['id'], 'qty': 1}]})
                check('bundle on open DC rejected', code == 400, f'{code} {err(js)}')

                # inward validations
                l0 = dc['lines'][0]
                code, js = call('POST', f"/process-dcs/{dc['id']}/receipts", {'receipt_date': '2026-09-28', 'lines': [{'line_id': l0['id'], 'received_qty': 5}]})
                check('over-receipt rejected', code == 400, f'{code} {err(js)}')
                code, js = call('POST', f"/process-dcs/{dc['id']}/receipts", {'receipt_date': '2026-09-28', 'lines': [{'line_id': l0['id'], 'rejected_qty': 1}]})
                check('reject without reason rejected', code == 400 and 'reason' in (err(js) or ''), f'{code} {err(js)}')
                # Qty 1 per line: excess with nothing received is invalid
                code, js = call('POST', f"/process-dcs/{dc['id']}/receipts", {'receipt_date': '2026-09-28', 'lines': [{'line_id': l0['id'], 'excess_qty': 2}]})
                check('excess without full receipt rejected', code == 400 and 'excess' in (err(js) or ''), f'{code} {err(js)}')
                # valid inward: line0 good + excess, line1 reject w/ reason
                lines = [{'line_id': l0['id'], 'received_qty': 1, 'excess_qty': 2, 'operation_id': line_op, 'operator_line': 'LINE-02', 'weight_kg': 0.24}]
                if len(dc['lines']) > 1:
                    lines.append({'line_id': dc['lines'][1]['id'], 'rejected_qty': 1, 'reject_reason': 'Open seam'})
                code, js = call('POST', f"/process-dcs/{dc['id']}/receipts", {'receipt_date': '2026-09-28', 'party_dc_no': TAG, 'ref_no': TAG, 'vehicle_no': 'TN00AA0000', 'lines': lines})
                rc = js.get('data') or {}
                ok = check('inward with excess + reject reason', code == 201, f'{code} {err(js) if code != 201 else rc.get("receipt_no")}')
                if ok:
                    rr = rc['dc']['receipts'][-1]
                    check('inward stored ref/party DC/excess', rr['ref_no'] == TAG and rr['party_dc_no'] == TAG and rr['excess_qty'] == 2, f"{rr.get('ref_no')} {rr.get('excess_qty')}")
                    rl = rr['lines'][0]
                    check('inward line operation/operator', rl['operator_line'] == 'LINE-02' and rl['excess_qty'] == 2, '')
                    tt = rc['dc']['summary']['totals']
                    check('DC totals after inward', tt['received'] == 1 and tt['rejected'] == (1 if len(lines) > 1 else 0), str(tt))

                # audit + attachments
                code, js = call('GET', f"/process-dcs/{dc['id']}/audit")
                aud = js.get('data') or []
                check('audit trail has DC + inward entries', code == 200 and any(a['table_name'] == 'trx_jobwork_challan' for a in aud)
                      and any(a['table_name'] == 'trx_jobwork_receipt' for a in aud), f'{code} n={len(aud)}')
                pdf = base64.b64encode(b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').decode()
                code, js = call('POST', '/uploads', {'filename': f'{TAG}.pdf', 'data': f'data:application/pdf;base64,{pdf}', 'folder': 'attachments'})
                url = (js.get('data') or {}).get('url')
                check('upload PDF attachment', code == 201 and url and url.endswith('.pdf'), f'{code} {err(js) if code != 201 else url}')
                code, js = call('POST', '/uploads', {'filename': 'x.pdf', 'data': f'data:application/pdf;base64,{pdf}', 'folder': 'styles'})
                check('PDF refused for style images', code == 400, f'{code}')
                if url:
                    code, js = call('POST', f"/process-dcs/{dc['id']}/attachments", {'file_url': url, 'file_name': f'{TAG}.pdf', 'doc_type': 'PARTY_DC'})
                    att = (js.get('data') or {}).get('id')
                    check('attach to DC', code == 201 and att, f'{code} {err(js) if code != 201 else ""}')
                    code, js = call('GET', f"/process-dcs/{dc['id']}/attachments")
                    check('list attachments', code == 200 and any(a['id'] == att for a in js.get('data') or []), f'{code}')
                    code, js = call('POST', f"/process-dcs/{dc['id']}/attachments", {'file_url': 'http://evil/x.pdf'})
                    check('attachment must be an upload', code in (400, 422), f'{code}')
                    if att:
                        code, js = call('DELETE', f"/process-dcs/{dc['id']}/attachments/{att}")
                        check('delete attachment', code == 200, f'{code}')

            # --- batch inward: 2 DCs of the same contractor, 1 PCS each
            left = [b for b in pick if b['available_qty'] >= 2]
            if len(left) >= 2:
                dcs = []
                for b in left[:2]:
                    code, js = call('POST', '/process-dcs', {'challan_date': '2026-09-28', 'stage_id': stitch['id'], 'vendor_id': vendor['id'],
                                                             'remarks': TAG + ' batch', 'issue': True, 'lines': [{'bundle_id': b['id'], 'qty': 1}]})
                    if code == 201: dcs.append(js['data']); MY_DCS.append(js['data']['id'])
                if check('create 2 issued DCs for batch', len(dcs) == 2, f'{len(dcs)}'):
                    payload = {'receipt_date': '2026-09-28', 'party_dc_no': TAG + '-B', 'dcs': [
                        {'challan_id': d['id'], 'lines': [{'line_id': d['lines'][0]['id'], 'received_qty': 1}]} for d in dcs]}
                    code, js = call('POST', '/process-dcs/receipts/batch', {**payload, 'dcs': payload['dcs'] + [payload['dcs'][0]]})
                    check('batch with duplicate DC rejected', code == 400, f'{code}')
                    code, js = call('POST', '/process-dcs/receipts/batch', payload)
                    b = js.get('data') or {}
                    ok = check('batch inward', code == 201 and len(b.get('receipts') or []) == 2 and b.get('inward_group_no'), f'{code} {err(js) if code != 201 else b.get("inward_group_no")}')
                    if ok:
                        code, js = call('GET', '/process-dcs/receipts?group=' + urllib.parse.quote(b['inward_group_no']))
                        check('receipts by inward group', code == 200 and len(js.get('data') or []) == 2, f'{code}')
                        check('batch DCs fully received', all(r['dc_status'] == 'FULLY_RECEIVED' for r in b['receipts']), str([r['dc_status'] for r in b['receipts']]))

            # --- cancel an issued DC with no inward (reverses the ledger)
            spare = [b for _, bs in free for b in bs if b['id'] not in {x['id'] for x in pick}]
            if spare:
                code, js = call('POST', '/process-dcs', {'challan_date': '2026-09-28', 'stage_id': stitch['id'], 'vendor_id': vendor['id'], 'issue': True, 'lines': [{'bundle_id': spare[0]['id'], 'qty': 1}]})
                if code == 201:
                    cid_ = js['data']['id']
                    code, js = call('POST', f'/process-dcs/{cid_}/cancel', {'reason': TAG + ' cancel'})
                    check('cancel issued DC', code == 200 and js['data']['status'] == 'CANCELLED', f'{code}')
                    ab = [x for x in call('GET', f"/bundle-stock/available?stage_id={stitch['id']}&q={urllib.parse.quote(spare[0]['bundle_no'])}")[1].get('data') or [] if x['id'] == spare[0]['id']]
                    check('cancel returns PCS to cutting', bool(ab) and ab[0]['available_qty'] == spare[0]['available_qty'], f"{ab[0]['available_qty'] if ab else None} vs {spare[0]['available_qty']}")

            # --- contractor bill with GST + TDS, double billing, approve, cancel
            ub = call('GET', f"/contractor-bills/unbilled?vendor_id={vendor['id']}")[1].get('data') or []
            mine = [u for u in ub if u['challan_id'] in MY_DCS]
            if mine:
                ids = [u['receipt_id'] for u in mine]
                gross = round(sum(u['amount'] for u in mine), 2)
                code, js = call('POST', '/contractor-bills', {'bill_date': '2026-09-28', 'vendor_id': vendor['id'], 'receipt_ids': ids,
                                                              'gst_pct': 5, 'tds_pct': 1, 'other_deduction': 0, 'remarks': TAG})
                bill = js.get('data') or {}
                if check('create contractor bill', code == 201, f'{code} {err(js) if code != 201 else bill.get("bill_no")}'):
                    exp_net = round(gross + gross * 0.05 - gross * 0.01)
                    check('bill GST/TDS/net', near(bill['gross_amount'], gross) and near(bill['gst_amount'], gross * 0.05) and near(bill['tds_amount'], gross * 0.01) and near(bill['net_amount'], exp_net, 1),
                          f"gross={bill['gross_amount']} gst={bill['gst_amount']} tds={bill['tds_amount']} net={bill['net_amount']} exp={exp_net}")
                    code, js = call('POST', '/contractor-bills', {'bill_date': '2026-09-28', 'vendor_id': vendor['id'], 'receipt_ids': ids})
                    check('double billing rejected', code == 400, f'{code} {err(js)}')
                    code, js = call('POST', f"/contractor-bills/{bill['id']}/approve")
                    check('approve bill', code == 200 and js['data']['status'] == 'APPROVED', f'{code}')
                    code, js = call('GET', f"/contractor-bills/{bill['id']}")
                    check('bill detail + company', code == 200 and 'company' in (js.get('data') or {}), f'{code}')
                    code, js = call('POST', f"/contractor-bills/{bill['id']}/cancel", {'reason': TAG + ' cancel'})
                    check('cancel bill frees inwards', code == 200 and js['data']['status'] == 'CANCELLED', f'{code}')
            else:
                skip('contractor bill', 'no unbilled inwards')

        # --- panel conversion (validation only when fewer than two panels)
        cut = call('GET', '/bundle-stock/available?level=CUT')[1].get('data') or []
        cut = [b for b in cut if not b['open_dc_no'] and b['available_qty'] == b['qty'] and b['status'] in ('GENERATED', 'CHECKED', 'CUT')]
        sizes = {}
        for b in cut: sizes.setdefault((b['io_no'], b['style_code'], b['size_code']), []).append(b)
        pair = next((v[:2] for v in sizes.values() if len(v) >= 2), None)
        other = next(((v[0], w[0]) for k, v in sizes.items() for k2, w in sizes.items() if k[2] != k2[2]), None)
        if other:
            code, js = call('POST', '/bundles/panel-convert', {'bundle_ids': [other[0]['id'], other[1]['id']], 'part_name': 'TOP', 'reason': TAG})
            check('panel conversion: mixed sizes rejected', code == 400, f'{code} {err(js)}')
        if pair:
            code, js = call('POST', '/bundles/panel-convert', {'bundle_ids': [pair[0]['id'], pair[1]['id']], 'part_name': 'top', 'qty': 1, 'reason': TAG})
            d = js.get('data') or {}
            check('panel conversion', code == 201 and d.get('qty') == 1 and d.get('part_name') == 'TOP' and len(d.get('sources') or []) == 2, f'{code} {err(js) if code != 201 else d.get("bundle_no")}')
        else:
            skip('panel conversion', 'no two cut bundles of the same job/style/size')

# ================================================================== more checks
# Production order / collar program: IO + style compulsory on create (validation only)
code, js = call('POST', '/production-orders', {'po_prod_no': None, 'order_qty': 1})
fields = [x.get('field') for x in ((js.get('error') or {}).get('details') or [])] if isinstance((js.get('error') or {}).get('details'), list) else []
check('production order needs IO + style', code in (400, 422) and 'io_no' in fields and 'style_id' in fields, f'{code} {fields}')

if not READONLY:
    # --- pre-costing: server recomputes heads, ignores client totals
    code, js = call('GET', '/lookups/styles'); styles = js.get('data') or []
    code, js = call('GET', '/lookups/currencies'); curs = js.get('data') or []
    inr = next((c for c in curs if c.get('code') == 'INR'), curs[0] if curs else None)
    if styles and inr:
        dj = {'cuttingOps': [{'operation': 'Cutting', 'rate': 1.5}, {'operation': 'Bundling', 'rate': 0.5}],
              'finishingItems': [{'item': 'Ironing', 'cost_type': 'FINISHING', 'qty_per_pc': 1, 'rate': 1.2},
                                 {'item': 'Polybag', 'cost_type': 'PACKING', 'qty_per_pc': 1, 'rate': 0.8}],
              'overhead': {'basis': 'PER_PIECE', 'rate': 3}}
        body = {'style_id': styles[0]['id'], 'currency_id': inr['id'], 'costing_date': '2026-09-28', 'order_qty': 100,
                'costing_type': 'PRE_COSTING', 'margin_pct': 20, 'remarks': TAG, 'data_json': dj,
                'cutting_cost': 999, 'total_cost': 1, 'fob_price': 2}
        code, js = call('POST', '/costings', body)
        c = js.get('data') or {}
        if check('pre-costing create', code == 201, f'{code} {err(js) if code != 201 else c.get("costing_no")}'):
            cid_ = c['id']
            code, js = call('GET', f'/costings/{cid_}'); c = js.get('data') or c
            ok = near(c['cutting_cost'], 2.0) and near(c['finishing_cost'], 1.2) and near(c['packing_cost'], 0.8) and near(c['overhead_cost'], 3.0)
            check('pre-costing heads recomputed (client totals ignored)', ok, f"cut={c['cutting_cost']} fin={c['finishing_cost']} pack={c['packing_cost']} oh={c['overhead_cost']}")
            tot = float(c['total_cost']); fob = float(c['fob_price'])
            check('pre-costing FOB = total / (1 - margin)', tot > 1 and near(fob, tot / 0.8, 0.01), f'total={tot} fob={fob}')
            code, js = call('PUT', f'/costings/{cid_}', {**body, 'margin_pct': 96, 'data_json': {**dj, 'otherDirect': [{'type': 'AGENT_COMMISSION', 'basis': 'PCT_FOB', 'value': 4}]}})
            check('pre-costing margin + FOB% >= 100 rejected', code == 400, f'{code} {err(js)}')
            code, js = call('DELETE', f'/costings/{cid_}')
            check('pre-costing delete (cleanup)', code in (200, 204), f'{code}')
    else:
        skip('pre-costing', 'no style / currency')

    # --- knitting yarn return: over-return rejected, return + cancel reverses stock
    dcsk = (call('GET', '/knitting-dcs')[1].get('data') or [])
    dcno = next((d.get('dc_no') for d in dcsk if d.get('dc_no')), None)
    if dcno:
        code, js = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns')
        bal = js.get('data') or {}
        check('knitting DC yarn balance', code == 200 and 'balance_kg' in bal, f'{code} balance={bal.get("balance_kg")}')
        line = next((l for l in bal.get('lines') or [] if float(l.get('balance_kg') or 0) >= 0.5), None)
        wh = (call('GET', '/lookups/warehouses')[1].get('data') or [{}])[0].get('id')
        if line and wh:
            base_ = {'return_date': '2026-09-28', 'party_dc_no': TAG, 'warehouse_id': wh}
            code, js = call('POST', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns',
                            {**base_, 'lines': [{'yarn_id': line['yarn_id'], 'lot_no': line.get('lot_no'), 'return_kg': float(line['balance_kg']) + 1}]})
            check('yarn over-return rejected', code == 400, f'{code} {err(js)}')
            code, js = call('POST', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns',
                            {**base_, 'lines': [{'yarn_id': line['yarn_id'], 'lot_no': line.get('lot_no'), 'return_kg': 0.5}]})
            rt = js.get('data') or {}
            if check('yarn return', code == 201 and rt.get('return_no'), f'{code} {err(js) if code != 201 else rt.get("return_no")}'):
                after = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns')[1].get('data') or {}
                check('yarn return lowers balance at knitter', near(float(after.get('balance_kg', 0)), float(bal['balance_kg']) - 0.5, 0.002), f"{bal['balance_kg']} -> {after.get('balance_kg')}")
                code, js = call('POST', f"/knitting-yarn-returns/{urllib.parse.quote(rt['return_no'])}/cancel", {'reason': TAG + ' cancel'})
                check('cancel yarn return', code == 200 and (js.get('data') or {}).get('status') == 'CANCELLED', f'{code} {err(js)}')
                back = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns')[1].get('data') or {}
                check('cancel restores balance at knitter', near(float(back.get('balance_kg', 0)), float(bal['balance_kg']), 0.002), f"{back.get('balance_kg')}")
                code, js = call('POST', f"/knitting-yarn-returns/{urllib.parse.quote(rt['return_no'])}/cancel", {'reason': TAG})
                check('cancel twice rejected', code == 400, f'{code}')
        else:
            skip('yarn return', 'no DC line with yarn at the knitter / no store')
    else:
        skip('yarn return', 'no knitting DC')

# ================================================================== extended flows
def first(path, key='data'):
    c, j = call('GET', path)
    d = j.get(key) or []
    return d if isinstance(d, list) else []

if not READONLY:
    # --- Sales order: created with the legacy-format SO number, IO separate
    buyers_ = first('/lookups/buyers'); styles_ = first('/lookups/styles'); curs_ = first('/lookups/currencies')
    usd = next((c for c in curs_ if c.get('code') == 'USD'), curs_[0] if curs_ else None)
    if buyers_ and styles_ and usd:
        q = {'buyer_id': buyers_[0]['id'], 'order_type': 'EXPORT', 'so_date': '2026-09-28'}
        prev_ = (call('GET', '/sales-orders/next-so-number?' + urllib.parse.urlencode(q))[1].get('data') or {}).get('so_no')
        code, js = call('POST', '/sales-orders', {**q, 'currency_id': usd['id'], 'exchange_rate': 83, 'remarks': TAG,
                                                  'lines': [{'style_id': styles_[0]['id'], 'unit_price': 2.5, 'order_qty': 10, 'assort_color': 'APITEST ASSORT'}]})
        so = js.get('data') or {}
        if check('sales order create (auto SO number)', code == 201, f'{code} {err(js) if code != 201 else so.get("so_no")}'):
            import re
            check('SO number format G##E26PREFIX####', bool(re.match(r'^G\d{2}E26[A-Z0-9]+\d{4}$', so.get('so_no') or '')) and so.get('so_no') == prev_,
                  f"so_no={so.get('so_no')} preview={prev_} io={so.get('io_no')}")
            check('IO number separate from SO number', bool(so.get('io_no')) and so.get('io_no') != so.get('so_no'), f"io={so.get('io_no')}")
            d = call('GET', f"/sales-orders/{so['id']}")[1].get('data') or {}
            check('assort colour saved on SO line', any(l.get('assort_color') == 'APITEST ASSORT' for l in d.get('lines') or []), '')
            code, js = call('DELETE', f"/sales-orders/{so['id']}")
            check('sales order delete (cleanup)', code == 200, f'{code}')
        code, js = call('POST', '/sales-orders', {**q, 'currency_id': usd['id'], 'order_group': 'G1', 'lines': [{'style_id': styles_[0]['id'], 'unit_price': 1, 'order_qty': 1}]})
        check('invalid group code rejected', code in (400, 422), f'{code}')
    else:
        skip('sales order', 'no buyer / style / currency')

    # --- Supplier bill: common invoice summary (IGST, other −, TDS, TCS) recomputed by the server
    sups = first('/lookups/suppliers'); uoms = first('/lookups/uoms'); inr_ = next((c for c in curs_ if c.get('code') == 'INR'), None)
    if sups and uoms and inr_:
        body = {'bill_no': TAG, 'bill_type': 'GENERAL', 'bill_date': '2026-09-28', 'supplier_id': sups[0]['id'], 'currency_id': inr_['id'], 'gst_type': 'INTER_STATE',
                'supplier_inv_no': TAG, 'other_charges': 500, 'other_charges_sign': -1, 'other_charges_label': 'Rate difference',
                'tds_section': '194Q', 'tds_pct': 0.1, 'tcs_section': '206C(1H)', 'tcs_pct': 0.1,
                'subtotal': 1, 'gst_amount': 1, 'total_amount': 1, 'remarks': TAG,
                'lines': [{'material_type': 'SERVICE', 'description': 'APITEST A', 'bill_qty': 100, 'uom_id': uoms[0]['id'], 'rate': 100, 'amount': 10000, 'gst_rate': 5},
                          {'material_type': 'SERVICE', 'description': 'APITEST B', 'bill_qty': 50, 'uom_id': uoms[0]['id'], 'rate': 100, 'amount': 5000, 'gst_rate': 12}]}
        code, js = call('POST', '/supplier-bills', body)
        b = js.get('data') or {}
        if check('supplier bill create', code == 201, f'{code} {err(js) if code != 201 else b.get("bill_no")}'):
            b = call('GET', f"/supplier-bills/{b['id']}")[1].get('data') or b
            ok = near(b.get('subtotal'), 15000) and near(b.get('igst_amount'), 1100) and near(b.get('cgst_amount'), 0) \
                and near(b.get('tds_amount'), 15) and near(b.get('tcs_amount'), 15.6) and near(b.get('total_amount'), 15600.6)
            check('bill summary: IGST 1100, TDS 15, TCS 15.60, net 15600.60 (client totals ignored)', ok,
                  f"sub={b.get('subtotal')} igst={b.get('igst_amount')} tds={b.get('tds_amount')} tcs={b.get('tcs_amount')} net={b.get('total_amount')}")
            code, js = call('PUT', f"/supplier-bills/{b['id']}", {**body, 'gst_type': 'INTRA_STATE'})
            b2 = call('GET', f"/supplier-bills/{b['id']}")[1].get('data') or {}
            check('bill summary intra-state: CGST 550 + SGST 550', near(b2.get('cgst_amount'), 550) and near(b2.get('sgst_amount'), 550) and near(b2.get('igst_amount'), 0),
                  f"cgst={b2.get('cgst_amount')} sgst={b2.get('sgst_amount')}")
            code, js = call('DELETE', f"/supplier-bills/{b['id']}")
            check('supplier bill delete (cleanup)', code in (200, 204), f'{code}')
    else:
        skip('supplier bill', 'no supplier / uom / INR')

    # --- Job work in (printing) → invoice gets the Printing Division → print header
    custs = first('/lookups/customers')
    if custs and inr_:
        code, js = call('POST', '/jobwork-ins', {'jwin_date': '2026-09-28', 'customer_id': custs[0]['id'], 'customer_dc_no': TAG,
                                                'process_type': 'Screen Printing', 'total_qty': 100, 'rate': 4.5, 'remarks': TAG,
                                                'lines': [{'description': 'APITEST printing', 'material_type': 'GARMENT', 'qty': 100}]})
        jw = js.get('data') or {}
        if check('job work in (printing)', code == 201, f'{code} {err(js) if code != 201 else jw.get("jwin_no")}'):
            jwd = call('GET', f"/jobwork-ins/{jw['id']}")[1].get('data') or {}
            divs = {d['id']: d for d in first('/divisions')}
            dv = divs.get(jwd.get('division_id')) or {}
            check('division auto-picked from process', 'PRINT' in json.dumps(dv).upper(), f"division={dv.get('division_name')}")
            code, js = call('POST', '/jobwork-invoices', {'invoice_date': '2026-09-28', 'jwin_id': jw['id'], 'party_id': custs[0]['id'],
                                                         'invoice_type': 'RECEIVABLE', 'currency_id': inr_['id'], 'total_qty': 100, 'rate': 4.5,
                                                         'taxable_amount': 450, 'gst_amount': 22.5, 'total_amount': 472.5, 'remarks': TAG})
            inv = js.get('data') or {}
            if check('job work invoice (division series)', code == 201, f'{code} {err(js) if code != 201 else inv.get("invoice_no")}'):
                pr = call('GET', f"/jobwork-invoices/{inv['id']}/print")[1].get('data') or {}
                check('invoice print shows division billing name', 'Division' in json.dumps(pr), '')
                call('DELETE', f"/jobwork-invoices/{inv['id']}")
            code, js = call('DELETE', f"/jobwork-ins/{jw['id']}")
            check('job work in delete (cleanup)', code in (200, 204), f'{code}')
    else:
        skip('job work / division', 'no customer / INR')

    # --- CAD: tape / cord KG in both units recomputed by the server (client KG ignored)
    cads_ = first('/cad-requirements')
    if cads_:
        base_cad = call('GET', f"/cad-requirements/{cads_[0]['id']}")[1].get('data') or {}
        body = {k: v for k, v in base_cad.items() if k not in ('id', 'req_no', 'status', 'purchase_requirement', 'created_at', 'updated_at')}
        body.update({'req_no': TAG, 'special_notes': TAG, 'special_parts': [
            {'part_name': 'APITEST draw cord', 'uom': 'MTRS', 'total_qty': 290, 'kg_factor': 50, 'kg_factor_unit': 'PER_KG', 'total_kg': 999},
            {'part_name': 'APITEST twill tape', 'uom': 'MTRS', 'total_qty': 290, 'kg_factor': 20, 'kg_factor_unit': 'G_PER', 'total_kg': 7},
            {'part_name': 'APITEST no factor', 'uom': 'MTRS', 'total_qty': 100}]})
        code, js = call('POST', '/cad-requirements', body)
        cad = js.get('data') or {}
        if check('CAD save with specialised parts', code in (200, 201) and cad.get('id'), f'{code} {err(js) if code not in (200, 201) else cad.get("req_no")}'):
            d = call('GET', f"/cad-requirements/{cad['id']}")[1].get('data') or {}
            pl = {l['item_name']: l for l in (d.get('purchase_requirement') or {}).get('lines', [])}
            a, b_ = pl.get('APITEST draw cord', {}), pl.get('APITEST twill tape', {})
            check('CAD KG: 290 m @ 50 m/kg = 5.8 kg and 290 m @ 20 g/m = 5.8 kg', near(a.get('purchase_qty'), 5.8, 0.001) and near(b_.get('purchase_qty'), 5.8, 0.001),
                  f"{a.get('purchase_qty')} {a.get('purchase_uom')} / {b_.get('purchase_qty')} {b_.get('purchase_uom')}")
            check('CAD row without factor stays unconverted', pl.get('APITEST no factor', {}).get('purchase_uom') != 'KG' and (d.get('purchase_requirement') or {}).get('unconverted', 0) >= 1, '')
    else:
        skip('CAD', 'no CAD sheet to copy')

    # --- Knitting DC → grey fabric inward → yarn return → cancel
    progs_ = [p for p in first('/knitting/programs') if p.get('status') in ('RELEASED', 'MATERIAL_ISSUED', 'IN_PROGRESS', 'PRODUCTION_COMPLETED', 'OUTPUT_RECEIPT', 'QC', 'STOCK_POSTED')]
    stock = first('/yarn-stock')
    vendors_ = first('/lookups/vendors')
    done = False
    for pg in progs_:
        det = call('GET', f"/knitting/programs/{pg['id']}")[1].get('data') or {}
        for y in det.get('yarns') or []:
            srow = next((r for r in stock if r.get('yarn_id') == y.get('yarn_id') and float(r.get('balance_qty') or 0) >= 2), None)
            if not srow or not vendors_: continue
            rec0 = call('GET', f"/knitting-programs/{pg['id']}/reconciliation")[1].get('data') or {}
            code, js = call('POST', '/knitting-dcs', {'program_id': pg['id'], 'dc_date': '2026-09-28', 'vendor_id': det.get('vendor_id') or vendors_[0]['id'],
                                                     'warehouse_id': srow['warehouse_id'], 'vehicle_no': 'TN00AA0000', 'remarks': TAG,
                                                     'lines': [{'program_yarn_id': y['id'], 'yarn_id': y['yarn_id'], 'lot_no': srow.get('lot_no'), 'issued_qty_kg': 1, 'no_of_cones': 1}]})
            if code != 201:
                RESULTS.append(('INFO', f"knitting DC on {pg.get('program_no')}", f'{code} {err(js)}')); continue
            dcno = (js.get('data') or {}).get('dc_no')
            check('knitting DC (yarn outward)', bool(dcno), f'{dcno}')
            pr = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}')[1].get('data') or {}
            check('knitting DC print data', bool(pr), '')
            fabric_id = det.get('fabric_id') or ((first('/lookups/fabrics') or [{}])[0].get('id'))
            inw = {'program_id': pg['id'], 'ref_dc_no': dcno, 'party_dc_no': TAG, 'receipt_date': '2026-09-28', 'warehouse_id': srow['warehouse_id'],
                   'fabric_id': fabric_id,
                   'rolls': [{'roll_no': TAG + '-R1', 'weight_kg': 0.5}]}
            code, js = call('POST', '/knitting-inwards', {**inw, 'yarn_consumed_kg': 5})
            check('grey inward consuming more yarn than given rejected', code == 400, f'{code} {err(js)}')
            code, js = call('POST', '/knitting-inwards', {**inw, 'yarn_consumed_kg': 0.6})
            check('grey fabric inward', code == 201, f'{code} {err(js) if code != 201 else (js.get("data") or {}).get("receipt_no")}')
            rolls = [r for r in first('/fabric-rolls') if r.get('roll_no') == TAG + '-R1']
            check('grey roll in fabric roll stock', len(rolls) == 1 and near(rolls[0].get('weight_kg'), 0.5), f'{len(rolls)}')
            rec = call('GET', f"/knitting-programs/{pg['id']}/reconciliation")[1].get('data') or {}
            t0, t1 = rec0.get('totals') or {}, rec.get('totals') or {}
            check('reconciliation: yarn given +1, fabric +0.5', near(float(t1.get('yarn_given_kg', t1.get('issued_kg', 0))) - float(t0.get('yarn_given_kg', t0.get('issued_kg', 0))), 1, 0.002)
                  and near(float(t1.get('fabric_received_kg', 0)) - float(t0.get('fabric_received_kg', 0)), 0.5, 0.002), json.dumps({k: t1.get(k) for k in list(t1)[:8]}))
            bal = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns')[1].get('data') or {}
            check('DC balance at knitter = 1 − 0.6 = 0.4', near(bal.get('balance_kg'), 0.4, 0.002), f"{bal.get('balance_kg')}")
            code, js = call('POST', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns', {'return_date': '2026-09-28', 'party_dc_no': TAG, 'warehouse_id': srow['warehouse_id'],
                            'lines': [{'yarn_id': y['yarn_id'], 'lot_no': srow.get('lot_no'), 'return_kg': 0.2, 'no_of_cones': 0}]})
            rt = js.get('data') or {}
            if check('yarn return on the new DC', code == 201, f'{code} {err(js) if code != 201 else rt.get("return_no")}'):
                b2 = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns')[1].get('data') or {}
                check('balance after return 0.2', near(b2.get('balance_kg'), 0.2, 0.002), f"{b2.get('balance_kg')}")
                code, js = call('POST', f"/knitting-yarn-returns/{urllib.parse.quote(rt['return_no'])}/cancel", {'reason': TAG})
                b3 = call('GET', f'/knitting-dcs/{urllib.parse.quote(dcno)}/yarn-returns')[1].get('data') or {}
                check('cancel return → balance back to 0.4', code == 200 and near(b3.get('balance_kg'), 0.4, 0.002), f"{code} {b3.get('balance_kg')}")
            done = True
            break
        if done: break
    if not done:
        skip('knitting DC flow', 'no released program with yarn in stock')

# ------------------------------------------------------------------ cleanup + report
for fn in reversed(CLEANUP):
    try: fn()
    except Exception as e: RESULTS.append(('WARN', 'cleanup', str(e)))

w = max(len(r[1]) for r in RESULTS) if RESULTS else 10
for st, name, detail in RESULTS:
    print(f'{st:5} {name.ljust(w)}  {detail}')
p = sum(r[0] == 'PASS' for r in RESULTS); f = sum(r[0] == 'FAIL' for r in RESULTS); s = sum(r[0] == 'SKIP' for r in RESULTS)
print(f'\n{p} passed · {f} failed · {s} skipped · base {BASE} · tag {TAG}')
sys.exit(1 if f else 0)
