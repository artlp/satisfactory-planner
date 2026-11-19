// What the planner tells you: status, plain-English causes and the target planner.
// No DOM here. It reads the globals DATA, G and RES that app.js sets; tests set them on `global`.
const fmt = v => (Math.round(v * 10) / 10).toLocaleString();
const itemName = i => DATA.items[i]?.name ?? i;
const recipe = id => DATA.recipes.find(r => r.id === id);
const extractor = id => DATA.extractors.find(e => e.id === id);
const PURITY = { 0.5: 'Impure', 1: 'Normal', 2: 'Pure' };
const JUNCTIONS = ['splitter', 'merger'];
const nodeById = id => G.nodes.find(n => n.id === id);
// A build from a share link or a file is untrusted, and its ids and numbers end up in HTML, so check them.
const ID = /^[\w-]+$/, num = v => v == null || Number.isFinite(v);
const valid = g => !!g && Array.isArray(g.nodes) && Array.isArray(g.edges) &&
  g.nodes.every(n => n && ID.test(n.id) && typeof n.type === 'string' && ['x', 'y', 'count', 'clock', 'rate', 'target', 'purity', 'sloops'].every(k => num(n[k]))) &&
  g.edges.every(e => e && ID.test(e.id) && ID.test(e.from) && ID.test(e.to) && num(e.measured)) &&
  (g.zones === undefined || Array.isArray(g.zones) && g.zones.every(z => z && ID.test(z.id) && /^#[0-9a-f]{6}$/i.test(z.color) &&
    ['x', 'y', 'w', 'h'].every(k => Number.isFinite(z[k]))));
const FULL = 0.995; // at or above this a machine counts as 100% and a belt as full

function status(n) {
  const r = RES.nodes[n.id];
  if (JUNCTIONS.includes(n.type) || n.type === 'sink' || !r) return '';
  if (r.why === 'unconfigured') return 'idle';
  if (r.util >= FULL) return 'ok';
  return r.why?.startsWith('blocked') ? 'blocked' : 'starved';
}

function reasonText(why) {
  if (!why) return '';
  const [k, i] = why.split(':');
  if (k === 'starved') return `Not enough ${itemName(i)} coming in`;
  if (k === 'blocked') return `Makes more ${itemName(i)} than gets used`;
  return 'Not configured';
}

// Nodes that feed (dir 'up') or take (dir 'down') `item` from node `id`, looking through splitters/mergers.
function neighbours(id, dir, item, seen = new Set([id])) {
  const out = [];
  for (const e of G.edges) {
    const [here, there] = dir === 'down' ? [e.from, e.to] : [e.to, e.from];
    if (here !== id || (e.item && e.item !== item) || seen.has(there)) continue;
    seen.add(there);
    const m = nodeById(there);
    if (!m) continue;
    if (JUNCTIONS.includes(m.type)) out.push(...neighbours(there, dir, item, seen));
    else if (dir === 'up' ? RES.nodes[m.id]?.maxOut[item] !== undefined : m.type === 'sink' || RES.nodes[m.id]?.maxIn[item]) out.push(m);
  }
  return out;
}
// Items that can reach node id: what upstream nodes make, through junctions and smart-splitter filters.
function arriving(id, seen = new Set([id])) {
  return [...new Set(G.edges.filter(e => e.to === id && !seen.has(e.from) && seen.add(e.from)).flatMap(e => {
    const m = nodeById(e.from), items = m && JUNCTIONS.includes(m.type) ? arriving(m.id, seen) : Object.keys(RES.nodes[e.from]?.maxOut ?? {});
    return e.item ? items.filter(i => i === e.item) : items;
  }))];
}
// A recipe in the same building, making the same thing, that runs on what actually arrives.
const betterRecipe = (n, got) => {
  const r = recipe(n.recipe), makes = r?.out.map(o => o[0]) ?? [];
  return DATA.recipes.filter(x => x.id !== r?.id && x.building === r?.building && x.out.some(o => makes.includes(o[0])) && x.in.every(([i]) => got.includes(i)))
    .sort((a, b) => a.alt - b.alt)[0];
};
const fullBelt = (id, dir, item) => G.edges.find(e => (dir === 'down' ? e.from : e.to) === id && (!e.item || e.item === item) && RES.edges[e.id]?.util >= FULL);
// A full belt only matters if something waits on it: a backed-up node before it or a short node after it.
function beltLimits(e) {
  const r = RES.edges[e.id], items = Object.keys(r?.flow ?? {});
  const ends = (id, dir) => JUNCTIONS.includes(nodeById(id)?.type) ? items.flatMap(i => neighbours(id, dir, i)) : [nodeById(id)].filter(Boolean);
  return ends(e.from, 'up').some(m => status(m) === 'blocked') || ends(e.to, 'down').some(m => status(m) === 'starved');
}
const beltName = e => e.measured ? `${e.tier}, measured ${fmt(e.measured)}/min` : e.tier;
const beltFix = e => e.measured ? 'That is your measured rate, so check in game what holds that belt back.' : 'Upgrade it or add a second belt.';
const names = list => list.map(m => nodeTitle(m)[0]).join(', ');
const building = (n, k) => {
  const b = n.type === 'machine' ? DATA.buildings[recipe(n.recipe)?.building] ?? 'machine' : extractor(n.extractor)?.name ?? 'building';
  return k > 1 ? b.replace(/y$/, 'ie') + 's' : b;
};
// How many more of node m it takes to move `amount` more of `item` per minute.
const moreOf = (m, item, amount, side) => {
  const per = (RES.nodes[m.id]?.[side][item] ?? 0) / (m.count || 1);
  return per > 0 && ['machine', 'extractor'].includes(m.type) ? Math.ceil(amount / per - 1e-6) : 0;
};

