let DATA, G, RES = { nodes: {}, edges: {} }, sel = null;
const view = { x: 40, y: 40, k: 1 };
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmt = v => (Math.round(v * 10) / 10).toLocaleString();
const pct = v => Math.round(v * 100) + '%';
const itemName = i => DATA.items[i]?.name ?? i;
const recipe = id => DATA.recipes.find(r => r.id === id);
const extractor = id => DATA.extractors.find(e => e.id === id);
const tiers = () => [...DATA.belts, ...DATA.pipes];
const PURITY = { 0.5: 'Impure', 1: 'Normal', 2: 'Pure' };
const JUNCTIONS = ['splitter', 'merger'];
const nodeById = id => G.nodes.find(n => n.id === id);
const recipeLabel = r => `${r.name} — ${DATA.buildings[r.building]}`;

// ---------- persistence ----------
const save = () => { try { localStorage.setItem('ffp-graph', JSON.stringify(G)); } catch {} };
const loadLocal = () => { try { return JSON.parse(localStorage.getItem('ffp-graph')); } catch { return null; } };
const valid = g => g && Array.isArray(g.nodes) && Array.isArray(g.edges);

async function encode(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function decode(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const stream = new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

function sample() {
  const n = (type, x, y, p) => ({ id: uid(), type, x, y, ...p });
  const miner = n('extractor', 0, 120, { extractor: 'Build_MinerMk2_C', item: 'Desc_OreIron_C', purity: 1, count: 1, clock: 100 });
  const smelt = n('machine', 280, 120, { recipe: 'Recipe_IngotIron_C', count: 4, clock: 100 });
  const split = n('splitter', 540, 125, {});
  const plate = n('machine', 720, 30, { recipe: 'Recipe_IronPlate_C', count: 2, clock: 100 });
  const rod = n('machine', 720, 220, { recipe: 'Recipe_IronRod_C', count: 1, clock: 100 });
  const sink = n('sink', 1000, 125, { label: 'Storage' });
  const e = (a, b, tier) => ({ id: uid(), from: a.id, to: b.id, tier });
  return { nodes: [miner, smelt, split, plate, rod, sink],
    edges: [e(miner, smelt, 'Conveyor Belt Mk.1'), e(smelt, split, 'Conveyor Belt Mk.2'), e(split, plate, 'Conveyor Belt Mk.2'),
      e(split, rod, 'Conveyor Belt Mk.2'), e(plate, sink, 'Conveyor Belt Mk.2'), e(rod, sink, 'Conveyor Belt Mk.2')] };
}

// ---------- simulation ----------
let runTimer;
function changed() {
  save();
  clearTimeout(runTimer);
  runTimer = setTimeout(() => { RES = simulate(G, DATA); renderCanvas(); renderResults(); }, 60);
}

// ---------- canvas ----------
const world = $('#world'), wires = $('#wires'), viewport = $('#viewport');
const applyView = () => {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  viewport.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
};

function status(n) {
  const r = RES.nodes[n.id];
  if (JUNCTIONS.includes(n.type) || n.type === 'sink' || !r) return '';
  if (r.why === 'unconfigured') return 'idle';
  if (r.util >= 0.995) return 'ok';
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
    else if (dir === 'up' || m.type === 'sink' || RES.nodes[m.id]?.maxIn[item]) out.push(m);
  }
  return out;
}
const fullBelt = (id, dir, item) => G.edges.find(e => (dir === 'down' ? e.from : e.to) === id && (!e.item || e.item === item) && RES.edges[e.id]?.util >= 0.995);
// A full belt only matters if something waits on it: a backed-up node before it or a short node after it.
function beltLimits(e) {
  const r = RES.edges[e.id], items = Object.keys(r?.flow ?? {});
  const ends = (id, dir) => JUNCTIONS.includes(nodeById(id)?.type) ? items.flatMap(i => neighbours(id, dir, i)) : [nodeById(id)].filter(Boolean);
  return ends(e.from, 'up').some(m => status(m) === 'blocked') || ends(e.to, 'down').some(m => status(m) === 'starved');
}
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

// Plain-English "why is this not at 100% and what do I do about it". knock = caused by something else.
// Returns { lines, knock, short, root }: short = one-line cause for the node card, root = node with the real problem.
function explain(n, seen = new Set()) {
  const r = RES.nodes[n.id];
  if (!r || r.util === null || r.util >= 0.995 || !r.why || r.why === 'unconfigured' || seen.has(n.id)) return null;
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
      short = `Belt out is full (${full.tier.replace('Conveyor Belt ', '')})`;
      lines.push(`The belt leaving it (${full.tier}) is full at ${fmt(RES.edges[full.id].cap)}/min. Upgrade it or add a second belt.`);
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
      short = `Belt in is full (${full.tier.replace('Conveyor Belt ', '')})`;
      lines.push(`The belt coming in (${full.tier}) is full at ${fmt(RES.edges[full.id].cap)}/min. Upgrade it or add a second belt.`);
    } else if (!up.length) { short = `No ${name} connected`; lines.push(`Nothing feeds it ${name}. Connect a belt.`); }
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
    if (need < n.count) lines.push(`Or build less here: ${need} ${building(n, need)} would do the same job. Or keep all ${n.count} and underclock them to ${fmt(n.clock * r.util)}%.`);
    else if (n.count === 1) lines.push(`Or underclock it to ${fmt(n.clock * r.util)}% to save power.`);
  }
  return { lines, knock, short, root, rootWhy: rootWhy ?? short };
}

