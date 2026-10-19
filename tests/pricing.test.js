// Run: node tests/pricing.test.js
// Checks the engine against the Dodo pricing band sheet (0–30 mi) and a few worked examples.
const assert = require('assert');
const P = require('../pricing.js');

// Every band from "Dodo pricing for claude.xlsx" (upper mile → £).
const SHEET = {
  1: 10, 1.5: 10, 2: 10, 2.5: 10, 3: 10, 3.5: 10, 4: 10, 4.5: 10, 5: 10,
  5.5: 10.2, 6: 10.4, 6.5: 10.6, 7: 10.8, 7.5: 11, 8: 11.2, 8.5: 11.4, 9: 11.6, 9.5: 11.8, 10: 12,
  10.5: 12.2, 11: 12.4, 11.5: 12.6, 12: 12.8, 12.5: 13, 13: 13.2, 13.5: 13.4, 14: 13.6, 14.5: 13.8, 15: 14,
  15.5: 14.2, 16: 14.4, 16.5: 14.6, 17: 14.8, 17.5: 15, 18: 15.2, 18.5: 15.4, 19: 15.6, 19.5: 15.8, 20: 16,
  20.5: 16.2, 21: 16.4, 21.5: 16.6, 22: 16.8, 22.5: 17, 23: 17.2, 23.5: 17.4, 24: 17.6, 24.5: 17.8, 25: 18,
  25.5: 18.2, 26: 18.4, 26.5: 18.6, 27: 18.8, 27.5: 19, 28: 19.2, 28.5: 19.4, 29: 19.6, 29.5: 19.8, 30: 20
};

let n = 0;
for (const [hi, fee] of Object.entries(SHEET)) {
  const upper = Number(hi);
  // Upper edge of the band, and a point just inside it.
  assert.strictEqual(P.deliveryFee(upper).fee, fee, `upper ${upper}`);
  assert.strictEqual(P.deliveryFee(upper - 0.01).fee, fee, `inside ${upper - 0.01}`);
  n += 2;
}

// Worked examples matching Evermile "Actual Cost" in Dodo_Driver_Cost_Gap_Review.
const live = [
  [8.20, 11.40], [12.65, 13.20], [0, 10], [5.0, 10], [5.01, 10.2], [10.48, 12.2], [22.74, 17.2], [20.56, 16.4]
];
for (const [d, fee] of live) { assert.strictEqual(P.deliveryFee(d).fee, fee, `live ${d}`); n++; }

assert.strictEqual(P.deliveryFee('').ok, false);

// Route & driver roll-up.
const out = P.calculate([
  { id: 'a', date: '2026-10-19', driver: 'Ali', distance: 8.2, extra: 2 },
  { id: 'b', date: '2026-10-19', driver: 'Ali', distance: 3 },
  { id: 'c', date: '2026-10-19', driver: 'Bea', distance: 12.65 },
  { id: 'd', date: '2026-10-19', driver: '', distance: 1 }
], {}, { 'Ali|2026-10-19': { amount: -1.5, remark: 'late' } });
assert.strictEqual(out.routes.length, 2);
const ali = out.drivers.find(d => d.driver === 'Ali');
assert.strictEqual(ali.drops, 2);
assert.strictEqual(ali.fees, 21.4);
assert.strictEqual(ali.extras, 2);
assert.strictEqual(ali.payable, 21.9);
assert.strictEqual(ali.adjustmentRemark, 'late');
assert.strictEqual(out.routes.find(r => r.driver === 'Ali').total, 21.9);
assert.strictEqual(out.unassigned, 1);
assert.strictEqual(out.totals.payable, 35.1);

// Optional multi-drop fee.
const md = P.calculate([
  { id: 'a', date: 'x', driver: 'Ali', distance: 1 },
  { id: 'b', date: 'x', driver: 'Ali', distance: 1 },
  { id: 'c', date: 'x', driver: 'Ali', distance: 1 }
], { extraDropFee: 0.5 });
assert.strictEqual(md.routes[0].total, 31);
n += 12;

console.log(`OK — ${n} pricing checks passed`);
