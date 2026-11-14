// Run: node tools/advice.test.js
const assert = require('assert');
const { simulate } = require('../sim.js');
global.DATA = require('../data/recipes.json');
const { valid, explain, plan } = require('../advice.js');

const run = g => { global.G = g; global.RES = simulate(g, DATA); return id => g.nodes.find(n => n.id === id); };
const m = (id, recipe, count = 1) => ({ id, type: 'machine', recipe, count, clock: 100 });
const e = (from, to, tier = 'Conveyor Belt Mk.1') => ({ id: from + '-' + to, from, to, tier });
const text = lines => lines.map(l => l.t ?? l).join('\n');

// 1. untrusted builds: ids and numbers that would break out of HTML are rejected
assert(valid({ nodes: [{ id: 'a1', type: 'sink', x: 0, y: 0 }], edges: [] }));
assert(!valid({ nodes: [], edges: [{ id: '"/><img src=x onerror=alert(1)>', from: 'a', to: 'b' }] }));
assert(!valid({ nodes: [{ id: 'a', type: 'machine', count: '1"><script>' }], edges: [] }));
assert(!valid(null));

// 2. starved with nothing connected: says so, and doesn't suggest underclocking to 0%
let get = run({ nodes: [m('s', 'Recipe_IngotIron_C')], edges: [] });
let ex = explain(get('s'));
assert(/Nothing feeds it Iron Ore/.test(text(ex.lines)), text(ex.lines));
assert(!/underclock/.test(text(ex.lines)), text(ex.lines));

// 3. blocked by a full belt: Mk2 miner (120) on a Mk1 belt (60)
get = run({ nodes: [{ id: 'a', type: 'extractor', extractor: 'Build_MinerMk2_C', item: 'Desc_OreIron_C', purity: 1, count: 1, clock: 100 }, { id: 'k', type: 'sink' }],
  edges: [e('a', 'k')] });
ex = explain(get('a'));
assert(/^Belt out is full/.test(ex.short), ex.short);

// 4. target planner with a feeder that makes 0: asks to raise it, never "enough"
get = run({ nodes: [{ id: 'i', type: 'input', item: 'Desc_OreIron_C', rate: 0 }, m('s', 'Recipe_IngotIron_C')], edges: [e('i', 's')] });
const p = text(plan(get('s'), 'Desc_IronIngot_C', 30));
assert(/raise it to 30 Iron Ore/.test(p), p);
assert(!/NaN/.test(p), p);

console.log('all advice tests passed');