function nodeTitle(n) {
  if (n.type === 'machine') {
    const r = recipe(n.recipe);
    const clock = n.clock !== 100 ? ` @${n.clock}%` : '';
    return [(n.label || (r ? DATA.buildings[r.building] : 'Machine')) + ` ×${n.count}${clock}`, r ? r.name : 'pick a recipe'];
  }
  if (n.type === 'extractor') {
    const e = extractor(n.extractor);
    const clock = n.clock !== 100 ? ` @${n.clock}%` : '';
    return [`${n.label || e?.name || 'Extractor'} ×${n.count}${clock}`, `${itemName(n.item)} (${PURITY[n.purity] ?? n.purity})`];
  }
  if (n.type === 'input') return [n.label || 'Input', `${itemName(n.item) || 'pick an item'} · ${fmt(n.rate)}/min`];
  return [n.label || { splitter: 'Splitter', merger: 'Merger', sink: 'Sink / Output' }[n.type], ''];
}

function nodeHTML(n) {
  const r = RES.nodes[n.id], [t, s] = nodeTitle(n), st = status(n);
  let body = '';
  if (r && !JUNCTIONS.includes(n.type) && n.type !== 'sink' && r.why !== 'unconfigured')
    body += `<div class="u">${pct(r.util)}</div>`;
  if (r && st && st !== 'ok' && st !== 'idle') body += `<div class="r">${esc(explain(n)?.short ?? reasonText(r.why))}</div>`;
  if (r) {
    for (const i in r.maxIn) body += `<div class="r">▸ ${esc(itemName(i))} ${fmt(r.in[i])}/${fmt(r.maxIn[i])}</div>`;
    for (const i in r.maxOut) body += `<div class="r">◂ ${esc(itemName(i))} ${fmt(r.out[i])}/${fmt(r.maxOut[i])}${i in r.unconnected ? ' → storage' : ''}</div>`;
    if (n.type === 'sink' || JUNCTIONS.includes(n.type))
      for (const i in r.in) body += `<div class="r">${esc(itemName(i))} ${fmt(r.in[i])}/min</div>`;
  }
  const hasIn = !['extractor', 'input'].includes(n.type), hasOut = n.type !== 'sink';
  return `${hasIn ? '<div class="port in"></div>' : ''}<div class="t">${esc(t)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}${body}${hasOut ? '<div class="port out"></div>' : ''}`;
}

function renderCanvas() {
  world.querySelectorAll('.node').forEach(el => el.remove());
  for (const n of G.nodes) {
    const el = document.createElement('div');
    el.className = `node ${status(n)} ${JUNCTIONS.includes(n.type) ? 'junction' : ''} ${selectedIds().includes(n.id) ? 'sel' : ''}`;
    el.dataset.id = n.id;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    el.innerHTML = nodeHTML(n);
    world.appendChild(el);
  }
  renderWires();
}

