let DATA, G, RES = { nodes: {}, edges: {} }, sel = null;
const view = { x: 40, y: 40, k: 1 };
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pct = v => Math.round(v * 100) + '%';
const tiers = () => [...DATA.belts, ...DATA.pipes];
const recipeLabel = r => `${r.name} — ${DATA.buildings[r.building]}`;
// MW a generator node makes right now (power scales linearly with clock and count)
// MW a machine or extractor draws at full speed: base × (clock/100)^1.321929 per building, as in the game
const powerMax = n => (DATA.powerUse?.[n.type === 'machine' ? recipe(n.recipe)?.building : n.type === 'extractor' ? n.extractor : null] ?? 0)
  * (n.count ?? 1) * ((n.clock ?? 100) / 100) ** 1.321929;
// ...and right now: machines only draw while working, so it scales with utilisation
const powerUse = n => powerMax(n) * (RES.nodes[n.id]?.util ?? 0);
const powerMW = n => n.type === 'machine' && recipe(n.recipe)?.power ? recipe(n.recipe).power * n.count * n.clock / 100 * (RES.nodes[n.id]?.util ?? 0) : 0;

// ---------- persistence ----------
// Undo: every saved change keeps the build from before it. Kept per browser tab, so it survives a reload.
// shortcut: whole-build snapshots, last 30; fine for hand-drawn factories, switch to diffs if builds get huge.
let undoStack = (() => { try { return JSON.parse(sessionStorage.getItem('ffp-undo')) || []; } catch { return []; } })(), lastSaved = null;
const keepUndo = () => { try { sessionStorage.setItem('ffp-undo', JSON.stringify(undoStack)); } catch {} };
const save = () => {
  const now = JSON.stringify(G);
  if (lastSaved !== null && now !== lastSaved) { undoStack = [...undoStack, lastSaved].slice(-30); keepUndo(); }
  lastSaved = now;
  try { localStorage.setItem('ffp-graph', now); } catch {}
};
function undo() {
  if (!undoStack.length) return;
  lastSaved = undoStack.pop(); keepUndo();
  G = JSON.parse(lastSaved);
  sel = null; renderCanvas(); select(null); changed(); // draw the new nodes before select() draws belts to them
}
const loadLocal = () => { try { return JSON.parse(localStorage.getItem('ffp-graph')); } catch { return null; } };

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

function nodeHTML(n) {
  const r = RES.nodes[n.id], [t, s] = nodeTitle(n), st = status(n);
  let body = '';
  if (r && !JUNCTIONS.includes(n.type) && n.type !== 'sink' && r.why !== 'unconfigured')
    body += `<div class="u">${pct(r.util)}</div>`;
  if (n.target && mainItem(n)) body += `<div class="r">🎯 want ${fmt(n.target)}/min</div>`;
  if (recipe(n.recipe)?.power) body += `<div class="r">⚡ makes ${fmt(powerMW(n))} MW</div>`;
  else if (powerMax(n)) body += `<div class="r">⚡ uses ${fmt(powerUse(n))}/${fmt(powerMax(n))} MW</div>`;
  if (r && st && st !== 'ok' && st !== 'idle') {
    const also = (r.short ?? []).filter(i => r.why !== 'starved:' + i).map(itemName);
    body += `<div class="r">${esc((explain(n)?.short ?? reasonText(r.why)) + (also.length ? ` · also short on ${also.join(', ')}` : ''))}</div>`;
  }
  if (r) {
    // flag every short input, not just the one the status line names (two can be short at once)
    for (const i in r.maxIn) body += `<div class="r${r.short?.includes(i) ? ' short' : ''}">▸ ${esc(itemName(i))} ${fmt(r.in[i])}/${fmt(r.maxIn[i])}</div>`;
    for (const i in r.maxOut) body += `<div class="r">◂ ${esc(itemName(i))} ${fmt(r.out[i])}/${fmt(r.maxOut[i])}${i in r.unconnected ? ' → storage' : ''}</div>`;
    if (n.type === 'sink' || JUNCTIONS.includes(n.type))
      for (const i in r.in) body += `<div class="r">${esc(itemName(i))} ${fmt(r.in[i])}/min</div>`;
  }
  const hasIn = !['extractor', 'input'].includes(n.type), hasOut = n.type !== 'sink';
  return `${hasIn ? '<div class="port in"></div>' : ''}<div class="t">${esc(t)}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}${body}${hasOut ? '<div class="port out"></div>' : ''}`;
}

