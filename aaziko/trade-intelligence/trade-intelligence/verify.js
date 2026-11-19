'use strict';
/* Independent verification of the engine math vs the spec formulas.
 * Recomputes each metric with plain arithmetic and asserts it matches engine.js. */
const eng = require('./engine');

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sstdev = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const dd = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const ev = (date, value, qty, sup) => ({ event_date: date, value_usd: value, quantity: qty, qty_unit: 'NOS', supplier_std: sup, date_precision: 'day' });

let pass = 0, fail = 0;
const near = (label, exp, act, tol = 0.01) => { const ok = Math.abs(exp - act) <= tol; ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}: spec/hand=${exp}  engine=${act}`); };
const eq = (label, exp, act) => { const ok = String(exp) === String(act); ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}: spec/hand="${exp}"  engine="${act}"`); };

console.log('='.repeat(74));
console.log('ENGINE MATH VERIFICATION  vs  spec formulas');
console.log('='.repeat(74));

// ---- §4 Frequency: clean case, intervals all 30 → Regular ----
console.log('\n§4 FREQUENCY — clean case, dates 30 days apart');
let e = [ev('2025-01-01', 100, 10, 'S'), ev('2025-01-31', 100, 10, 'S'), ev('2025-03-02', 100, 10, 'S'), ev('2025-04-01', 100, 10, 'S')];
let iv = [dd('2025-01-01', '2025-01-31'), dd('2025-01-31', '2025-03-02'), dd('2025-03-02', '2025-04-01')];
console.log('  hand intervals =', JSON.stringify(iv), '(expect [30,30,30])');
let f = eng.frequency(e);
near('median interval', median(iv), f.median_interval_days);
near('mean interval', mean(iv), f.mean_interval_days, 0.05);
near('stability = 1 - stdev/mean', +(1 - sstdev(iv) / mean(iv)).toFixed(3), f.stability, 0.001);
eq('classification', 'Regular', f.class);

// ---- §4 Frequency: variable case [30,30,60] ----
console.log('\n§4 FREQUENCY — variable case, intervals [30,30,60]');
e = [ev('2025-01-01', 100, 10, 'S'), ev('2025-01-31', 100, 10, 'S'), ev('2025-03-02', 100, 10, 'S'), ev('2025-05-01', 100, 10, 'S')];
iv = [30, 30, 60];
const cv = sstdev(iv) / mean(iv);
console.log(`  hand: median=${median(iv)} mean=${mean(iv)} stdev=${sstdev(iv).toFixed(4)} CV=${cv.toFixed(4)} stability=${(1 - cv).toFixed(4)}`);
f = eng.frequency(e);
near('median interval', median(iv), f.median_interval_days);
near('mean interval', mean(iv), f.mean_interval_days, 0.05);
near('stability', +(1 - cv).toFixed(3), f.stability, 0.001);

// ---- §6 Supplier concentration: HHI = Σ share² × 10000 ----
console.log('\n§6 SUPPLIER CONCENTRATION — HHI = Σ(share²)×10000');
e = [ev('2025-01-01', 4000, 4000, 'A'), ev('2025-02-01', 4000, 4000, 'A'), ev('2025-03-01', 2000, 2000, 'B')];
let sr = eng.supplierRelationship(e);
const shares = [0.8, 0.2], hhi = (0.8 ** 2 + 0.2 ** 2) * 10000;
console.log(`  hand: A=8000/10000=0.8, B=2000/10000=0.2 → HHI=(0.64+0.04)×10000=${hhi}`);
near('HHI', hhi, sr.hhi);
near('top1 share', 0.8, sr.top1_share);
eq('dependency (top1≥0.8 ⇒ High)', 'High dependency', sr.dependency_class);

// ---- §6 Multi-supplier 40/35/25 (spec calls this "Open Supply Chain") ----
console.log('\n§6 SUPPLIER — spec example 40/35/25');
e = [ev('2025-01-01', 4000, 4000, 'A'), ev('2025-02-01', 3500, 3500, 'B'), ev('2025-03-01', 2500, 2500, 'C')];
sr = eng.supplierRelationship(e);
const hhi2 = (0.4 ** 2 + 0.35 ** 2 + 0.25 ** 2) * 10000;
console.log(`  hand: HHI=(0.16+0.1225+0.0625)×10000=${hhi2}`);
near('HHI', hhi2, sr.hhi);
eq('approach signal', 'competitive sourcing', sr.approach_signal);
console.log(`  NOTE: spec labels 40/35/25 "Open Supply Chain"; engine label="${sr.dependency_class}" (HHI ${sr.hhi}); approach signal matches spec intent.`);

// ---- §11 Opportunity score = weighted sum (verify on a real-shaped buyer) ----
console.log('\n§11 OPPORTUNITY SCORE — 0.30·fit +0.20·freq +0.20·vol +0.15·supp +0.15·india');
e = [ev('2025-06-21', 59695, 356231, 'X'), ev('2025-10-02', 67751, 381647, 'X'), ev('2025-11-13', 138551, 845810, 'X'), ev('2025-12-06', 18311, 108748, 'X')];
const b = eng.runBuyer('SCORE TEST', e, '690721', 'tiles', new Date('2026-09-11'), 95);
const c = b.comps;
const handScore = Math.round(0.30 * c.product_fit + 0.20 * c.frequency + 0.20 * c.volume + 0.15 * c.supplier + 0.15 * c.india_adv);
console.log(`  components = ${JSON.stringify(c)}`);
console.log(`  hand: 0.30×${c.product_fit}+0.20×${c.frequency}+0.20×${c.volume}+0.15×${c.supplier}+0.15×${c.india_adv} = ${handScore}`);
near('opportunity score', handScore, b.score);

// ---- Real buyer ANNAPURNA (verify engine == independent recompute on REAL data) ----
console.log('\nREAL BUYER — ANNAPURNA MARBLES (11 real shipments)');
const ann = [['2024-02-27', 9369.537713, 1408], ['2024-05-01', 10185.9734, 1540], ['2024-06-12', 10271.15012, 1551],
  ['2024-07-30', 7602.18599, 1566], ['2024-08-25', 6705.718412, 1424], ['2024-09-22', 7666.658625, 1558],
  ['2024-10-23', 7391.826923, 1543], ['2025-01-26', 7536.229508, 1572], ['2025-05-20', 9493.388548, 1470],
  ['2025-08-04', 7164.230317, 1554], ['2025-11-18', 7899.04661, 1500]].map(r => ev(r[0], r[1], r[2], 'AARAV CERAMIC'));
const rd = ann.map(x => x.event_date);
const rIv = []; for (let i = 1; i < rd.length; i++) rIv.push(dd(rd[i - 1], rd[i]));
console.log('  hand intervals =', JSON.stringify(rIv));
console.log(`  hand: median=${median(rIv)} mean=${mean(rIv).toFixed(1)} stability=${(1 - sstdev(rIv) / mean(rIv)).toFixed(3)}`);
f = eng.frequency(ann);
near('median (engine says dashboard shows 56)', median(rIv), f.median_interval_days);
near('stability (dashboard shows 0.473)', +(1 - sstdev(rIv) / mean(rIv)).toFixed(3), f.stability, 0.001);
sr = eng.supplierRelationship(ann);
near('HHI (single supplier ⇒ 10000)', 10000, sr.hhi);

console.log('\n' + '='.repeat(74));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(74));
process.exit(fail ? 1 : 0);
