// Run: node tools/sim.test.js
const assert = require('assert');
const { simulate } = require('../sim.js');
const data = require('../data/recipes.json');

const near = (a, b, msg) => assert(Math.abs(a - b) < 0.02 * Math.max(1, b), `${msg}: got ${a}, want ${b}`);
const miner = (id, ext = 'Build_MinerMk1_C', item = 'Desc_OreIron_C') => ({ id, type: 'extractor', extractor: ext, item, purity: 1 });
const m = (id, recipe, count = 1) => ({ id, type: 'machine', recipe, count, clock: 100 });
const e = (from, to, tier = 'Conveyor Belt Mk.1', item) => ({ id: from + '>' + to, from, to, tier, item });

// 1. chain: 60 ore -> smelter (30) -> 2 plate constructors (need 60 ingots)
let r = simulate({ nodes: [miner('a'), m('s', 'Recipe_IngotIron_C'), m('c', 'Recipe_IronPlate_C', 2), { id: 'k', type: 'sink' }],
  edges: [e('a', 's'), e('s', 'c'), e('c', 'k')] }, data);
near(r.nodes.s.util, 1, 'smelter full');
near(r.nodes.a.util, 0.5, 'miner backed up');
assert(r.nodes.a.why.startsWith('blocked'));
near(r.nodes.c.util, 0.5, 'constructors starved');
assert(r.nodes.c.why === 'starved:Desc_IronIngot_C');
near(r.nodes.k.in.Desc_IronPlate_C, 20, 'plates delivered');

// 2. splitter: 60 ore over 3 smelters -> 20 each
r = simulate({ nodes: [miner('a'), { id: 'sp', type: 'splitter' }, m('s1', 'Recipe_IngotIron_C'), m('s2', 'Recipe_IngotIron_C'), m('s3', 'Recipe_IngotIron_C')],
  edges: [e('a', 'sp'), e('sp', 's1'), e('sp', 's2'), e('sp', 's3')] }, data);
for (const s of ['s1', 's2', 's3']) near(r.nodes[s].util, 2 / 3, 'unconnected output goes to storage');
near(r.nodes.s1.unconnected.Desc_IronIngot_C, 20, 'unconnected output reported');
r = simulate({ nodes: [miner('a'), { id: 'sp', type: 'splitter' }, m('s1', 'Recipe_IngotIron_C'), m('s2', 'Recipe_IngotIron_C'), m('s3', 'Recipe_IngotIron_C'), { id: 'k', type: 'sink' }],
  edges: [e('a', 'sp'), e('sp', 's1'), e('sp', 's2'), e('sp', 's3'), e('s1', 'k'), e('s2', 'k'), e('s3', 'k')] }, data);
for (const s of ['s1', 's2', 's3']) near(r.nodes[s].util, 2 / 3, 'even split');
near(r.nodes.a.util, 1, 'miner fully used');

// 3. belt bottleneck: Mk2 miner (120) on a Mk1 belt (60)
r = simulate({ nodes: [miner('a', 'Build_MinerMk2_C'), { id: 'k', type: 'sink' }], edges: [e('a', 'k')] }, data);
near(r.edges['a>k'].util, 1, 'belt saturated');
near(r.nodes.a.util, 0.5, 'miner limited by belt');

// 4. unconnected byproduct is reported, not blocking
r = simulate({ nodes: [miner('o', 'Build_OilPump_C', 'Desc_LiquidOil_C'), m('p', 'Recipe_Plastic_C'), { id: 'k', type: 'sink' }],
  edges: [e('o', 'p', 'Pipeline Mk.1'), e('p', 'k', 'Conveyor Belt Mk.1', 'Desc_Plastic_C')] }, data);
near(r.nodes.p.util, 1, 'refinery runs');
near(r.nodes.p.unconnected.Desc_HeavyOilResidue_C, 10, 'residue reported as unconnected');
near(r.nodes.k.in.Desc_Plastic_C, 20, 'plastic delivered');

// 4b. user's case: 150 limestone on a Mk3 belt into 6 concrete constructors, output unconnected
r = simulate({ nodes: [{ id: 'l', type: 'input', item: 'Desc_Stone_C', rate: 150 }, m('c', 'Recipe_Concrete_C', 6)],
  edges: [e('l', 'c', 'Conveyor Belt Mk.3')] }, data);
near(r.edges['l>c'].total, 150, 'belt carries 150');
near(r.nodes.c.util, 150 / 270, 'constructors starved');
assert(r.nodes.c.why === 'starved:Desc_Stone_C');
near(r.nodes.l.util, 1, 'limestone fully used');

// 5. merger shares a limited belt fairly
r = simulate({ nodes: [miner('a'), miner('b'), { id: 'mg', type: 'merger' }, { id: 'k', type: 'sink' }],
  edges: [e('a', 'mg'), e('b', 'mg'), e('mg', 'k')] }, data);
near(r.nodes.a.util, 0.5, 'merger fair a');
near(r.nodes.b.util, 0.5, 'merger fair b');

// 6. loop doesn't explode: splitter feeding back into its own merger
r = simulate({ nodes: [miner('a'), { id: 'mg', type: 'merger' }, { id: 'sp', type: 'splitter' }, { id: 'k', type: 'sink' }],
  edges: [e('a', 'mg'), e('mg', 'sp', 'Conveyor Belt Mk.2'), e('sp', 'mg'), e('sp', 'k')] }, data);
near(r.nodes.k.in.Desc_OreIron_C, 60, 'loop delivers everything');