const mainItem = n => n.type === 'machine' ? recipe(n.recipe)?.out[0]?.[0] : n.type === 'extractor' ? n.item : null;
// What has to change, working back up the belts, for node n to put out `rate` of `item` per minute.
// shortcut: extra demand is split over feeders by their max output and assumes splitters send it this way,
// and only belts straight into a node are checked; upgrade if people need exact splitter ratios.
function plan(n, item, rate, lines = [], depth = 0, seen = new Set()) {
  const r = RES.nodes[n.id], max = r?.maxOut[item] ?? 0;
  if (!r || seen.has(n.id)) return lines;
  seen.add(n.id);
  const say = t => lines.push({ depth, t }), title = nodeTitle(n)[0], name = itemName(item);
  if (n.type === 'input') {
    say(rate > max + 0.05 ? `${title}: raise it to ${fmt(rate)} ${name}/min (now ${fmt(max)}).` : `${title}: enough, it brings ${fmt(max)}/min.`);
    return lines;
  }
  if (!max) return lines;
  if (rate > max + 0.05) {
    const k = Math.ceil(rate / (max / n.count) - 1e-6), clock = n.clock * rate / max;
    say(`${title}: needs to make ${fmt(rate)} ${name}/min but tops out at ${fmt(max)}. Build ${k} instead of ${n.count}` +
      (clock <= 250 ? `, or overclock ${n.count > 1 ? `all ${n.count}` : 'it'} to ${fmt(clock)}%.` : '.'));
  } else say(`${title}: enough ${building(n, n.count)} for ${fmt(rate)} ${name}/min (max ${fmt(max)}).`);
  if (depth === 0 && r.why?.startsWith('blocked')) say(`Its output is backed up now, so whatever comes after it must take the extra too.`);
  for (const i in r.maxIn) {
    const need = r.maxIn[i] * rate / max, extra = need - r.in[i];
    if (extra <= 0.05) continue;
    say(`Needs ${fmt(need)} ${itemName(i)}/min, gets ${fmt(r.in[i])}: ${fmt(extra)}/min more.`);
    const belts = G.edges.filter(e => e.to === n.id && (e.item === i || RES.edges[e.id]?.flow[i]));
    const cap = belts.reduce((a, e) => a + RES.edges[e.id].cap, 0);
    if (belts.length && cap < need - 0.05) say(`The belt${belts.length > 1 ? 's' : ''} into it carry only ${fmt(cap)}/min. Upgrade or add a belt.`);
    const up = neighbours(n.id, 'up', i), total = up.reduce((a, m) => a + RES.nodes[m.id].maxOut[i], 0);
    if (!up.length) say(`Nothing feeds it ${itemName(i)}. Connect a source.`);
    for (const m of up) plan(m, i, RES.nodes[m.id].out[i] + extra * (total ? RES.nodes[m.id].maxOut[i] / total : 1 / up.length), lines, depth + 1, seen);
  }
  return lines;
}

