// reactor-solver.js
// Standalone fission reactor layout solver for the Messiah7 fork.
// Restricted to no moderators and exactly 4 cooler types: Lp, Ed, Sn, Mn.
//
// Design overview
// ----------------
// 1. Grid: flat Int8Array of size sizeX*sizeY*sizeZ, values are cell type ids (see TYPE).
// 2. Cell (fuel) power/heat use the classic NuclearCraft adjacency formulas:
//      powerMultiplier(n) = n + 1
//      heatMultiplier(n)  = (n + 1) * (n + 2) / 2
//    where n = number of directly adjacent fuel cells (no moderators to chain through).
// 3. Cooler placement rules (as specified):
//      Lp  - touches >= 1 fuel cell AND >= 1 casing face
//      Ed  - touches >= 3 casing faces (i.e. sits in a corner of the core)
//      Sn  - has Lp neighbors on BOTH opposite sides along the SAME single axis
//      Mn  - touches >= 2 fuel cells (any 2 of its up to 6 neighbors)
//    An invalid (rule not satisfied) cooler contributes 0 cooling but does not
//    break anything else - same as in-game behaviour.
// 4. Construction: a greedy "inside-out" builder seeds a good starting layout:
//      - grow a compact fuel cell cluster from the geometric centre outward
//      - corners -> Ed (they're the only place Ed can go, so claim them first)
//      - shell positions touching a cell -> Lp
//      - remaining positions touching >=2 cells -> Mn
//      - opposite-axis Lp/Lp pairs -> fill the gap with Sn
//      - anything left -> air
// 5. Refinement: simulated annealing over the whole grid on top of that seed,
//    using random single-cell mutations, to fix the parts the greedy pass
//    could not reason about (e.g. trade-offs between Mn vs Sn slots).
//
// This file has no dependencies and does not touch the DOM - it can be used
// standalone (see solve() at the bottom) or wired into index.html's Run
// button later, replacing (or running alongside) the WASM FissionOpt engine.

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------
  const TYPE = Object.freeze({
    AIR: 0,
    CELL: 1,
    LP: 2,
    ED: 3,
    SN: 4,
    MN: 5,
  });
  const TYPE_NAMES = ['Air', 'Fuel Cell', 'Lapis', 'Enderium', 'Tin', 'Manganese'];
  const COOLER_TYPES = [TYPE.LP, TYPE.ED, TYPE.SN, TYPE.MN];

  // Default passive cooling rates (H/t), taken from the values already in main.js.
  const DEFAULT_RATES = {
    [TYPE.LP]: 120,
    [TYPE.ED]: 120,
    [TYPE.SN]: 120,
    [TYPE.MN]: 150,
  };

  const NEIGHBOR_OFFSETS = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  // Offsets grouped per axis, in [positive, negative] pairs - used by the Sn rule.
  const AXIS_PAIRS = [
    [[1, 0, 0], [-1, 0, 0]],
    [[0, 1, 0], [0, -1, 0]],
    [[0, 0, 1], [0, 0, -1]],
  ];

  // ---------------------------------------------------------------------
  // Grid helpers
  // ---------------------------------------------------------------------
  class Grid {
    constructor(sizeX, sizeY, sizeZ) {
      this.sizeX = sizeX;
      this.sizeY = sizeY;
      this.sizeZ = sizeZ;
      this.cells = new Uint8Array(sizeX * sizeY * sizeZ).fill(TYPE.AIR);
    }
    idx(x, y, z) {
      return (x * this.sizeY + y) * this.sizeZ + z;
    }
    inBounds(x, y, z) {
      return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY && z >= 0 && z < this.sizeZ;
    }
    get(x, y, z) {
      return this.cells[this.idx(x, y, z)];
    }
    set(x, y, z, type) {
      this.cells[this.idx(x, y, z)] = type;
    }
    clone() {
      const g = new Grid(this.sizeX, this.sizeY, this.sizeZ);
      g.cells.set(this.cells);
      return g;
    }
    *positions() {
      for (let x = 0; x < this.sizeX; ++x)
        for (let y = 0; y < this.sizeY; ++y)
          for (let z = 0; z < this.sizeZ; ++z)
            yield [x, y, z];
    }
    neighborsOf(x, y, z) {
      const result = [];
      for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (this.inBounds(nx, ny, nz))
          result.push([nx, ny, nz]);
      }
      return result;
    }
    countNeighborsOfType(x, y, z, type) {
      let n = 0;
      for (const [nx, ny, nz] of this.neighborsOf(x, y, z))
        if (this.get(nx, ny, nz) === type) ++n;
      return n;
    }
    // Number of the core's own outer faces this position touches (0-3).
    // 0 = fully interior, 3 = corner of the core box.
    casingFaces(x, y, z) {
      let n = 0;
      if (x === 0 || x === this.sizeX - 1) ++n;
      if (y === 0 || y === this.sizeY - 1) ++n;
      if (z === 0 || z === this.sizeZ - 1) ++n;
      return n;
    }
  }

  // ---------------------------------------------------------------------
  // Placement rule predicates - each returns true if the block at (x,y,z)
  // (assumed to already be of that type) is ACTIVE, i.e. satisfies its rule.
  // ---------------------------------------------------------------------
  const RULES = {
    [TYPE.LP](grid, x, y, z) {
      return grid.countNeighborsOfType(x, y, z, TYPE.CELL) >= 1 && grid.casingFaces(x, y, z) >= 1;
    },
    [TYPE.ED](grid, x, y, z) {
      return grid.casingFaces(x, y, z) >= 3;
    },
    [TYPE.SN](grid, x, y, z) {
      for (const [pos, neg] of AXIS_PAIRS) {
        const px = x + pos[0], py = y + pos[1], pz = z + pos[2];
        const nx = x + neg[0], ny = y + neg[1], nz = z + neg[2];
        if (!grid.inBounds(px, py, pz) || !grid.inBounds(nx, ny, nz)) continue;
        if (grid.get(px, py, pz) === TYPE.LP && grid.get(nx, ny, nz) === TYPE.LP)
          return true;
      }
      return false;
    },
    [TYPE.MN](grid, x, y, z) {
      return grid.countNeighborsOfType(x, y, z, TYPE.CELL) >= 2;
    },
  };

  function isCoolerActive(grid, x, y, z) {
    const type = grid.get(x, y, z);
    const rule = RULES[type];
    return rule ? rule(grid, x, y, z) : false;
  }

  // ---------------------------------------------------------------------
  // Stats / objective
  // ---------------------------------------------------------------------
  function computeStats(grid, fuel, rates) {
    let power = 0, heat = 0, cooling = 0, cellCount = 0, inactiveCoolers = 0;
    const counts = { [TYPE.CELL]: 0, [TYPE.LP]: 0, [TYPE.ED]: 0, [TYPE.SN]: 0, [TYPE.MN]: 0 };
    const activeCounts = { [TYPE.LP]: 0, [TYPE.ED]: 0, [TYPE.SN]: 0, [TYPE.MN]: 0 };

    for (const [x, y, z] of grid.positions()) {
      const type = grid.get(x, y, z);
      if (type === TYPE.CELL) {
        const n = grid.countNeighborsOfType(x, y, z, TYPE.CELL);
        power += fuel.basePower * (n + 1);
        heat += fuel.baseHeat * (n + 1) * (n + 2) / 2;
        ++cellCount;
        ++counts[TYPE.CELL];
      } else if (COOLER_TYPES.includes(type)) {
        ++counts[type];
        if (isCoolerActive(grid, x, y, z)) {
          cooling += rates[type];
          ++activeCounts[type];
        } else {
          ++inactiveCoolers;
        }
      }
    }
    return { power, heat, cooling, netHeat: heat - cooling, cellCount, counts, activeCounts, inactiveCoolers };
  }

  // Fitness for search: maximise power, but heavily penalise net-positive heat
  // (heat neutral / net-cooling designs only). Using a smooth-ish penalty lets
  // simulated annealing "climb down" out of infeasible states instead of only
  // ever rejecting them outright.
  //
  // A much smaller secondary penalty discourages coolers that are PLACED but
  // INACTIVE (rule not satisfied - 0 H/t contributed). These don't hurt the
  // heat balance at all, so without this term the search has zero incentive
  // to ever clear them back to air or turn them into something useful - it
  // will happily leave e.g. 22 Enderium blocks sitting around when only 8
  // corner positions could ever make them active. The penalty is kept small
  // relative to the heat-neutrality penalty so it only acts as a tie-breaker
  // / gentle push, never fights the hard heat constraint.
  function fitness(grid, fuel, rates, opts) {
    const stats = computeStats(grid, fuel, rates);
    const overheat = Math.max(0, stats.netHeat);
    // Default penalty scales with the fuel's own power, so that violating
    // heat-neutrality by 1 H/t costs roughly as much as several whole cells'
    // worth of power - otherwise, with e.g. basePower in the tens of
    // thousands and heat in the hundreds, a flat penalty of ~50 is far too
    // weak and the search happily overheats the reactor to add more cells.
    const defaultPenalty = Math.max(50, fuel.basePower * 5);
    const heatPenalty = overheat * (opts.penaltyWeight ?? defaultPenalty);

    // Default waste penalty: a fraction of the average cooler rate, so an
    // inactive cooler costs noticeably less than the heat-neutral penalty
    // but still more than doing nothing, nudging the search to either
    // activate it, replace it with a cell/air, or move it somewhere useful.
    const avgRate = Object.values(rates).reduce((a, b) => a + b, 0) / (Object.values(rates).length || 1);
    const defaultWastePenalty = avgRate * 0.1;
    const wastePenalty = stats.inactiveCoolers * (opts.wastePenaltyWeight ?? defaultWastePenalty);

    return { score: stats.power - heatPenalty - wastePenalty, stats };
  }

  // ---------------------------------------------------------------------
  // Step 1: greedy "inside-out" seed construction
  // ---------------------------------------------------------------------
  function buildGreedySeed(sizeX, sizeY, sizeZ, opts) {
    const grid = new Grid(sizeX, sizeY, sizeZ);
    const maxAllowed = opts.maxAllowed || {};
    const limitOf = (type) => (maxAllowed[type] === undefined ? Infinity : maxAllowed[type]);
    const placed = { [TYPE.CELL]: 0, [TYPE.LP]: 0, [TYPE.ED]: 0, [TYPE.SN]: 0, [TYPE.MN]: 0 };

    // --- 1a. Grow a compact fuel cell cluster from the centre outward ---
    const cx = (sizeX - 1) / 2, cy = (sizeY - 1) / 2, cz = (sizeZ - 1) / 2;
    const volume = sizeX * sizeY * sizeZ;
    const targetCells = Math.min(
      limitOf(TYPE.CELL),
      Math.max(1, Math.round(volume * (opts.cellFraction ?? 0.35)))
    );
    const allPositions = [...grid.positions()];
    allPositions.sort((a, b) => {
      const da = (a[0] - cx) ** 2 + (a[1] - cy) ** 2 + (a[2] - cz) ** 2;
      const db = (b[0] - cx) ** 2 + (b[1] - cy) ** 2 + (b[2] - cz) ** 2;
      return da - db;
    });
    for (const [x, y, z] of allPositions) {
      if (placed[TYPE.CELL] >= targetCells) break;
      grid.set(x, y, z, TYPE.CELL);
      ++placed[TYPE.CELL];
    }

    // --- 1b. Shell positions touching a cell -> Lp ---
    // (Ed is intentionally NOT placed here - see finalizeCorners() below.
    // Its rule only depends on the position itself, not on any neighbor,
    // so it's strictly better/cheaper to resolve it once, deterministically,
    // after the rest of the grid has settled, instead of burning search
    // iterations on a decision that never actually depends on the search.)
    for (const [x, y, z] of grid.positions()) {
      if (grid.get(x, y, z) !== TYPE.AIR) continue;
      if (placed[TYPE.LP] >= limitOf(TYPE.LP)) break;
      if (grid.casingFaces(x, y, z) >= 1 && grid.countNeighborsOfType(x, y, z, TYPE.CELL) >= 1) {
        grid.set(x, y, z, TYPE.LP);
        ++placed[TYPE.LP];
      }
    }

    // --- 1d. Remaining positions touching >=2 cells -> Mn ---
    for (const [x, y, z] of grid.positions()) {
      if (grid.get(x, y, z) !== TYPE.AIR) continue;
      if (placed[TYPE.MN] >= limitOf(TYPE.MN)) break;
      if (grid.countNeighborsOfType(x, y, z, TYPE.CELL) >= 2) {
        grid.set(x, y, z, TYPE.MN);
        ++placed[TYPE.MN];
      }
    }

    // --- 1e. Fill gaps between opposite Lp/Lp pairs with Sn ---
    for (const [x, y, z] of grid.positions()) {
      if (grid.get(x, y, z) !== TYPE.AIR) continue;
      if (placed[TYPE.SN] >= limitOf(TYPE.SN)) break;
      for (const [pos, neg] of AXIS_PAIRS) {
        const px = x + pos[0], py = y + pos[1], pz = z + pos[2];
        const nx = x + neg[0], ny = y + neg[1], nz = z + neg[2];
        if (!grid.inBounds(px, py, pz) || !grid.inBounds(nx, ny, nz)) continue;
        if (grid.get(px, py, pz) === TYPE.LP && grid.get(nx, ny, nz) === TYPE.LP) {
          grid.set(x, y, z, TYPE.SN);
          ++placed[TYPE.SN];
          break;
        }
      }
    }

    // --- 1f. Anything left stays air ---
    return grid;
  }

  // ---------------------------------------------------------------------
  // Step 2: simulated annealing refinement over the whole grid
  // ---------------------------------------------------------------------
  function annealingRefine(seedGrid, fuel, rates, opts, rng) {
    const maxAllowed = opts.maxAllowed || {};
    const limitOf = (type) => (maxAllowed[type] === undefined ? Infinity : maxAllowed[type]);
    // Ed excluded on purpose - see finalizeCorners(). Its rule (casingFaces >= 3)
    // never depends on any neighbor, so annealing gains nothing from
    // considering it: whether a corner "should" be Ed is fully decided by a
    // single cheap deterministic pass after the search, not by exploring it
    // stochastically alongside everything else.
    const candidateTypes = [TYPE.AIR, TYPE.CELL, TYPE.LP, TYPE.SN, TYPE.MN];

    let current = seedGrid.clone();
    let currentEval = fitness(current, fuel, rates, opts);
    let best = current.clone();
    let bestEval = currentEval;

    const counts = {};
    for (const t of candidateTypes) counts[t] = 0;
    for (const v of current.cells) counts[v] = (counts[v] || 0) + 1;

    const iterations = opts.iterations ?? 4000;
    let temperature = opts.startTemp ?? 200;
    const coolingFactor = Math.pow((opts.endTemp ?? 1) / temperature, 1 / iterations);

    const positions = [...current.positions()];

    for (let iter = 0; iter < iterations; ++iter) {
      const [x, y, z] = positions[Math.floor(rng() * positions.length)];
      const oldType = current.get(x, y, z);
      let newType = candidateTypes[Math.floor(rng() * candidateTypes.length)];
      if (newType === oldType) continue;
      if (newType !== TYPE.AIR && counts[newType] >= limitOf(newType)) continue;

      current.set(x, y, z, newType);
      const nextEval = fitness(current, fuel, rates, opts);
      const delta = nextEval.score - currentEval.score;

      if (delta >= 0 || rng() < Math.exp(delta / Math.max(temperature, 1e-6))) {
        counts[oldType]--;
        counts[newType]++;
        currentEval = nextEval;
        if (currentEval.score > bestEval.score) {
          best = current.clone();
          bestEval = currentEval;
        }
      } else {
        current.set(x, y, z, oldType); // revert
      }
      temperature *= coolingFactor;
    }

    return { grid: best, eval: bestEval };
  }

  // ---------------------------------------------------------------------
  // Step 3: finalize Ed placement (deterministic, position-only rule)
  // ---------------------------------------------------------------------
  // Fills any still-empty corner (casingFaces >= 3) with Ed - there are at
  // most 8 such positions in any box, Ed's rule never depends on neighbors,
  // and an empty corner is otherwise pure waste (it can't usefully host Lp/Mn
  // most of the time anyway, since corners are geometrically far from a
  // centred fuel cluster). Only overwrites AIR or an already-inactive
  // cooler - never touches a cell or an already-active cooler, since those
  // are worth more than blindly maximising Ed count.
  function finalizeCorners(grid, rates, maxAllowed) {
    const limit = maxAllowed && maxAllowed[TYPE.ED] !== undefined ? maxAllowed[TYPE.ED] : Infinity;
    if (limit <= 0 || (rates[TYPE.ED] || 0) <= 0) return grid;
    let placed = 0;
    for (const [x, y, z] of grid.positions()) {
      if (placed >= limit) break;
      if (grid.casingFaces(x, y, z) < 3) continue;
      const current = grid.get(x, y, z);
      const currentIsCell = current === TYPE.CELL;
      const currentIsActiveCooler = COOLER_TYPES.includes(current) && isCoolerActive(grid, x, y, z);
      if (currentIsCell || currentIsActiveCooler) continue; // don't downgrade something already useful
      grid.set(x, y, z, TYPE.ED);
      ++placed;
    }
    return grid;
  }

  // ---------------------------------------------------------------------
  // Step 4: clear leftover inactive coolers back to air
  // ---------------------------------------------------------------------
  // After annealing (which discourages but doesn't eliminate inactive
  // coolers - see the wastePenalty comment in fitness()) and finalizeCorners
  // (which can only ADD Ed, never remove anything), there may still be a
  // handful of placed-but-inactive cooler blocks left over. They contribute
  // nothing to power or cooling, so clearing them to air normally costs
  // nothing and matches what you'd actually want to build in-game.
  //
  // CAVEAT: Sn's rule checks its neighbors' TYPE (must be Lp), not whether
  // that neighboring Lp is itself active. So an "inactive" Lp (e.g. one
  // with no adjacent fuel cell of its own) can still be the exact block
  // that makes a neighboring Sn valid. Blindly clearing every inactive
  // cooler could silently break an already-working Sn next to it. Each
  // candidate removal is therefore tentative: we clear it, check whether
  // any neighboring Sn that used to be active just became inactive because
  // of that, and revert if so.
  function clearInactiveCoolers(grid) {
    let cleared = 0;
    for (const [x, y, z] of grid.positions()) {
      const type = grid.get(x, y, z);
      if (!COOLER_TYPES.includes(type)) continue;
      if (isCoolerActive(grid, x, y, z)) continue; // already useful, leave it

      // Snapshot which neighboring Sn blocks are currently active.
      const neighbors = grid.neighborsOf(x, y, z);
      const snNeighborsBefore = neighbors
        .filter(([nx, ny, nz]) => grid.get(nx, ny, nz) === TYPE.SN)
        .map(([nx, ny, nz]) => [nx, ny, nz, isCoolerActive(grid, nx, ny, nz)]);

      grid.set(x, y, z, TYPE.AIR);

      const brokeSomething = snNeighborsBefore.some(
        ([nx, ny, nz, wasActive]) => wasActive && !isCoolerActive(grid, nx, ny, nz)
      );

      if (brokeSomething) {
        grid.set(x, y, z, type); // revert - this block is load-bearing for a neighbor
      } else {
        ++cleared;
      }
    }
    return cleared;
  }

  // ---------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------
  // options:
  //   sizeX, sizeY, sizeZ  - core interior dimensions
  //   fuel: { basePower, baseHeat }
  //   rates: { [TYPE.LP]: n, [TYPE.ED]: n, [TYPE.SN]: n, [TYPE.MN]: n } (optional, has defaults)
  //   maxAllowed: { [TYPE.CELL]: n, [TYPE.LP]: n, ... } (optional, default unlimited)
  //   cellFraction: 0..1, target fraction of volume filled with fuel cells (default 0.35)
  //   iterations: annealing iteration count (default 4000)
  //   penaltyWeight: how harshly to punish net-positive heat during search (default 50)
  //   restarts: number of independent greedy+anneal runs to try (default 3)
  //   seed: optional RNG seed function () => [0,1)
  function solve(options) {
    const {
      sizeX, sizeY, sizeZ,
      fuel,
      rates = DEFAULT_RATES,
      restarts = 3,
      // Speed is not a concern here (this runs client-side, once per click,
      // and each iteration is a cheap O(volume) full re-evaluation) - the
      // bottleneck is search quality, not wall-clock time, so the default
      // is intentionally high compared to a typical annealing schedule.
      iterations = 30000,
    } = options;
    const rng = options.rng || Math.random;
    const searchOpts = { ...options, iterations };

    let best = null;
    for (let r = 0; r < restarts; ++r) {
      const seed = buildGreedySeed(sizeX, sizeY, sizeZ, options);
      const { grid, eval: evalResult } = annealingRefine(seed, fuel, rates, searchOpts, rng);
      if (best === null || evalResult.score > best.eval.score)
        best = { grid, eval: evalResult };
    }

    // Deterministic Ed pass, done once on the final winner - see finalizeCorners().
    finalizeCorners(best.grid, rates, options.maxAllowed);

    // Sweep away whatever's still inactive after everything above - see
    // clearInactiveCoolers() for why this has to be careful about Sn/Lp.
    clearInactiveCoolers(best.grid);

    best.eval = fitness(best.grid, fuel, rates, options);

    return best;
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------
  const ReactorSolver = { TYPE, TYPE_NAMES, DEFAULT_RATES, Grid, computeStats, isCoolerActive, finalizeCorners, clearInactiveCoolers, solve };
  if (typeof module !== 'undefined' && module.exports) module.exports = ReactorSolver;
  else global.ReactorSolver = ReactorSolver;
})(typeof window !== 'undefined' ? window : globalThis);