// ---------- zones: named areas of the world, drawn behind the nodes ----------
const ZONE_COLORS = { '#f39c32': 'Orange', '#3fb950': 'Green', '#58a6ff': 'Blue', '#d2a8ff': 'Purple', '#e5534b': 'Red', '#e6e6e6': 'White' };
const zoneById = id => G.zones.find(z => z.id === id);
const zoneEl = id => world.querySelector(`.zone[data-zone="${id}"]`);
const inZone = (z, o) => o.x >= z.x && o.x < z.x + z.w && o.y >= z.y && o.y < z.y + z.h; // by top-left corner
const zoneOf = n => G.zones.filter(z => inZone(z, n)).sort((a, b) => a.w * a.h - b.w * b.h)[0]; // innermost
const zoneName = z => z.label || 'Unnamed zone';
const zoneTag = n => { const z = zoneOf(n); return z ? ` <span class="muted">(${esc(zoneName(z))})</span>` : ''; };
const placeZone = (el, z) => Object.assign(el.style, { left: z.x + 'px', top: z.y + 'px', width: z.w + 'px', height: z.h + 'px' });

function renderZones() {
  world.querySelectorAll('.zone').forEach(el => el.remove());
  for (const z of [...G.zones].reverse()) { // later zones on top, so a zone drawn inside another stays clickable
    const el = document.createElement('div');
    el.className = `zone ${sel?.zone === z.id ? 'sel' : ''}`;
    el.dataset.zone = z.id;
    el.style.setProperty('--zc', z.color);
    placeZone(el, z);
    el.innerHTML = `<div class="zt">${esc(zoneName(z))}</div><div class="zr"></div>`;
    world.prepend(el);
  }
}

function addZone() {
  const ids = selectedIds(), colors = Object.keys(ZONE_COLORS);
  let x, y, w = 400, h = 260;
  if (ids.length) { // wrap the selected nodes
    const box = ids.map(id => { const n = nodeById(id), el = world.querySelector(`.node[data-id="${id}"]`); return [n.x, n.y, n.x + el.offsetWidth, n.y + el.offsetHeight]; });
    x = Math.min(...box.map(b => b[0])) - 30; y = Math.min(...box.map(b => b[1])) - 50;
    w = Math.max(...box.map(b => b[2])) - x + 30; h = Math.max(...box.map(b => b[3])) - y + 30;
  } else {
    const r = viewport.getBoundingClientRect(), c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    x = c.x - w / 2; y = c.y - h / 2;
  }
  const z = { id: uid(), label: '', x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), color: colors[G.zones.length % colors.length] };
  G.zones.push(z);
  renderZones(); select({ zone: z.id }); save();
  $('#form [data-k="label"]').focus();
}