// 7. measured rate caps a belt: 120 ore on a Mk3 belt measured at 30 -> smelter gets 30
r = simulate({ nodes: [miner('a', 'Build_MinerMk2_C'), m('s', 'Recipe_IngotIron_C', 4)],
  edges: [{ ...e('a', 's', 'Conveyor Belt Mk.3'), measured: 30 }] }, data);
near(r.edges['a>s'].total, 30, 'measured belt carries 30');
near(r.nodes.s.util, 0.25, 'smelters see the measured rate');

// 8. user's case: splitter with a sink on one side and a measured 30/min belt on the other
r = simulate({ nodes: [{ id: 'w', type: 'input', item: 'Desc_Wire_C', rate: 180 }, { id: 'sp', type: 'splitter' }, m('c', 'Recipe_Cable_C', 6), { id: 'k', type: 'sink' }],
  edges: [e('w', 'sp', 'Conveyor Belt Mk.3'), { ...e('sp', 'c', 'Conveyor Belt Mk.3'), measured: 30 }, e('sp', 'k', 'Conveyor Belt Mk.3')] }, data);
near(r.edges['sp>c'].total, 30, 'limited splitter branch gets its full 30');
near(r.edges['sp>k'].total, 150, 'overflow goes to the sink');
for (const [id, E] of Object.entries(r.edges)) assert(E.total <= E.cap + 1e-6, `${id} over capacity`);

// 9. generators only consume: 60 fuel/min feeds 3 fuel generators (20 each), a 4th starves
r = simulate({ nodes: [{ id: 'f', type: 'input', item: 'Desc_LiquidFuel_C', rate: 60 }, m('g', 'Power_Build_GeneratorFuel_C_Desc_LiquidFuel_C', 4)],
  edges: [e('f', 'g', 'Pipeline Mk.1')] }, data);
near(r.nodes.g.util, 0.75, 'generators run on what fuel arrives');
assert(r.nodes.g.why === 'starved:Desc_LiquidFuel_C');

// 10. user's case: recycled water loop with more extractor water than needed must not deadlock
r = simulate({ nodes: [{ id: 'b', type: 'input', item: 'Desc_OreBauxite_C', rate: 600 }, { id: 'c', type: 'input', item: 'Desc_Coal_C', rate: 300 },
  { id: 'w', type: 'input', item: 'Desc_Water_C', rate: 720 }, { ...m('a', 'Recipe_AluminaSolution_C', 2), clock: 250 }, { ...m('s', 'Recipe_AluminumScrap_C'), clock: 250 }],
  edges: [e('b', 'a', 'Conveyor Belt Mk.5'), e('c', 's', 'Conveyor Belt Mk.5'), e('w', 'a', 'Pipeline Mk.2'),
    e('a', 's', 'Pipeline Mk.2', 'Desc_AluminaSolution_C'), e('s', 'a', 'Pipeline Mk.1', 'Desc_Water_C')] }, data);
near(r.nodes.a.util, 1, 'alumina refineries run full');
near(r.nodes.s.util, 1, 'scrap refinery runs full');
near(r.edges['s>a'].total, 300, 'all recycled water used');
near(r.nodes.w.util, 600 / 720, 'extractors throttle instead');

// 11. overflow splitter: 250 silica, foundry takes its 187.5 first, only the rest overflows to the sink
r = simulate({ nodes: [{ id: 'q', type: 'input', item: 'Desc_Silica_C', rate: 250 }, { id: 'x', type: 'input', item: 'Desc_AluminumScrap_C', rate: 600 },
  { id: 'sp', type: 'splitter' }, { ...m('f', 'Recipe_IngotAluminum_C'), clock: 250 }, { id: 'k', type: 'sink' }],
  edges: [e('q', 'sp', 'Conveyor Belt Mk.3'), e('x', 'f', 'Conveyor Belt Mk.5'), e('sp', 'f', 'Conveyor Belt Mk.3'), { ...e('sp', 'k', 'Conveyor Belt Mk.3'), overflow: true }] }, data);
near(r.edges['sp>f'].total, 187.5, 'foundry gets all it needs');
near(r.edges['sp>k'].total, 62.5, 'only the excess overflows');
near(r.nodes.f.util, 1, 'foundry full');

// 12. two inputs short at once are both reported: 240 coal of 260, 480 alumina of 520
r = simulate({ nodes: [{ id: 'al', type: 'input', item: 'Desc_AluminaSolution_C', rate: 480 }, { id: 'co', type: 'input', item: 'Desc_Coal_C', rate: 240 },
  { ...m('s', 'Recipe_AluminumScrap_C'), clock: 216.6667 }], edges: [e('al', 's', 'Pipeline Mk.2'), e('co', 's', 'Conveyor Belt Mk.3')] }, data);
assert.deepStrictEqual(r.nodes.s.short.sort(), ['Desc_AluminaSolution_C', 'Desc_Coal_C']);
assert.deepStrictEqual(simulate({ nodes: [miner('a'), m('s', 'Recipe_IngotIron_C')], edges: [e('a', 's')] }, data).nodes.s.short, [], 'full machine has no short inputs');
// a blocked machine's inputs are not short: 60 ore, smelter blocked by a 30-capped output belt
r = simulate({ nodes: [miner('a'), m('s', 'Recipe_IngotIron_C', 2), { id: 'k', type: 'sink' }],
  edges: [e('a', 's'), { ...e('s', 'k'), measured: 30 }] }, data);
assert.deepStrictEqual(r.nodes.s.short, [], 'blocked machine has no short inputs');

console.log('all sim tests passed');
