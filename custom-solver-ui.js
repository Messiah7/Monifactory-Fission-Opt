// custom-solver-ui.js
// Wires the "Run Custom Solver" button to reactor-solver.js.
// Deliberately independent from main.js / the WASM engine - reads the same
// input fields, but writes its output into its own #customDesign block so
// both results stay visible side by side for comparison.

(function () {
  'use strict';

  // Index of each cooler type within the 33 inputs of the #limit row
  // (Step 3, "Max Allowed"). Order matches the table's header exactly:
  // Wt,Rs,Qz,Au,Gs,Lp,Dm,He,Ed,Cy,Fe,Em,Cu,Sn,Mg,Al,As,B,ES,Ft,Pb,N,Li,Mn,
  // NB,Nr,Ob,Pm,Pp,Ag,Sl, [cell], [mod]
  const LIMIT_INDEX = { LP: 5, ED: 8, SN: 13, MN: 23, CELL: 31 };

  function parseLimit(input) {
    if (!input || input.value.trim() === '') return Infinity; // blank = unlimited, same convention as main.js
    const n = parseInt(input.value, 10);
    return Number.isFinite(n) && n >= 0 ? n : Infinity;
  }

  function readMaxAllowed() {
    const limitInputs = document.querySelectorAll('#limit input');
    const RS = window.ReactorSolver;
    const maxAllowed = {};
    maxAllowed[RS.TYPE.LP] = parseLimit(limitInputs[LIMIT_INDEX.LP]);
    maxAllowed[RS.TYPE.ED] = parseLimit(limitInputs[LIMIT_INDEX.ED]);
    maxAllowed[RS.TYPE.SN] = parseLimit(limitInputs[LIMIT_INDEX.SN]);
    maxAllowed[RS.TYPE.MN] = parseLimit(limitInputs[LIMIT_INDEX.MN]);
    maxAllowed[RS.TYPE.CELL] = parseLimit(limitInputs[LIMIT_INDEX.CELL]);
    return maxAllowed;
  }

  function readFuel() {
    return {
      basePower: parseFloat(document.getElementById('fuelBasePower').value),
      baseHeat: parseFloat(document.getElementById('fuelBaseHeat').value),
    };
  }

  function readSize() {
    // Field order in the DOM is sizeZ, sizeX, sizeY (Step 1) - reused here
    // as-is so both solvers are always run on the exact same physical box,
    // regardless of what those ids are internally called.
    return {
      sizeX: parseInt(document.getElementById('sizeZ').value, 10),
      sizeY: parseInt(document.getElementById('sizeX').value, 10),
      sizeZ: parseInt(document.getElementById('sizeY').value, 10),
    };
  }

  function renderResult(result) {
    const RS = window.ReactorSolver;
    const design = document.getElementById('customDesign');
    design.innerHTML = '';

    const stats = result.eval.stats;
    const info = document.createElement('div');
    const row = (label, value, unit) => {
      const d = document.createElement('div');
      d.className = 'info';
      d.innerHTML = '<div>' + label + '</div><div>' + unit + '</div>' + (Math.round(value * 100) / 100);
      return d;
    };
    info.appendChild(row('Power', stats.power, 'RF/t'));
    info.appendChild(row('Heat', stats.heat, 'H/t'));
    info.appendChild(row('Cooling', stats.cooling, 'H/t'));
    info.appendChild(row('Net Heat', stats.netHeat, 'H/t'));
    info.appendChild(row('Fuel Cells', stats.cellCount, ''));
    info.appendChild(row('Lp / Ed / Sn / Mn', 0, ''));
    const counts = document.createElement('div');
    counts.textContent =
      'Lp: ' + stats.counts[RS.TYPE.LP] +
      '  Ed: ' + stats.counts[RS.TYPE.ED] +
      '  Sn: ' + stats.counts[RS.TYPE.SN] +
      '  Mn: ' + stats.counts[RS.TYPE.MN] +
      '  (inactive: ' + stats.inactiveCoolers + ')';
    info.appendChild(counts);
    design.appendChild(info);

    // Plain-text layer-by-layer view, one <pre> block per Y layer.
    const grid = result.grid;
    const glyph = ['.', 'C', 'L', 'E', 'S', 'M'];
    for (let y = 0; y < grid.sizeY; ++y) {
      const layerTitle = document.createElement('div');
      layerTitle.textContent = 'Layer ' + (y + 1) + ' / ' + grid.sizeY;
      design.appendChild(layerTitle);
      const pre = document.createElement('pre');
      pre.className = 'row';
      let text = '';
      for (let x = 0; x < grid.sizeX; ++x) {
        let line = '';
        for (let z = 0; z < grid.sizeZ; ++z)
          line += glyph[grid.get(x, y, z)] + ' ';
        text += line + '\n';
      }
      pre.textContent = text;
      design.appendChild(pre);
    }
  }

  function run() {
    const RS = window.ReactorSolver;
    if (!RS) {
      alert('reactor-solver.js failed to load.');
      return;
    }

    const progress = document.getElementById('customProgress');
    const design = document.getElementById('customDesign');
    design.innerHTML = '';
    progress.textContent = 'Running custom solver...';

    let size, fuel, maxAllowed;
    try {
      size = readSize();
      fuel = readFuel();
      maxAllowed = readMaxAllowed();
      if (!(size.sizeX > 0 && size.sizeY > 0 && size.sizeZ > 0))
        throw new Error('Core size must be set (Step 1) before running the custom solver.');
      if (!(fuel.basePower > 0 && fuel.baseHeat > 0))
        throw new Error('Fuel Base Power / Base Heat must be set (Step 2) before running the custom solver.');
    } catch (e) {
      progress.textContent = '';
      alert('Error: ' + e.message);
      return;
    }

    // Let the "Running..." message actually paint before the synchronous
    // solve() call blocks the main thread.
    setTimeout(() => {
      const start = performance.now();
      const result = RS.solve({ sizeX: size.sizeX, sizeY: size.sizeY, sizeZ: size.sizeZ, fuel, maxAllowed });
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      progress.textContent = 'Done in ' + elapsed + 's.';
      renderResult(result);
    }, 20);
  }

  document.getElementById('runCustom').addEventListener('click', run);
})();