function renderCanvas() {
  renderZones();
  world.querySelectorAll('.node').forEach(el => el.remove());
  for (const n of G.nodes) {
    const el = document.createElement('div');
    el.className = `node ${status(n)} ${JUNCTIONS.includes(n.type) ? 'junction' : ''} ${selectedIds().includes(n.id) ? 'sel' : ''}`;
    el.dataset.id = n.id;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    el.innerHTML = nodeHTML(n);
    world.appendChild(el);
  }
  markFound();
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
    const full = r && r.util >= FULL, state = full ? (beltLimits(e) ? 'full' : 'maxed') : r?.total > 0 ? 'flow' : 'none';
    const cls = `wire ${state} ${sel?.edge === e.id ? 'sel' : ''}`;
    const items = r ? Object.keys(r.flow).filter(i => r.flow[i] > 0.01) : [];
    const what = e.item ? itemName(e.item) : items.length === 1 ? itemName(items[0]) : items.length ? `${items.length} items` : '';
    const free = r ? r.cap - r.total : 0;
    const label = r ? `${what} ${fmt(r.total)}/${fmt(r.cap)}${e.measured ? ' measured' : !full && free > 0.05 ? ` · ${fmt(free)} free` : ''}` : '';
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
  // commit a half-edited sidebar field (number, recipe picked from the list) before the click re-renders the panel,
  // which would remove the field before it ever fires `change`
  if (document.activeElement?.closest('aside')) document.activeElement.blur();
  const port =ev.target.closest('.port.out'), nodeEl = ev.target.closest('.node'), edge = ev.target.dataset?.edge;
  const zEl = ev.target.closest('.zt, .zr') && ev.target.closest('.zone');
  const p = toWorld(ev.clientX, ev.clientY);
  viewport.setPointerCapture(ev.pointerId);
  if (port) drag = { mode: 'wire', from: nodeEl.dataset.id };
  else if (zEl) {
    const z = zoneById(zEl.dataset.zone);
    select({ zone: z.id });
    // moving a zone takes the nodes and smaller zones inside it along
    drag = ev.target.closest('.zr') ? { mode: 'resize', z, start: p, w: z.w, h: z.h }
      : { mode: 'zone', start: p, moved: false, group: G.nodes.filter(n => inZone(z, n)).map(n => ({ n, x: n.x, y: n.y })),
        zones: G.zones.filter(o => o === z || inZone(z, o)).map(o => ({ z: o, x: o.x, y: o.y })) };
  } else if (nodeEl) {
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
  else if (drag.mode === 'resize') {
    drag.z.w = Math.max(160, Math.round(drag.w + p.x - drag.start.x)); drag.z.h = Math.max(80, Math.round(drag.h + p.y - drag.start.y));
    placeZone(zoneEl(drag.z.id), drag.z);
  } else if (drag.mode === 'node' || drag.mode === 'zone') {
    drag.moved = true;
    for (const g of drag.zones ?? []) { g.z.x = Math.round(g.x + p.x - drag.start.x); g.z.y = Math.round(g.y + p.y - drag.start.y); placeZone(zoneEl(g.z.id), g.z); }
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
  } else if (drag.mode === 'zone' || drag.mode === 'resize') {
    if (drag.moved !== false) { save(); renderForm(); } // node count inside may have changed
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
  // the browser's own find can't pan the board to a hit, so Ctrl+F goes to our search
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (ev.target.closest('input, select, textarea')) return;
  // Backspace deletes only on a Mac, where it is the delete key; elsewhere it is too easy to hit while clearing a field
  if ((ev.key === 'Delete' || ev.key === 'Backspace' && /Mac/.test(navigator.platform)) && sel) { ev.preventDefault(); removeSelected(); }
  if (ev.key === 'Escape') select(null);
  const mod = ev.ctrlKey || ev.metaKey, key = ev.key.toLowerCase();
  if (mod && key === 'z') { ev.preventDefault(); undo(); }
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
    // prefer what the target consumes (e.g. recycled water back to a refinery), then an output not yet piped
    const wants = recipe(nodeById(to).recipe)?.in.map(i => i[0]) ?? [];
    if (outs.length > 1) item = outs.find(i => wants.includes(i))
      ?? outs.find(i => !G.edges.some(e => e.from === from && e.item === i)) ?? outs[0];
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
  if (sel?.zone) { G.zones = G.zones.filter(z => z.id !== sel.zone); renderZones(); }
  select(null);
  changed();
}

function select(s) {
  sel = s;
  world.querySelectorAll('.node').forEach(el => el.classList.toggle('sel', selectedIds().includes(el.dataset.id)));
  world.querySelectorAll('.zone').forEach(el => el.classList.toggle('sel', sel?.zone === el.dataset.zone));
  renderWires();
  renderForm();
  renderResults();
}

function focusNode(id) {
  const n = nodeById(id), r = viewport.getBoundingClientRect();
  view.x = r.width / 2 - (n.x + 90) * view.k; view.y = r.height / 2 - (n.y + 40) * view.k;
  applyView(); select({ node: id });
}

// ---------- search: nodes by name, recipe, label or any item they use or make; zones by name ----------
let found = [], foundAt = 0, searchPick = null; // searchPick: what the search last selected
const searchText = o => (G.zones.includes(o) ? [zoneName(o)]
  : [...nodeTitle(o), ...Object.keys({ ...RES.nodes[o.id]?.maxIn, ...RES.nodes[o.id]?.maxOut }).map(itemName)]).join(' ').toLowerCase();
const markFound = () => world.querySelectorAll('.node, .zone').forEach(el =>
  el.classList.toggle('match', found.some(o => o.id === (el.dataset.id ?? el.dataset.zone))));

function search(step) { // step 0 = new query (first hit), 1 / -1 = next / previous
  const words = $('#search').value.toLowerCase().split(/\s+/).filter(Boolean);
  found = words.length ? [...G.zones, ...G.nodes].filter(o => { const t = searchText(o); return words.every(w => t.includes(w)); }) : [];
  foundAt = found.length ? (step ? (foundAt + step + found.length) % found.length : 0) : 0;
  $('#searchCount').textContent = found.length ? `${foundAt + 1}/${found.length}` : words.length ? 'none' : '';
  markFound();
  const o = found[foundAt];
  if (!o) { // search cleared: drop the selection it made, so nothing stays lit up
    if (!words.length && searchPick && (sel?.node ?? sel?.zone) === searchPick) select(null);
    searchPick = null;
    return;
  }
  searchPick = o.id;
  if (!G.zones.includes(o)) return focusNode(o.id);
  const r = viewport.getBoundingClientRect();
  view.k = Math.min(view.k, r.width / (o.w + 80), r.height / (o.h + 80)); // zoom out if the zone doesn't fit
  view.x = r.width / 2 - (o.x + o.w / 2) * view.k; view.y = r.height / 2 - (o.y + o.h / 2) * view.k;
  applyView(); select({ zone: o.id });
}
$('#search').addEventListener('input', () => search(0));
$('#search').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') search(ev.shiftKey ? -1 : 1);
  if (ev.key === 'Escape') { ev.target.value = ''; search(0); ev.target.blur(); }
});

