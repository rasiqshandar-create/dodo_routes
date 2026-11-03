// Run: node tests/merge.test.js
// Optional real-data acceptance: DODO_TOOKAN=/path/route.csv DODO_RETOOL=/path/export.csv node tests/merge.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../merge.js');

function load(file, fields) {
  const rows = M.parseCSV(fs.readFileSync(file, 'utf8'));
  const headers = rows[0].map(h => h.trim());
  const map = M.autoMap(headers, fields);
  return { kind: M.detectKind(headers), map, objs: M.toObjects(headers, rows.slice(1), map, fields) };
}
let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

// ---------- unit: normalisers ----------
eq(M.clean("'+447412139622"), '+447412139622', 'strip Excel apostrophe');
eq(M.fmtPhone("'+447412139622"), '+44 7412 139622', 'UK mobile');
eq(M.fmtPhone('+442077041555'), '+44 20 7704 1555', 'London landline');
eq(M.fmtPhone('+44 20 7354 2718'), '+44 20 7354 2718', 'already spaced');
eq(M.fmtPhone('07700 900101'), '+44 7700 900101', 'national → +44');
eq(M.fmtPhone('+61 404 262 868'), '+61404262868', 'non-UK kept intact');
eq(M.phoneDigits("'+44 7424 096955"), '+447424096955', 'tel: digits');
eq(M.serviceType('Pick-up'), 'PICKUP');
eq(M.serviceType('Delivery'), 'DELIVERY');
eq(M.fmtDuration(191), '3 hrs 11 mins');
eq(M.normName('  Fahad   REHMAN '), 'fahad rehman');

// ---------- sample two-file flow ----------
const T = load(path.join(__dirname, '../samples/tookan-routes-sample.csv'), M.TOOKAN_FIELDS);
const R = load(path.join(__dirname, '../samples/retool-export-sample.csv'), M.RETOOL_FIELDS);
eq([T.kind, R.kind], ['tookan', 'retool'], 'export kinds detected');
eq(T.map.orderId, 'Order ID', 'Tookan joins on Order ID');
eq(R.map.ref, 'Order ref', 'Retool joins on Order ref (not the UUID Order ID)');
eq(R.map.cost, 'DP cost');

const out = M.build(T.objs, R.objs, {});
eq(out.routes.map(r => r.routeId), ['70001', '70002'], 'routes in file order');
const a = out.routes[0], b = out.routes[1];

// Sequence = Tookan order, unmatched XX9999 skipped and reported.
eq(a.stops.map(s => s.seq + ':' + s.type[0] + ':' + s.ref), [
  '1:P:SB1001', '2:P:SB1002', '3:P:EF2001', '4:D:SB1001', '5:P:DP3001', '6:D:EF2001', '7:D:SB1002', '8:D:DP3001', '9:D:SB1003'
], 'route A sequence preserved, renumbered after skip');
eq(out.unmatched, [{ routeId: '70001', agentName: 'Driver A', orderId: 'XX9999', types: ['PICKUP', 'DELIVERY'] }], 'unmatched listed once with both tasks');
eq(a.estTimeText, '3 hrs 5 mins');
eq(a.estDistText, '62.40 KMS');

// Duplicate refs: right driver + non-cancelled + Dodo wins.
const sb1002 = a.orders.find(o => o.ref === 'SB1002');
eq([sb1002.dp, sb1002.dpCost, sb1002.duplicates], ['Dodo', 10, 2], 'SB1002 picks the Dodo row over cancelled Uber');
const dp3002 = b.orders.find(o => o.ref === 'DP3002');
eq([dp3002.retoolDriver, dp3002.dpCost, dp3002.cancelled], ['Driver B', 13, false], 'DP3002 picks Driver B row, not Driver A cancelled');
eq(a.orders.find(o => o.ref === 'SB1003').driverMatches, true, 'driver match is trimmed + case-insensitive');

// Enrichment from Retool.
const s4 = a.stops[3];
eq([s4.parcels, s4.instructions, s4.showCost], [2, 'Leave with concierge', true], 'delivery row has parcels, instructions, cost');
eq([a.stops[0].instructions, a.stops[0].showCost], ['', false], 'pickup row: no instructions/cost when a delivery exists');
eq(a.stops[0].phone, '+44 20 7946 0101', 'pickup phone formatted');

// Cost: Retool DP cost, each order once; card only as fallback; mismatch flagged.
eq(a.cost, 55.7, 'route A = 11.40 + 10.00 + 12.50 + 11.80 (card fallback) + 10.00');
eq(a.cardTotal, 53.8);
eq(a.orders.find(o => o.ref === 'DP3001').costSource, 'card', 'missing DP cost falls back to card');
eq(a.orders.filter(o => o.mismatch).map(o => o.ref), ['EF2001'], 'EF2001 £12.50 vs card £10.60 flagged');
eq(a.orders.find(o => o.ref === 'SB1001').mismatch, false, '£11.40 = card, not flagged');
eq(b.cost, 34);
eq(b.mismatches, 1);
eq(out.totals.payable, 89.7);

// Single-sided orders.
const sb1003 = a.orders.find(o => o.ref === 'SB1003');
eq([sb1003.hasPickup, sb1003.hasDelivery], [false, true], 'delivery-only order kept');
const sb1004 = b.orders.find(o => o.ref === 'SB1004');
eq([sb1004.hasPickup, sb1004.hasDelivery, b.stops[4].showCost], [true, false, true], 'pickup-only order shows cost on its pickup row');
eq(out.warnings.filter(w => w.kind === 'single').map(w => w.orderId).sort(), ['SB1003', 'SB1004']);
eq(out.warnings.filter(w => w.kind === 'nocost').map(w => w.orderId), ['DP3001']);