// Plain-English "why is this not at 100% and what do I do about it". knock = caused by something else.
// Returns { lines, knock, short, root }: short = one-line cause for the node card, root = node with the real problem.
function explain(n, seen = new Set()) {
  const r = RES.nodes[n.id];
  if (!r || r.util === null || r.util >= FULL || !r.why || r.why === 'unconfigured' || seen.has(n.id)) return null;
  seen.add(n.id);
  const [kind, item] = r.why.split(':'), name = itemName(item), lines = [];
  let knock = false, short = reasonText(r.why), root = n, rootWhy = null;
  // follow a knock-on chain to the node that actually has the problem
  const blame = (list, verb) => {
    const ex = list.map(m => explain(m, seen)).find(Boolean);
    root = ex?.root ?? list[0];
    const why = rootWhy = ex ? ex.rootWhy : verb;
    short = `Held back by ${nodeTitle(root)[0]}`;
    lines.push(`This is a knock-on effect, not a problem here. The real cause is ${nodeTitle(root)[0]} (${why}). Fix that and this speeds up too.`);
  };
  if (kind === 'blocked') {
    const made = r.out[item], extra = r.maxOut[item] - made, full = fullBelt(n.id, 'down', item), down = neighbours(n.id, 'down', item);
    lines.push(`It could make ${fmt(r.maxOut[item])} ${name}/min, but only ${fmt(made)}/min gets taken away.`);
    if (full) {
      short = `Belt out is full (${beltName(full).replace('Conveyor Belt ', '')})`;
      lines.push(`The belt leaving it (${beltName(full)}) is full at ${fmt(RES.edges[full.id].cap)}/min. ${beltFix(full)}`);
    } else if (!down.length) { short = `Nothing uses its ${name}`; lines.push(`Nothing connected after it uses ${name}.`); }
    else if (down.every(m => status(m) === 'blocked')) { knock = true; blame(down, 'makes more than gets used'); }
    else {
      short = `${names(down)} can't use more`;
      lines.push(`${names(down)} only use${down.length > 1 ? '' : 's'} ${fmt(made)}/min of it.`);
      const k = down.length === 1 ? moreOf(down[0], item, extra, 'maxIn') : 0;
      if (k) lines.push(`Fix: add ${k} more ${building(down[0], k)} after it to use the extra ${fmt(extra)}/min.`);
    }
  } else if (kind === 'starved') {
    const got = r.in[item], missing = r.maxIn[item] - got, full = fullBelt(n.id, 'up', item), up = neighbours(n.id, 'up', item);
    lines.push(`It needs ${fmt(r.maxIn[item])} ${name}/min but only gets ${fmt(got)}/min, ${fmt(missing)}/min short.`);
    if (full) {
      short = `Belt in is full (${beltName(full).replace('Conveyor Belt ', '')})`;
      lines.push(`The belt coming in (${beltName(full)}) is full at ${fmt(RES.edges[full.id].cap)}/min. ${beltFix(full)}`);
    } else if (!up.length) {
      const got = n.type === 'machine' ? arriving(n.id) : [], alt = got.length && betterRecipe(n, got);
      short = alt ? `Wrong recipe? Try ${alt.name}` : `No ${name} connected`;
      if (got.length) lines.push(`It gets ${got.map(itemName).join(', ')}, but its recipe needs ${name}.`);
      lines.push(alt ? `Fix: switch the recipe to ${alt.name}, which uses ${alt.in.map(([i]) => itemName(i)).join(' + ')}.` : `Nothing feeds it ${name}. Connect a belt.`);
    }
    else if (up.every(m => status(m) === 'starved')) { knock = true; blame(up, 'gets too little input'); }
    else {
      short = `${names(up)} send${up.length > 1 ? '' : 's'} too little ${name}`;
      lines.push(`${names(up)} only suppl${up.length > 1 ? 'y' : 'ies'} ${fmt(got)}/min.`);
      const k = up.length === 1 ? moreOf(up[0], item, missing, 'maxOut') : 0;
      if (k) lines.push(`Fix: add ${k} more ${building(up[0], k)} before it to cover the missing ${fmt(missing)}/min.`);
    }
  }
  if (!knock && ['machine', 'extractor'].includes(n.type)) {
    const need = Math.ceil(n.count * r.util - 1e-6);
    if (need < n.count && need > 0) lines.push(`Or build less here: ${need} ${building(n, need)} would do the same job. Or keep all ${n.count} and underclock them to ${fmt(n.clock * r.util)}%.`);
    else if (n.count === 1 && r.util > 0) lines.push(`Or underclock it to ${fmt(n.clock * r.util)}% to save power.`);
  }
  return { lines, knock, short, root, rootWhy: rootWhy ?? short };
}

function nodeTitle(n) {
  if (n.type === 'machine') {
    const r = recipe(n.recipe);
    const clock = n.clock !== 100 ? ` @${n.clock}%` : '', sl = n.sloops ? ` ✦${n.sloops}` : '';
    return [(n.label || (r ? DATA.buildings[r.building] : 'Machine')) + ` ×${n.count}${clock}${sl}`, r ? r.name : 'pick a recipe'];
  }
  if (n.type === 'extractor') {
    const e = extractor(n.extractor);
    const clock = n.clock !== 100 ? ` @${n.clock}%` : '';
    return [`${n.label || e?.name || 'Extractor'} ×${n.count}${clock}`, `${itemName(n.item)} (${PURITY[n.purity] ?? n.purity})`];
  }
  if (n.type === 'input') return [n.label || 'Input', `${itemName(n.item) || 'pick an item'} · ${fmt(n.rate)}/min`];
  return [n.label || { splitter: 'Splitter', merger: 'Merger', sink: 'Sink / Output' }[n.type], ''];
}

if (typeof module !== 'undefined') module.exports = { valid, status, explain, plan, nodeTitle };