// ---------- side panel ----------
const field = (label, html) => `<label class="f">${label}${html}</label>`;
const options = (list, cur) => list.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</option>`).join('');
const allItems = () => Object.entries(DATA.items).map(([id, it]) => [id, it.name]).sort((a, b) => a[1].localeCompare(b[1]));

function renderForm() {
  const f = $('#form');
  if (sel?.node) {
    const n = nodeById(sel.node);
    const z = zoneOf(n);
    let h = `<h2>${esc(nodeTitle(n)[0])}</h2>` + (z ? `<div class="muted" style="margin:-4px 0 8px">In zone ${esc(zoneName(z))}</div>` : '') + field('Label', `<input data-k="label" value="${esc(n.label)}" placeholder="optional name">`);
    if (n.type === 'machine') {
      const r = recipe(n.recipe);
      h += field('Recipe', `<input data-k="recipe" list="recipeList" value="${esc(r ? recipeLabel(r) : '')}" placeholder="type to search…">`);
      h += field('Machines', `<input data-k="count" type="number" min="1" step="1" value="${n.count}">`);
      h += field('Clock speed %', `<input data-k="clock" type="number" min="1" max="250" step="any" value="${n.clock}">`);
      if (r) h += `<div class="muted">Per machine @100%: ${r.in.map(([i, a]) => `${fmt(a * 60 / r.time)} ${esc(itemName(i))}`).join(' + ')} → ${[...r.out.map(([i, a]) => `${fmt(a * 60 / r.time)} ${esc(itemName(i))}`), r.power && `${fmt(r.power)} MW`].filter(Boolean).join(' + ')}${r.out.length ? ' /min' : ''}</div>`;
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
    const main = mainItem(n);
    if (main) {
      h += `<label class="inline" style="margin-bottom:6px"><input type="checkbox" data-k="target" ${n.target ? 'checked' : ''}> Plan a target rate</label>`;
      if (n.target) h += field(`Want ${esc(itemName(main))} /min`, `<input data-k="target" type="number" min="0" step="any" value="${n.target}">`);
    }
    h += `<div class="row"><button id="dupBtn">Duplicate</button><button class="danger" id="delBtn">Delete</button></div>`;
    f.innerHTML = h;
  } else if (sel?.edge) {
    const e = G.edges.find(x => x.id === sel.edge), src = nodeById(e.from);
    const outs = src.type === 'machine' ? recipe(src.recipe)?.out.map(o => [o[0], itemName(o[0])]) ?? [] : allItems();
    f.innerHTML = `<h2>${esc(nodeTitle(src)[0])} → ${esc(nodeTitle(nodeById(e.to))[0])}</h2>` +
      field('Belt / pipe', `<select data-k="tier">${options(tiers().map(t => [t.name, `${t.name} (${t.rate}/min)`]), e.tier)}</select>`) +
      field('Measured in game /min', `<input data-k="measured" type="number" min="0" step="any" value="${e.measured ?? ''}" placeholder="empty = use belt speed">`) +
      `<div class="muted" style="margin:-4px 0 8px">Type what your throughput monitor shows. The planner then treats this belt as only carrying that much.</div>` +
      field(src.type === 'machine' ? 'Output port carries' : 'Only carry (smart splitter filter)',
        `<select data-k="item"><option value="">Any</option>${options(outs, e.item)}</select>`) +
      (src.type === 'splitter' ? `<label class="inline" style="margin-bottom:6px"><input type="checkbox" data-k="overflow" ${e.overflow ? 'checked' : ''}> Overflow (smart splitter): only gets what the other outputs can't take</label>` : '') +
      `<div class="row"><button class="danger" id="delBtn">Delete</button></div>`;
  } else if (sel?.zone) {
    const z = zoneById(sel.zone), inside = G.nodes.filter(n => inZone(z, n)).length;
    f.innerHTML = `<h2>${esc(zoneName(z))}</h2>` + field('Name', `<input data-k="label" value="${esc(z.label)}" placeholder="e.g. North iron field">`) +
      field('Color', `<select data-k="color">${options(Object.entries(ZONE_COLORS), z.color)}</select>`) +
      `<div class="muted">${inside} node${inside === 1 ? '' : 's'} inside. Drag the name to move the zone with everything in it; drag the bottom-right corner to resize. Deleting the zone keeps its nodes.</div>` +
      `<div class="row"><button class="danger" id="delBtn">Delete zone</button></div>`;
  } else if (sel?.nodes) {
    f.innerHTML = `<h2>${sel.nodes.length} nodes selected</h2><div class="muted">Drag any of them to move the group. Ctrl+C / Ctrl+V copies them with the belts between them. Shift+click adds or removes a node.</div>` +
      `<div class="row"><button id="dupBtn">Duplicate</button><button class="danger" id="delBtn">Delete</button></div>`;
  } else f.innerHTML = '';

  f.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
    const obj = sel.node ? nodeById(sel.node) : sel.zone ? zoneById(sel.zone) : G.edges.find(x => x.id === sel.edge), k = inp.dataset.k;
    let v = inp.value;
    if (k === 'recipe') { const r = DATA.recipes.find(r => recipeLabel(r) === v); if (!r) return; v = r.id; }
    else if (k === 'overflow') v = inp.checked || null;
    else if (inp.type === 'checkbox') v = inp.checked ? Math.round(RES.nodes[obj.id]?.maxOut[mainItem(obj)] ?? 0) || 60 : null;
    else if (inp.type === 'number' || inp.dataset.num !== undefined) {
      v = Number(v);
      if (k === 'clock') v = Math.min(250, Math.max(1, v || 100));
      if (k === 'count') v = Math.max(1, Math.round(v) || 1);
      if (k === 'rate') v = Math.max(0, v || 0);
      if (k === 'measured' || k === 'target') v = v > 0 ? v : null;
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
    if (n.target && mainItem(n)) h += `<h3>To make ${fmt(n.target)} ${esc(itemName(mainItem(n)))}/min</h3>` +
      plan(n, mainItem(n), n.target).map(l => `<p class="ex" style="padding-left:${l.depth * 14}px">${l.depth ? '↳ ' : ''}${esc(l.t)}</p>`).join('');
    if (Object.keys(r.maxIn).length) h += `<h3>Consumes /min</h3>` + rateTable(Object.keys(r.maxIn).map(i => [esc(itemName(i)), `${fmt(r.in[i])} / ${fmt(r.maxIn[i])}`]));
    if (recipe(n.recipe)?.power) h += `<h3>Power made: ${fmt(powerMW(n))} MW</h3>`;
    else if (powerMax(n)) h += `<h3>Power used: ${fmt(powerUse(n))} / ${fmt(powerMax(n))} MW</h3>`;
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
      if (r && r.util >= FULL && beltLimits(e)) issues.push({ bad: true, node: e.from, edge: e.id, txt: `<b>Belt full</b> ${esc(nodeTitle(nodeById(e.from))[0])} → ${esc(nodeTitle(nodeById(e.to))[0])}${zoneTag(nodeById(e.from))}: ${fmt(r.total)}/${fmt(r.cap)} (${esc(beltName(e))})` +
        `<p class="ex">This belt is full and something next to it is waiting on it. Upgrade the belt or add a second one.</p>` });
    }
    const under = G.nodes.filter(n => ['machine', 'extractor', 'input'].includes(n.type) && RES.nodes[n.id] && RES.nodes[n.id].util < FULL)
      .map(n => ({ n, r: RES.nodes[n.id], ex: explain(n) }))
      .sort((a, b) => (a.ex?.knock ?? 0) - (b.ex?.knock ?? 0) || a.r.util - b.r.util); // real causes first, knock-on effects last
    for (const { n, r, ex } of under) {
      issues.push({ bad: r.why?.startsWith('blocked'), knock: ex?.knock, node: n.id,
        txt: `<b>${pct(r.util)}</b> ${esc(nodeTitle(n)[0])}${zoneTag(n)}:${esc(reasonText(r.why))}` + (ex?.lines ?? []).map(l => `<p class="ex">${esc(l)}</p>`).join('') });
    }
    const sinks = {};
    for (const n of G.nodes) {
      const r = RES.nodes[n.id];
      for (const [i, v] of Object.entries((n.type === 'sink' ? r?.in : r?.unconnected) ?? {})) sinks[i] = (sinks[i] || 0) + v;
    }
    el.innerHTML = `<h2>Overview</h2><h3>Bottlenecks & underused (${issues.length})</h3>` +
      (issues.length ? issues.map((x, k) => `<div class="issue ${x.bad ? 'bad' : ''} ${x.knock ? 'knock' : ''}" data-k="${k}">${x.txt}</div>`).join('') : '<div class="muted">Everything runs at 100%.</div>') +
      (G.nodes.some(powerMW) ? `<h3>Power made: ${fmt(G.nodes.reduce((a, n) => a + powerMW(n), 0))} MW</h3>` : '') +
      (G.nodes.some(powerMax) ? `<h3>Power used: ${fmt(G.nodes.reduce((a, n) => a + powerUse(n), 0))} MW</h3>` +
        `<div class="muted">${fmt(G.nodes.reduce((a, n) => a + powerMax(n), 0))} MW if every machine ran at 100%. Overclocking raises power faster than speed (×1.32 power curve).</div>` : '') +
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
$('#zoneBtn').addEventListener('click', addZone);
$('#undoBtn').addEventListener('click', undo);
$('#exportBtn').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(G, null, 1)], { type: 'application/json' }));
  a.download = 'factory.json'; a.click(); URL.revokeObjectURL(a.href);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async ev => {
  const file = ev.target.files[0]; ev.target.value = '';
  if (!file) return;
  try { const g = JSON.parse(await file.text()); if (!valid(g)) throw 0; G = g; G.zones ??= []; sel = null; renderCanvas(); select(null); changed(); }
  catch { alert('That file is not a planner export.'); }
});
$('#shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#g=${await encode(G)}`;
  try { await navigator.clipboard.writeText(url); alert('Share link copied to clipboard.'); } catch { prompt('Copy this link:', url); }
});
$('#clearBtn').addEventListener('click', () => {
  if (!confirm('Delete every node and belt? Export first if you want to keep it.')) return;
  G = { nodes: [], edges: [], zones: [] }; sel = null; renderCanvas(); select(null); changed();
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
      if (!valid(shared)) throw 0;
      if (!valid(G) || !G.nodes.length || confirm('Open the shared build? It replaces the one saved in this browser.')) G = shared;
    } catch { alert('The share link is damaged.'); }
    history.replaceState(null, '', location.pathname);
  }
  if (!valid(G)) G = sample();
  G.zones ??= [];
  applyView(); renderCanvas(); select(null); changed();
})();