function portPos(id, side) {
  const n = nodeById(id), el = world.querySelector(`.node[data-id="${id}"]`);
  return { x: n.x + (side === 'out' ? el.offsetWidth : 0), y: n.y + el.offsetHeight / 2 };
}
const curve = (a, b) => { const d = Math.max(40, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + d},${a.y} ${b.x - d},${b.y} ${b.x},${b.y}`; };

function renderWires(temp) {
  let svg = '';
  for (const e of G.edges) {
    if (!nodeById(e.from) || !nodeById(e.to)) continue;
    const a = portPos(e.from, 'out'), b = portPos(e.to, 'in'), d = curve(a, b), r = RES.edges[e.id];
    const full = r && r.util >= 0.995, state = full ? (beltLimits(e) ? 'full' : 'maxed') : r?.total > 0 ? 'flow' : 'none';
    const cls = `wire ${state} ${sel?.edge === e.id ? 'sel' : ''}`;
    const items = r ? Object.keys(r.flow).filter(i => r.flow[i] > 0.01) : [];
    const what = e.item ? itemName(e.item) : items.length === 1 ? itemName(items[0]) : items.length ? `${items.length} items` : '';
    const free = r ? r.cap - r.total : 0;
    const label = r ? `${what} ${fmt(r.total)}/${fmt(r.cap)}${!full && free > 0.05 ? ` · ${fmt(free)} free` : ''}` : '';
    svg += `<path class="hit" data-edge="${e.id}" d="${d}"/><path class="${cls}" d="${d}"/>` +
      `<text class="${full ? state : ''}" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 6}" text-anchor="middle">${esc(label)}</text>`;
  }
  if (temp) svg += `<path class="temp" d="${curve(temp.a, temp.b)}"/>`;
  wires.innerHTML = svg;
}

// ---------- interaction ----------
const toWorld = (cx, cy) => { const r = viewport.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
let drag = null;

const selectedIds = () => sel?.nodes ?? (sel?.node ? [sel.node] : []);
const selectNodes = ids => select(ids.length > 1 ? { nodes: ids } : ids.length ? { node: ids[0] } : null);
const boxEl = Object.assign(document.createElement('div'), { id: 'box' });
world.appendChild(boxEl);

viewport.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  const port = ev.target.closest('.port.out'), nodeEl = ev.target.closest('.node'), edge = ev.target.dataset?.edge;
  const p = toWorld(ev.clientX, ev.clientY);
  viewport.setPointerCapture(ev.pointerId);
  if (port) drag = { mode: 'wire', from: nodeEl.dataset.id };
  else if (nodeEl) {
    const id = nodeEl.dataset.id;
    let ids = selectedIds();
    if (ev.shiftKey) selectNodes(ids = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
    else if (!ids.includes(id)) select({ node: id }), ids = [id];
    // dragging any selected node moves the whole selection
    drag = { mode: 'node', start: p, click: id, shift: ev.shiftKey, moved: false,
      group: selectedIds().map(nodeById).map(n => ({ n, x: n.x, y: n.y })) };
  } else if (edge) select({ edge });
  else if (ev.shiftKey) drag = { mode: 'box', start: p, keep: selectedIds() };
  else { drag = { mode: 'pan', sx: ev.clientX - view.x, sy: ev.clientY - view.y, moved: false }; viewport.classList.add('panning'); }
});

