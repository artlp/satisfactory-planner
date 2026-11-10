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
  if (k === 'starved') return `Starved of ${itemName(i)}`;
  if (k === 'blocked') return `Output backed up: ${itemName(i)}`;
  return 'Not configured';
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
  if (r && st && st !== 'ok' && st !== 'idle') body += `<div class="r">${esc(reasonText(r.why))}</div>`;
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
    el.className = `node ${status(n)} ${JUNCTIONS.includes(n.type) ? 'junction' : ''} ${sel?.node === n.id ? 'sel' : ''}`;
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
    const full = r && r.util >= 0.995, cls = `wire ${full ? 'full' : r?.total > 0 ? 'flow' : 'none'} ${sel?.edge === e.id ? 'sel' : ''}`;
    const items = r ? Object.keys(r.flow).filter(i => r.flow[i] > 0.01) : [];
    const what = e.item ? itemName(e.item) : items.length === 1 ? itemName(items[0]) : items.length ? `${items.length} items` : '';
    const free = r ? r.cap - r.total : 0;
    const label = r ? `${what} ${fmt(r.total)}/${fmt(r.cap)}${!full && free > 0.05 ? ` · ${fmt(free)} free` : ''}` : '';
    svg += `<path class="hit" data-edge="${e.id}" d="${d}"/><path class="${cls}" d="${d}"/>` +
      `<text class="${full ? 'full' : ''}" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 6}" text-anchor="middle">${esc(label)}</text>`;
  }
  if (temp) svg += `<path class="temp" d="${curve(temp.a, temp.b)}"/>`;
  wires.innerHTML = svg;
}

// ---------- interaction ----------
const toWorld = (cx, cy) => { const r = viewport.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k }; };
let drag = null;

viewport.addEventListener('pointerdown', ev => {
  if (ev.button !== 0) return;
  const port = ev.target.closest('.port.out'), nodeEl = ev.target.closest('.node'), edge = ev.target.dataset?.edge;
  viewport.setPointerCapture(ev.pointerId);
  if (port) drag = { mode: 'wire', from: nodeEl.dataset.id };
  else if (nodeEl) {
    const n = nodeById(nodeEl.dataset.id), p = toWorld(ev.clientX, ev.clientY);
    drag = { mode: 'node', n, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    select({ node: n.id });
  } else if (edge) select({ edge });
  else { drag = { mode: 'pan', sx: ev.clientX - view.x, sy: ev.clientY - view.y, moved: false }; viewport.classList.add('panning'); }
});

viewport.addEventListener('pointermove', ev => {
  if (!drag) return;
  const p = toWorld(ev.clientX, ev.clientY);
  if (drag.mode === 'pan') { view.x = ev.clientX - drag.sx; view.y = ev.clientY - drag.sy; drag.moved = true; applyView(); }
  else if (drag.mode === 'node') {
    drag.n.x = Math.round(p.x - drag.dx); drag.n.y = Math.round(p.y - drag.dy); drag.moved = true;
    const el = world.querySelector(`.node[data-id="${drag.n.id}"]`);
    el.style.left = drag.n.x + 'px'; el.style.top = drag.n.y + 'px';
    renderWires();
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
  } else if (drag.mode === 'node' && drag.moved) save();
  else if (drag.mode === 'pan' && !drag.moved) select(null);
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
});

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
  if (sel?.node) { G.nodes = G.nodes.filter(n => n.id !== sel.node); G.edges = G.edges.filter(e => e.from !== sel.node && e.to !== sel.node); }
  if (sel?.edge) G.edges = G.edges.filter(e => e.id !== sel.edge);
  select(null);
  changed();
}

function select(s) {
  sel = s;
  world.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', el.dataset.id === s?.node));
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
  $('#dupBtn')?.addEventListener('click', () => {
    const n = { ...nodeById(sel.node), id: uid() }; n.x += 30; n.y += 30;
    G.nodes.push(n); select({ node: n.id }); changed();
  });
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
    if (r.util !== null && n.type !== 'sink') h += `<h3>Running at ${pct(r.util)}</h3>${r.util < 0.995 ? `<div>${esc(reasonText(r.why))}</div>` : ''}`;
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
      if (r && r.util >= 0.995) issues.push({ bad: true, node: e.from, edge: e.id, txt: `<b>Belt maxed</b> ${esc(nodeTitle(nodeById(e.from))[0])} → ${esc(nodeTitle(nodeById(e.to))[0])}: ${fmt(r.total)}/${fmt(r.cap)} (${esc(e.tier)})` });
    }
    const under = G.nodes.filter(n => ['machine', 'extractor', 'input'].includes(n.type) && RES.nodes[n.id] && RES.nodes[n.id].util < 0.995)
      .sort((a, b) => RES.nodes[a.id].util - RES.nodes[b.id].util);
    for (const n of under) {
      const r = RES.nodes[n.id];
      issues.push({ bad: r.why?.startsWith('blocked'), node: n.id, txt: `<b>${pct(r.util)}</b> ${esc(nodeTitle(n)[0])} — ${esc(reasonText(r.why))}` });
    }
    const sinks = {};
    for (const n of G.nodes) {
      const r = RES.nodes[n.id];
      for (const [i, v] of Object.entries((n.type === 'sink' ? r?.in : r?.unconnected) ?? {})) sinks[i] = (sinks[i] || 0) + v;
    }
    el.innerHTML = `<h2>Overview</h2><h3>Bottlenecks & underused (${issues.length})</h3>` +
      (issues.length ? issues.map((x, k) => `<div class="issue ${x.bad ? 'bad' : ''}" data-k="${k}">${x.txt}</div>`).join('') : '<div class="muted">Everything runs at 100%.</div>') +
      `<h3>Factory output /min</h3>` + rateTable(Object.entries(sinks).map(([i, v]) => [esc(itemName(i)), fmt(v)])) +
      `<div class="muted">Sinks plus any output with no belt attached (counted as going to storage).</div>` +
      `<h3>How to read it</h3><div class="muted">Green = 100%. Yellow = starved for input. Red = output backed up (its belt is full or what it feeds can't take more). Red belts are at capacity. Rates are actual / max per minute.</div>`;
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
