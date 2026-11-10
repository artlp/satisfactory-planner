# Factory Flow Planner

Draw the Satisfactory factory you actually built — miners, machines, splitters, mergers, belts and pipes — and see where it bottlenecks.

**Live:** https://artlp.github.io/satisfactory-planner/

- Green = machine at 100%, yellow = starved for input, red = output backed up (full belt, nothing taking it, unconnected byproduct).
- Red belts are at capacity. Every node shows actual / max rate per minute.
- The solver ticks the factory like the game: splitters split evenly with overflow, mergers share fairly, backpressure travels upstream, loops work.
- Saved in your browser; Export/Import JSON; "Copy share link" puts the whole build in the URL.

## Updating game data

Recipes come from the game's own `CommunityResources/Docs/en-US.json` (built against 1.2.5):

```
python tools/extract.py "<Satisfactory>/CommunityResources/Docs/en-US.json"
node tools/sim.test.js
```

No build step: it's static HTML/JS, served straight by GitHub Pages. Run locally with `python -m http.server`.