let mouse = null, clip = null; // last pointer position in world coords (paste target), copied nodes + belts
viewport.addEventListener('pointerleave', () => { mouse = null; });
viewport.addEventListener('pointermove', ev => {
  const p = mouse = toWorld(ev.clientX, ev.clientY);
  if (!drag) return;
  if (drag.mode === 'pan') { view.x = ev.clientX - drag.sx; view.y = ev.clientY - drag.sy; drag.moved = true; applyView(); }
  else if (drag.mode === 'node') {
    drag.moved = true;
    for (const g of drag.group) {
      g.n.x = Math.round(g.x + p.x - drag.start.x); g.n.y = Math.round(g.y + p.y - drag.start.y);
      const el = world.querySelector(`.node[data-id="${g.n.id}"]`);
      el.style.left = g.n.x + 'px'; el.style.top = g.n.y + 'px';
    }
    renderWires();
  } else if (drag.mode === 'box') {
    const r = drag.rect = { x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
    Object.assign(boxEl.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  } else if (drag.mode === 'wire') renderWires({ a: portPos(drag.from, 'out'), b: p });
});

viewport.addEventListener('pointerup', ev => {
  if (!drag) return;
  viewport.classList.remove('panning');
  if (drag.mode === 'wire') {
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    const to = target && nodeById(target.dataset.id);
    if (to && to.id !== drag.from && !['extractor', 'input'].includes(to.type)) connect(drag.from, to.id);
    else renderWires();
  } else if (drag.mode === 'node') {
    if (drag.moved) save();
    else if (!drag.shift && drag.group.length > 1) select({ node: drag.click }); // plain click on a group member picks just it
  } else if (drag.mode === 'box') {
    boxEl.style.display = 'none';
    const r = drag.rect;
    const hit = r ? G.nodes.filter(n => {
      const el = world.querySelector(`.node[data-id="${n.id}"]`);
      return n.x < r.x + r.w && n.x + el.offsetWidth > r.x && n.y < r.y + r.h && n.y + el.offsetHeight > r.y;
    }).map(n => n.id) : [];
    selectNodes([...new Set([...drag.keep, ...hit])]);
  } else if (drag.mode === 'pan' && !drag.moved) select(null);
  drag = null;
});

viewport.addEventListener('wheel', ev => {
  ev.preventDefault();
  const r = viewport.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
  const k = Math.min(2.5, Math.max(0.2, view.k * Math.exp(-ev.deltaY * 0.0015)));
  view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
  applyView();
}, { passive: false });

document.addEventListener('keydown', ev => {
  if (ev.target.closest('input, select, textarea')) return;
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel) { ev.preventDefault(); removeSelected(); }
  if (ev.key === 'Escape') select(null);
  const mod = ev.ctrlKey || ev.metaKey, key = ev.key.toLowerCase();
  if (mod && key === 'a') { ev.preventDefault(); selectNodes(G.nodes.map(n => n.id)); }
  if (mod && key === 'c' && selectedIds().length) clip = copySelection();
  if (mod && key === 'v' && clip) {
    ev.preventDefault();
    // paste with the group's top-left under the cursor, or offset from the original when the cursor is off the board
    if (mouse) paste(clip, mouse.x - 20 - clip.x, mouse.y - 20 - clip.y);
    else { clip.shift += 30; paste(clip, clip.shift, clip.shift); }
  }
});

function copySelection() {
  const ids = selectedIds(), nodes = ids.map(nodeById).map(n => ({ ...n }));
  return { nodes, edges: G.edges.filter(e => ids.includes(e.from) && ids.includes(e.to)).map(e => ({ ...e })),
    x: Math.min(...nodes.map(n => n.x)), y: Math.min(...nodes.map(n => n.y)), shift: 0 };
}

function paste(c, dx, dy) {
  const map = {};
  for (const n of c.nodes) { map[n.id] = uid(); G.nodes.push({ ...n, id: map[n.id], x: Math.round(n.x + dx), y: Math.round(n.y + dy) }); }
  for (const e of c.edges) G.edges.push({ ...e, id: uid(), from: map[e.from], to: map[e.to] });
  renderCanvas(); selectNodes(Object.values(map)); changed();
}

function connect(from, to) {
  const src = nodeById(from);
  let item = null;
  if (src.type === 'machine') { // pin one product per output, like the game's fixed output ports
    const outs = recipe(src.recipe)?.out.map(o => o[0]) ?? [];
    if (outs.length > 1) item = outs.find(i => !G.edges.some(e => e.from === from && e.item === i)) ?? outs[0];
  }
  const carried = item ? [item] : src.type === 'machine' ? recipe(src.recipe)?.out.map(o => o[0]) ?? []
    : src.item ? [src.item] : Object.keys(RES.nodes[from]?.in ?? {});
  const fluid = carried.length > 0 && carried.every(i => DATA.items[i]?.fluid);
  const e = { id: uid(), from, to, tier: fluid ? $('#defPipe').value : $('#defBelt').value, item };
  G.edges.push(e);
  select({ edge: e.id });
  changed();
}

function addNode(type) {
  const r = viewport.getBoundingClientRect(), c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const defaults = {
    machine: { recipe: null, count: 1, clock: 100 },
    extractor: { extractor: 'Build_MinerMk1_C', item: 'Desc_OreIron_C', purity: 1, count: 1, clock: 100 },
    input: { item: null, rate: 60 },
  };
  const n = { id: uid(), type, x: Math.round(c.x - 80 + Math.random() * 40), y: Math.round(c.y - 30 + Math.random() * 40), ...defaults[type] };
  G.nodes.push(n);
  select({ node: n.id });
  changed();
}

function removeSelected() {
  const ids = selectedIds();
  G.nodes = G.nodes.filter(n => !ids.includes(n.id));
  G.edges = G.edges.filter(e => !ids.includes(e.from) && !ids.includes(e.to));
  if (sel?.edge) G.edges = G.edges.filter(e => e.id !== sel.edge);
  select(null);
  changed();
}

function select(s) {
  sel = s;
  world.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', selectedIds().includes(el.dataset.id)));
  renderWires();
  renderForm();
  renderResults();
}

function focusNode(id) {
  const n = nodeById(id), r = viewport.getBoundingClientRect();
  view.x = r.width / 2 - (n.x + 90) * view.k; view.y = r.height / 2 - (n.y + 40) * view.k;
  applyView(); select({ node: id });
}

// ---------- side panel ----------
const field = (label, html) => `<label class="f">${label}${html}</label>`;
const options = (list, cur) => list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</option>`).join('');
const allItems = () => Object.entries(DATA.items).map(([id, it]) => [id, it.name]).sort((a, b) => a[1].localeCompare(b[1]));

function renderForm() {
  const f = $('#form');
  if (sel?.node) {
    const n = nodeById(sel.node);
    let h = `<h2>${esc(nodeTitle(n)[0])}</h2>` + field('Label', `<input data-k="label" value="${esc(n.label)}" placeholder="optional name">`);
    if (n.type === 'machine') {
      const r = recipe(n.recipe);
      h += field('Recipe', `<input data-k="recipe" list="recipeList" value="${esc(r ? recipeLabel(r) : '')}" placeholder="type to search…">`);
      h += field('Machines', `<input data-k="count" type="number" min="1" step="1" value="${n.count}">`);
      h += field('Clock speed %', `<input data-k="clock" type="number" min="1" max="250" step="any" value="${n.clock}">`);
      if (r) h += `<div class="muted">Per machine @100%: ${r.in.map(([i, a]) => `${fmt(a * 60 / r.time)} ${esc(itemName(i))}`).join(' + ')} → ${r.out.map(([i, a]) => `${fmt(a * 60 / r.time)} ${esc(itemName(i))}`).join(' + ')} /min</div>`;
    } else if (n.type === 'extractor') {
      const ex = extractor(n.extractor);
      h += field('Building', `<select data-k="extractor">${options(DATA.extractors.map(e => [e.id, e.name]), n.extractor)}</select>`);
      h += field('Resource', `<select data-k="item">${options(ex.allowed.map(i => [i, itemName(i)]), n.item)}</select>`);
      h += field('Node purity', `<select data-k="purity" data-num>${options(Object.entries(PURITY), n.purity)}</select>`);
      h += field('Count', `<input data-k="count" type="number" min="1" step="1" value="${n.count}">`);
      h += field('Clock speed %', `<input data-k="clock" type="number" min="1" max="250" step="any" value="${n.clock}">`);
    } else if (n.type === 'input') {
      h += field('Item', `<select data-k="item"><option value="">—</option>${options(allItems(), n.item)}</select>`);
      h += field('Rate /min', `<input data-k="rate" type="number" min="0" step="any" value="${n.rate}">`);
      h += `<div class="muted">Use for trains, trucks, drones or another factory feeding this one.</div>`;
    }
    h += `<div class="row"><button id="dupBtn">Duplicate</button><button class="danger" id="delBtn">Delete</button></div>`;
    f.innerHTML = h;
  } else if (sel?.edge) {
    const e = G.edges.find(x => x.id === sel.edge), src = nodeById(e.from);
    const outs = src.type === 'machine' ? recipe(src.recipe)?.out.map(o => [o[0], itemName(o[0])]) ?? [] : allItems();
    f.innerHTML = `<h2>${esc(nodeTitle(src)[0])} → ${esc(nodeTitle(nodeById(e.to))[0])}</h2>` +
      field('Belt / pipe', `<select data-k="tier">${options(tiers().map(t => [t.name, `${t.name} (${t.rate}/min)`]), e.tier)}</select>`) +
      field(src.type === 'machine' ? 'Output port carries' : 'Only carry (smart splitter filter)',
        `<select data-k="item"><option value="">Any</option>${options(outs, e.item)}</select>`) +
      `<div class="row"><button class="danger" id="delBtn">Delete</button></div>`;
  } else if (sel?.nodes) {
    f.innerHTML = `<h2>${sel.nodes.length} nodes selected</h2><div class="muted">Drag any of them to move the group. Ctrl+C / Ctrl+V copies them with the belts between them. Shift+click adds or removes a node.</div>` +
      `<div class="row"><button id="dupBtn">Duplicate</button><button class="danger" id="delBtn">Delete</button></div>`;
  } else f.innerHTML = '';

  f.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
    const obj = sel.node ? nodeById(sel.node) : G.edges.find(x => x.id === sel.edge), k = inp.dataset.k;
    let v = inp.value;
    if (k === 'recipe') { const r = DATA.recipes.find(r => recipeLabel(r) === v); if (!r) return; v = r.id; }
    else if (inp.type === 'number' || inp.dataset.num !== undefined) {
      v = Number(v);
      if (k === 'clock') v = Math.min(250, Math.max(1, v || 100));
      if (k === 'count') v = Math.max(1, Math.round(v) || 1);
      if (k === 'rate') v = Math.max(0, v || 0);
    } else if (v === '') v = k === 'label' ? '' : null;
    obj[k] = v;
    if (k === 'extractor' && !extractor(v).allowed.includes(obj.item)) obj.item = extractor(v).allowed[0];
    renderCanvas(); renderForm(); changed();
  }));
  $('#delBtn')?.addEventListener('click', removeSelected);
  $('#dupBtn')?.addEventListener('click', () => paste(copySelection(), 30, 30));
}

function rateTable(rows) {
  return rows.length ? `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td class="n">${b}</td></tr>`).join('')}</table>` : '<div class="muted">—</div>';
}

