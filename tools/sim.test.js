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

console.log('all sim tests passed');