// Unrelated Retool rows ignored.
eq(out.routes.flatMap(r => r.orders).some(o => /^ZZ/.test(o.ref)), false, 'other DPs/orders ignored');

// Extras + route adjustment on top of Retool cost.
const withEdits = M.build(T.objs, R.objs, { edits: { '70001|SB1001': { extra: 2.5, remark: 'Parking' } }, routeAdj: { '70001': { amount: -1, remark: 'Late' } } });
eq(withEdits.routes[0].payable, 57.2, '55.70 + 2.50 − 1.00');
eq(withEdits.routes[0].stops[3].order.total, 13.9);

// Excel-mangled refs: leading zeros dropped on one side still join.
const zT = [{ routeId: 'R1', type: 'Delivery', agentName: 'Z', orderId: '101779' }];
const zR = [{ ref: '000101779', cost: '14.99', driver: 'Z', dp: 'Dodo', miles: '6' }];
eq(M.build(zT, zR, {}).routes[0].orders[0].dpCost, 14.99, 'leading zeros stripped by Excel still match');
eq(M.build([{ routeId: 'R1', type: 'Delivery', agentName: 'Z', orderId: '00042' }], [{ ref: '42', cost: '10', driver: 'Z' }], {}).routes[0].orders.length, 1, 'zeros on the Tookan side too');
eq(M.build([{ routeId: 'R1', type: 'Delivery', agentName: 'Z', orderId: 'CS0042' }], [{ ref: 'CS42', cost: '10', driver: 'Z' }], {}).unmatched.length, 1, 'non-numeric refs are not loosened');

// Weekly-sheet export format (CSV + Google Sheets).
eq(M.SHEET_HEADER, ['S. No.', 'Order ID', 'Agent_Name', 'Merchant', 'Customer Name', 'Delivery Before', 'Actual', 'Delivery', 'OTD', 'Price', 'Refund', 'Driver Cost', 'Remarks', 'Weekly', 'Weekly'], 'exact weekly-sheet header');
const rows = M.sheetRows(withEdits.routes);
eq(rows.length, 5 + 3 + 1, 'one row per order + one route-adjustment row');
eq(rows.map(r => r[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'S. No. runs 1..N');
eq(rows[0].slice(1, 6), ['SB1001', 'Driver A', 'Sample Bakery Co', 'Alex Smith', '11/02/2026 17:00'], 'order, agent, merchant, customer, Delivery Before from slot end');
eq([rows[0][9], rows[0][11], rows[0][12]], [14.99, 13.9, 'Parking'], 'Price = platform price, Driver Cost = DP cost + extra, remark');
eq(rows.map(r => r[1]).slice(0, 5), ['SB1001', 'EF2001', 'SB1002', 'DP3001', 'SB1003'], 'orders in delivery sequence');
eq(rows[5].slice(1, 3).concat(rows[5][11], rows[5][12]), ['ROUTE 70001', 'Driver A', -1, 'Route adjustment: Late'], 'route adjustment row');
eq(rows.every(r => r.length === 15), true, '15 columns per row');

// ---------- optional: real 02 Nov 2026 files ----------
if (process.env.DODO_TOOKAN && process.env.DODO_RETOOL) {
  const RT = load(process.env.DODO_TOOKAN, M.TOOKAN_FIELDS), RR = load(process.env.DODO_RETOOL, M.RETOOL_FIELDS);
  const real = M.build(RT.objs, RR.objs, {});
  const f = real.routes.find(r => r.routeId === '48043');
  eq(f.agentName, 'Fahad Rehman');
  eq([f.stops[0].seq, f.stops[0].type, f.stops[0].ref, f.stops[0].name], [1, 'PICKUP', '#30533', 'KIPFERL'], 'stop 1 = PICKUP #30533 KIPFERL');
  eq(f.stops.map(s => s.ref).slice(8, 13), ['1003157416', '#30700', '#30533', '#FT84078', '#FT84215'], 'Tookan interleaving kept');
  eq(f.cost, 99.34, 'Fahad = Σ Retool DP cost');
  eq(f.cardTotal, 104.2, 'card total for his miles');
  eq(f.mismatches, 3, 'per-order mismatches flagged');
  eq(f.stops.every(s => s.parcels === 1), true, 'parcels from Retool');
  eq(real.unmatched.length, 0);
  const s = real.routes.find(r => r.routeId === '50656').orders.find(o => o.ref === '000101779');
  eq([s.retoolDriver, s.cancelled], ['Salman Dosri', false], 'duplicate 000101779 resolved to the delivered Salman row');
  const fr = M.sheetRows(real.routes).filter(r => r[2] === 'Fahad Rehman');
  eq(fr.length, 9, 'Fahad: 9 rows in weekly format');
  eq(fr[0].slice(1, 12), ['1003157416', 'Fahad Rehman', 'PAUL UK', 'Karin Bednarova', '11/02/2026 13:00', '11/02/2026', '10:35', 'Yes', 9.99, '', 10], 'Fahad first row');
  eq(Math.round(fr.reduce((s, r) => s + r[11], 0) * 100) / 100, 99.34, 'Driver Cost column sums to £99.34');
  console.log('  + real 02-Nov-2026 acceptance checks');
}

console.log(`OK — ${n} merge checks passed`);