function renderResults() {
  const el = $('#results');
  if (sel?.node) {
    const n = nodeById(sel.node), r = RES.nodes[sel.node];
    if (!r) return el.innerHTML = '';
    let h = '';
    const ex = explain(n);
    if (r.util !== null && n.type !== 'sink') h += `<h3>Running at ${pct(r.util)}</h3>` +
      (ex ? `<div><b>${esc(reasonText(r.why))}</b></div>${ex.lines.map(l => `<p class="ex">${esc(l)}</p>`).join('')}` : '');
    if (Object.keys(r.maxIn).length) h += `<h3>Consumes /min</h3>` + rateTable(Object.keys(r.maxIn).map(i => [esc(itemName(i)), `${fmt(r.in[i])} / ${fmt(r.maxIn[i])}`]));
    if (Object.keys(r.maxOut).length) h += `<h3>Produces /min</h3>` + rateTable(Object.keys(r.maxOut).map(i => [esc(itemName(i)) + (i in r.unconnected ? ' <span class="muted">(not connected, counted as storage)</span>' : ''), `${fmt(r.out[i])} / ${fmt(r.maxOut[i])}`]));
    if (n.type === 'sink' || JUNCTIONS.includes(n.type)) h += `<h3>Throughput /min</h3>` + rateTable(Object.entries(r.in).map(([i, v]) => [esc(itemName(i)), fmt(v)]));
    el.innerHTML = h;
  } else if (sel?.edge) {
    const r = RES.edges[sel.edge];
    el.innerHTML = r ? `<h3>Carrying ${fmt(r.total)} / ${fmt(r.cap)} per min (${pct(r.util)})</h3>` +
      rateTable(Object.entries(r.flow).map(([i, v]) => [esc(itemName(i)), fmt(v)])) : '';
  } else {
    const issues = [];
    for (const e of G.edges) {
      const r = RES.edges[e.id];
      if (r && r.util >= 0.995 && beltLimits(e)) issues.push({ bad: true, node: e.from, edge: e.id, txt: `<b>Belt full</b> ${esc(nodeTitle(nodeById(e.from))[0])} → ${esc(nodeTitle(nodeById(e.to))[0])}: ${fmt(r.total)}/${fmt(r.cap)} (${esc(e.tier)})` +
        `<p class="ex">This belt is full and something next to it is waiting on it. Upgrade the belt or add a second one.</p>` });
    }
    const under = G.nodes.filter(n => ['machine', 'extractor', 'input'].includes(n.type) && RES.nodes[n.id] && RES.nodes[n.id].util < 0.995)
      .map(n => ({ n, r: RES.nodes[n.id], ex: explain(n) }))
      .sort((a, b) => (a.ex?.knock ?? 0) - (b.ex?.knock ?? 0) || a.r.util - b.r.util); // real causes first, knock-on effects last
    for (const { n, r, ex } of under) {
      issues.push({ bad: r.why?.startsWith('blocked'), knock: ex?.knock, node: n.id,
        txt: `<b>${pct(r.util)}</b> ${esc(nodeTitle(n)[0])}: ${esc(reasonText(r.why))}` + (ex?.lines ?? []).map(l => `<p class="ex">${esc(l)}</p>`).join('') });
    }
    const sinks = {};
    for (const n of G.nodes) {
      const r = RES.nodes[n.id];
      for (const [i, v] of Object.entries((n.type === 'sink' ? r?.in : r?.unconnected) ?? {})) sinks[i] = (sinks[i] || 0) + v;
    }
    el.innerHTML = `<h2>Overview</h2><h3>Bottlenecks & underused (${issues.length})</h3>` +
      (issues.length ? issues.map((x, k) => `<div class="issue ${x.bad ? 'bad' : ''} ${x.knock ? 'knock' : ''}" data-k="${k}">${x.txt}</div>`).join('') : '<div class="muted">Everything runs at 100%.</div>') +
      `<h3>Factory output /min</h3>` + rateTable(Object.entries(sinks).map(([i, v]) => [esc(itemName(i)), fmt(v)])) +
      `<div class="muted">Sinks plus any output with no belt attached (counted as going to storage).</div>` +
      `<h3>How to read it</h3><div class="muted">Green = running at 100%. Yellow = not enough input coming in. Red = makes more than the next step can use, so it slows down. Red belts are full and slowing something down. Yellow belts are exactly full with nothing waiting: perfect, but no room to grow. Numbers are actual / maximum per minute. Problems marked as knock-on effects are caused by another problem; fix the ones at the top first.</div>`;
    el.querySelectorAll('.issue').forEach(d => d.addEventListener('click', () => {
      const x = issues[d.dataset.k]; focusNode(x.node); if (x.edge) select({ edge: x.edge });
    }));
  }
}

