// Steady-state flow simulation. Continuous "fluid" model ticked at 1s:
// machines run at p = min(1, input buffers, output space), edges move items
// up to their belt/pipe capacity, junctions split evenly with overflow.
// This reproduces backpressure, starvation, blocked byproducts and loops.
(function () {
  const BUF = 4;           // seconds of throughput a machine buffers
  const WARMUP = 3000, MEASURE = 600;

  function simulate(graph, data) {
    const recipes = Object.fromEntries(data.recipes.map(r => [r.id, r]));
    const extractors = Object.fromEntries(data.extractors.map(e => [e.id, e]));
    const tiers = Object.fromEntries([...data.belts, ...data.pipes].map(t => [t.name, t.rate / 60]));
    const S = {}; // node id -> sim state
    const outEdges = {}, inEdges = {};

    for (const n of graph.nodes) {
      const s = S[n.id] = { n, need: {}, make: {}, in: {}, out: {}, p: 0, why: {}, kind: n.type };
      outEdges[n.id] = []; inEdges[n.id] = [];
      const k = (n.count ?? 1) * (n.clock ?? 100) / 100;
      if (n.type === 'machine' && recipes[n.recipe]) {
        const r = recipes[n.recipe];
        for (const [i, a] of r.in) s.need[i] = (s.need[i] || 0) + a * k / r.time;
        for (const [i, a] of r.out) s.make[i] = (s.make[i] || 0) + a * k / r.time;
      } else if (n.type === 'extractor' && extractors[n.extractor] && n.item) {
        s.make[n.item] = extractors[n.extractor].rate * (n.purity ?? 1) * k / 60;
      } else if (n.type === 'input' && n.item) {
        s.make[n.item] = (n.rate || 0) / 60;
      }
    }
    const edges = graph.edges.filter(e => S[e.from] && S[e.to] && e.from !== e.to).map(e => ({
      // a rate measured in game caps the belt below its tier speed
      e, cap: Math.min(tiers[e.tier] ?? 1e9, e.measured > 0 ? e.measured / 60 : Infinity), flow: {}, sent: 0,
    }));
    for (const E of edges) { outEdges[E.e.from].push(E); inEdges[E.e.to].push(E); }
    // An output with no belt that could carry it is treated as going to storage, not as blocked.
    for (const s of Object.values(S)) {
      s.free = Object.keys(s.make).filter(i => !outEdges[s.n.id].some(E => !E.e.item || E.e.item === i));
      s.dump = {};
    }
    for (const s of Object.values(S)) {
      if (s.kind === 'splitter' || s.kind === 'merger')
        s.cap = Math.max(1, inEdges[s.n.id].reduce((a, E) => a + Math.min(E.cap, 1e4), 0)) * 2;
    }

    const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    // free space for `item` in node s
    function space(s, item) {
      if (s.kind === 'sink') return Infinity;
      if (s.cap) return Math.max(0, s.cap - sum(s.in));
      if (s.need[item] === undefined) return 0;
      return Math.max(0, s.need[item] * BUF - (s.in[item] || 0));
    }

    // Distribute `amt` of `item` from a source over edges (water-filling), returns amount moved.
    function push(item, amt, list, edgeRoom, measuring) {
      let moved = 0, open = list.filter(E => (!E.e.item || E.e.item === item));
      while (amt - moved > 1e-9 && open.length) {
        const share = (amt - moved) / open.length, next = [];
        for (const E of open) {
          const dst = S[E.e.to];
          const take = Math.min(share, edgeRoom.get(E), space(dst, item));
          if (take > 0) {
            dst.in[item] = (dst.in[item] || 0) + take;
            edgeRoom.set(E, edgeRoom.get(E) - take);
            moved += take;
            if (measuring) E.flow[item] = (E.flow[item] || 0) + take;
          }
          if (take >= share - 1e-12) next.push(E);
        }
        if (next.length === open.length && moved === 0) break;
        open = next;
      }
      return moved;
    }

    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const order = Object.values(S);

    for (let t = 0; t < WARMUP + MEASURE; t++) {
      const measuring = t >= WARMUP;
      // 1. produce / consume
      for (const s of order) {
        if (s.kind === 'sink') {
          if (measuring) for (const i in s.in) s.out[i] = (s.out[i] || 0) + s.in[i];
          s.in = {};
          continue;
        }
        if (s.cap) continue;
        let p = 1, why = null;
        for (const i in s.need) { const f = (s.in[i] || 0) / s.need[i]; if (f < p) { p = f; why = 'starved:' + i; } }
        for (const i in s.make) { const f = (s.make[i] * BUF - (s.out[i] || 0)) / s.make[i]; if (f < p) { p = Math.max(0, f); why = 'blocked:' + i; } }
        if (!Object.keys(s.make).length && !Object.keys(s.need).length) { p = 0; why = 'unconfigured'; } // generators only consume
        for (const i in s.need) s.in[i] -= s.need[i] * p;
        for (const i in s.make) s.out[i] = (s.out[i] || 0) + s.make[i] * p;
        for (const i of s.free) { if (measuring) s.dump[i] = (s.dump[i] || 0) + s.out[i]; s.out[i] = 0; }
        if (measuring) { s.p += p; if (why && p < 0.999) s.why[why] = (s.why[why] || 0) + 1; }
      }
      // 2. move items along edges. Shuffle, then reverse next tick: every pair of
      // upstream nodes goes first equally often, so mergers share fairly.
      if (t % 2) order.reverse();
      else for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      for (const s of order) {
        const list = outEdges[s.n.id];
        if (!list.length || s.kind === 'sink') continue;
        const pool = s.cap ? s.in : s.out, total = sum(pool);
        // a belt may use what it left unused last tick (at most one tick's worth), so ticks where
        // the source happened to be empty don't permanently lose capacity
        const room = new Map(list.map(E => [E, E.cap + (E.bank ?? E.cap)]));
        const start = new Map(room);
        for (const item of total > 0 ? Object.keys(pool) : []) {
          let moved;
          if (s.cap) { // each item gets a proportional slice of each belt, so a blocked item clogs a mixed belt
            const slice = new Map(list.map(E => [E, start.get(E) * pool[item] / total])), before = new Map(slice);
            moved = push(item, pool[item], list, slice, measuring);
            for (const E of list) room.set(E, room.get(E) - (before.get(E) - slice.get(E)));
          } else moved = push(item, pool[item], list, room, measuring);
          pool[item] -= moved;
          if (pool[item] < 1e-9) delete pool[item];
        }
        for (const E of list) E.bank = Math.min(E.cap, room.get(E));
      }
    }

    const perMin = 60 / MEASURE;
    const nodes = {};
    for (const s of Object.values(S)) {
      const util = s.p / MEASURE;
      const why = Object.entries(s.why).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      const r = { util, why, in: {}, out: {}, maxIn: {}, maxOut: {}, unconnected: {} };
      for (const i in s.dump) r.unconnected[i] = s.dump[i] * perMin;
      for (const i in s.need) { r.maxIn[i] = s.need[i] * 60; r.in[i] = s.need[i] * 60 * util; }
      for (const i in s.make) { r.maxOut[i] = s.make[i] * 60; r.out[i] = s.make[i] * 60 * util; }
      if (s.kind === 'sink') for (const i in s.out) r.in[i] = s.out[i] * perMin;
      nodes[s.n.id] = r;
    }
    for (const s of Object.values(S)) if (s.cap) {
      const r = nodes[s.n.id];
      for (const E of inEdges[s.n.id]) for (const i in E.flow) r.in[i] = (r.in[i] || 0) + E.flow[i] * perMin;
      r.util = null;
    }
    const out = {};
    for (const E of edges) {
      const flow = Object.fromEntries(Object.entries(E.flow).map(([i, v]) => [i, v * perMin]));
      const total = sum(flow);
      out[E.e.id] = { flow, total, cap: E.cap * 60, util: E.cap < 1e8 ? total / (E.cap * 60) : 0 };
    }
    return { nodes, edges: out };
  }

  if (typeof module !== 'undefined') module.exports = { simulate };
  else window.simulate = simulate;
})();