// ---------- toolbar ----------
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => addNode(b.dataset.add)));
$('#exportBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(G, null, 1)], { type: 'application/json' }));
  a.download = 'factory.json'; a.click(); URL.revokeObjectURL(a.href);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  try { const g = JSON.parse(await file.text()); if (!valid(g)) throw 0; G = g; select(null); renderCanvas(); changed(); }
  catch { alert('That file is not a planner export.'); }
});
$('#shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#g=${await encode(G)}`;
  try { await navigator.clipboard.writeText(url); alert('Share link copied to clipboard.'); } catch { prompt('Copy this link:', url); }
});
$('#clearBtn').addEventListener('click', () => {
  if (!confirm('Delete every node and belt? Export first if you want to keep it.')) return;
  G = { nodes: [], edges: [] }; select(null); renderCanvas(); changed();
});

// ---------- boot ----------
(async () => {
  DATA = await (await fetch('data/recipes.json')).json();
  $('#defBelt').innerHTML = options(DATA.belts.map(b => [b.name, b.name.replace('Conveyor Belt ', '')]), 'Conveyor Belt Mk.1');
  $('#defPipe').innerHTML = options(DATA.pipes.map(b => [b.name, b.name.replace('Pipeline ', '')]), 'Pipeline Mk.1');
  const dl = document.createElement('datalist'); dl.id = 'recipeList';
  dl.innerHTML = DATA.recipes.map(r => `<option value="${esc(recipeLabel(r))}">`).join('');
  document.body.appendChild(dl);

  G = loadLocal();
  if (location.hash.startsWith('#g=')) {
    try {
      const shared = await decode(location.hash.slice(3));
      if (valid(shared) && (!valid(G) || !G.nodes.length || confirm('Open the shared build? It replaces the one saved in this browser.'))) G = shared;
    } catch { alert('The share link is damaged.'); }
    history.replaceState(null, '', location.pathname);
  }
  if (!valid(G)) G = sample();
  applyView(); renderCanvas(); select(null); changed();
})();
