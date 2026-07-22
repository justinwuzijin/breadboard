// Bidirectional CircuitJS schematic ↔ breadboard conversion.
// Import uses live CircuitJS element posts (accurate gate pin geometry).
// Export rebuilds a conventional gate-level schematic from the breadboard.

import { BODY, HOLE_BY_ID, baseNetOf, COLS, RAIL_COUNT } from './board.js';
import { CATALOG, DEF_BY_ID } from './parts.js';

// ---- gate / IC packing tables ------------------------------------------------

export const GATE_TO_IC = {
  inverter: { id: 'hc14', gatesPerChip: 6, inputs: 1 },
  and:      { id: 'hc08', gatesPerChip: 4, inputs: 2 },
  or:       { id: 'hc32', gatesPerChip: 4, inputs: 2 },
  nand:     { id: 'hc00', gatesPerChip: 4, inputs: 2 },
  nor:      { id: 'hc02', gatesPerChip: 4, inputs: 2 },
  xor:      { id: 'hc86', gatesPerChip: 4, inputs: 2 },
  dff:      { id: 'cd4013', gatesPerChip: 2, inputs: 2 },
};

// CircuitJS JS class name → our gate type
const ELM_GATE = {
  InverterElm: 'inverter',
  InvertingSchmittElm: 'inverter',
  AndGateElm: 'and',
  OrGateElm: 'or',
  NandGateElm: 'nand',
  NorGateElm: 'nor',
  XorGateElm: 'xor',
  XnorGateElm: 'xnor', // unsupported on breadboard (no HC XNOR) — reported
  DFlipFlopElm: 'dff',
};

// Text dump-type codes (legacy .txt circuits)
const DUMP_GATE = {
  73: 'inverter',
  150: 'and',
  151: 'nand',
  152: 'or',
  153: 'nor',
  154: 'xor',
  155: 'dff',
};

// Pin-index maps keyed by def.pins order from dipPins()
// (upper L→R = VCC…pin8, lower L→R = pin1…GND)
function gatePinMap(gateType, slot) {
  if (gateType === 'inverter') {
    return [
      { input: [7], output: 8 },
      { input: [9], output: 10 },
      { input: [11], output: 12 },
      { input: [5], output: 6 },
      { input: [3], output: 4 },
      { input: [1], output: 2 },
    ][slot];
  }
  if (gateType === 'nor') {
    // 74HC02: Y,A,B order on each gate
    return [
      { input: [8, 9], output: 7 },
      { input: [11, 12], output: 10 },
      { input: [6, 5], output: 4 },
      { input: [3, 2], output: 1 },
    ][slot];
  }
  if (gateType === 'dff') {
    return [
      { input: [9, 11], output: 7, qn: 8, rst: 10, set: 12 }, // CLK1,D1→Q1
      { input: [3, 5], output: 1, qn: 2, rst: 4, set: 6 },   // CLK2,D2→Q2
    ][slot];
  }
  // HC08 / HC00 / HC32 / HC86
  return [
    { input: [7, 8], output: 9 },
    { input: [10, 11], output: 12 },
    { input: [5, 4], output: 6 },
    { input: [2, 1], output: 3 },
  ][slot];
}

// DIP hole layout matching dipPins geometry (14-pin, half=7)
function dip14Holes(icCol) {
  return [
    `${icCol}e`, `${icCol + 1}e`, `${icCol + 2}e`, `${icCol + 3}e`,
    `${icCol + 4}e`, `${icCol + 5}e`, `${icCol + 6}e`,
    `${icCol}f`, `${icCol + 1}f`, `${icCol + 2}f`, `${icCol + 3}f`,
    `${icCol + 4}f`, `${icCol + 5}f`, `${icCol + 6}f`,
  ];
}

const RES_DEFS = CATALOG.filter((d) => d.sim?.type === 'resistor');
function nearestResistorDef(ohms) {
  let best = RES_DEFS[0], bd = Infinity;
  for (const d of RES_DEFS) {
    const diff = Math.abs(Math.log(d.props.ohms) - Math.log(ohms || 1000));
    if (diff < bd) { bd = diff; best = d; }
  }
  return best;
}

function railHoleNear(rail, col) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < RAIL_COUNT; i++) {
    const rc = 2 + i + Math.floor(i / 5);
    const d = Math.abs(rc - col);
    if (d < bd) { bd = d; best = i; }
  }
  return `${rail}${best}`;
}

const NET_COLORS = ['#3fa54a', '#2f6fed', '#e07b39', '#8e44ad', '#16a085', '#e8b53a'];

/** Map CircuitJS LED RGB (0–1) → breadboard LED colour prop. */
function ledColorFromRgb(r = 0, g = 0, b = 0) {
  if (g >= 0.45 && r >= 0.45 && b < 0.35) return 'yellow';
  if (g >= r && g >= b && g >= 0.35) return 'green';
  return 'red';
}

/** Infer LED colour from a nearby schematic label (e.g. "NS Yellow"). */
function ledColorFromLabel(text = '') {
  const t = String(text).toLowerCase();
  if (/\byellow\b/.test(t)) return 'yellow';
  if (/\bgreen\b/.test(t)) return 'green';
  if (/\bred\b/.test(t)) return 'red';
  return null;
}

const SKIP_TYPES = new Set([
  'ScopeElm', 'OutputElm', 'ProbeElm', 'BoxElm', 'TextElm', 'GraphicElm',
  'RelayElm',
]);

const UNSUPPORTED_HINT = {
  CapacitorElm: 'capacitor', InductorElm: 'inductor', DiodeElm: 'diode',
  NTransistorElm: 'transistor', PTransistorElm: 'transistor',
  NMosfetElm: 'MOSFET', PMosfetElm: 'MOSFET', OpAmpElm: 'op-amp',
  TransformerElm: 'transformer', CurrentElm: 'current source',
  XnorGateElm: 'XNOR gate (no breadboard IC)',
  JKFlipFlopElm: 'JK flip-flop', TFlipFlopElm: 'T flip-flop',
  CounterElm: 'counter', MultiplexerElm: 'multiplexer',
};

// ---- read live CircuitJS circuit --------------------------------------------

function postKey(p) {
  return `${Math.round(p.x_0)},${Math.round(p.y_0)}`;
}

/** Read connectivity from live CircuitJS elements (preferred). */
export function readLiveCircuit(sim) {
  if (!sim || typeof sim.getElements !== 'function') {
    throw new Error('CircuitJS simulator not ready');
  }
  const elms = sim.getElements();
  const parent = new Map();
  const add = (a) => { if (!parent.has(a)) parent.set(a, a); };
  const find = (a) => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    let n = a;
    while (parent.get(n) !== r) { const nx = parent.get(n); parent.set(n, r); n = nx; }
    return r;
  };
  const uni = (a, b) => {
    add(a); add(b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const elems = [];   // passives / switches / wires / power markers
  const gates = [];   // logic
  const unsupported = new Set();
  const labels = [];  // schematic TextElm labels used to colour LEDs

  for (const elm of elms) {
    const type = elm.getType();
    // Collect labels before the skip set — Lab 4 names LEDs "NS Yellow", etc.
    if (type === 'TextElm') {
      const text = elm.text_0 || elm.text || '';
      const color = ledColorFromLabel(text);
      if (color) {
        labels.push({
          text,
          color,
          x: elm.x_0 ?? elm.point1?.x_0 ?? 0,
          y: elm.y_0 ?? elm.point1?.y_0 ?? 0,
        });
      }
      continue;
    }
    if (SKIP_TYPES.has(type)) continue;

    const n = elm.getPostCount();
    const posts = [];
    for (let i = 0; i < n; i++) {
      const p = elm.getPost(i);
      if (!p) continue;
      const k = postKey(p);
      add(k);
      posts.push(k);
    }
    if (!posts.length) continue;

    if (type === 'WireElm') {
      if (posts.length >= 2) uni(posts[0], posts[1]);
      elems.push({ type: 'w', a: posts[0], b: posts[1] });
      continue;
    }
    if (type === 'GroundElm') {
      elems.push({ type: 'g', a: posts[0], b: posts[0] });
      continue;
    }
    if (type === 'RailElm') {
      // high/low rail — treat as voltage marker on that net
      const info = (elm.getInfo?.() || []).join(' ').toLowerCase();
      const isGnd = info.includes('ground') || info.includes('0 v');
      elems.push({ type: isGnd ? 'g' : 'v', a: posts[0], b: posts[0], volts: elm.maxVoltage_0 ?? 5 });
      continue;
    }
    if (type === 'VoltageElm' || type === 'DCVoltageElm') {
      // post0 = negative end (point1), post1 = positive (point2) for DC
      elems.push({
        type: 'v', a: posts[0], b: posts[1] || posts[0],
        volts: elm.maxVoltage_0 ?? 5,
      });
      continue;
    }
    if (type === 'ResistorElm') {
      elems.push({ type: 'r', a: posts[0], b: posts[1], ohms: elm.resistance || 1000 });
      continue;
    }
    if (type === 'LEDElm') {
      const px = elm.x_0 ?? elm.point1?.x_0 ?? 0;
      const py = elm.y_0 ?? elm.point1?.y_0 ?? 0;
      elems.push({
        type: 'led',
        a: posts[0],
        b: posts[1],
        // Lab 4 dumps often leave every LED as red RGB; labels override below.
        color: ledColorFromRgb(elm.colorR ?? 1, elm.colorG ?? 0, elm.colorB ?? 0),
        x: px,
        y: py,
      });
      continue;
    }
    if (type === 'SwitchElm' || type === 'PushSwitchElm' || type === 'Switch2Elm'
      || type === 'AnalogSwitchElm' || type === 'AnalogSwitch2Elm') {
      // Analog switches in lab circuits are used as CLK/Reset push contacts
      if (posts.length >= 2) elems.push({ type: 's', a: posts[0], b: posts[1] });
      continue;
    }
    if (type === 'LogicInputElm') {
      elems.push({ type: 'lin', a: posts[0], b: posts[0] });
      continue;
    }
    if (type === 'LogicOutputElm') {
      elems.push({ type: 'lout', a: posts[0], b: posts[0] });
      continue;
    }

    if (type in ELM_GATE) {
      const gateType = ELM_GATE[type];
      if (gateType === 'xnor') {
        unsupported.add(UNSUPPORTED_HINT.XnorGateElm);
        continue;
      }
      if (gateType === 'dff') {
        // posts: 0=D, 1=Q, 2=Qn, 3=CLK, optional 4=R, 5=S
        // flags&8 = CircuitJS "Invert Set/Reset" (active-low bubbles). Real
        // CD4013 SET/RST are active-high, so the breadboard builder must flip
        // idle-high schematic ties to GND (see invertSR handling below).
        gates.push({
          gateType: 'dff',
          inputs: [posts[3], posts[0]], // CLK, D
          output: posts[1],
          qn: posts[2],
          rst: posts[4] || null,
          set: posts[5] || null,
          invertSR: !!((elm.flags ?? 0) & 8),
        });
        continue;
      }
      const inputCount = Math.max(1, posts.length - 1);
      const inputs = posts.slice(0, inputCount);
      const output = posts[inputCount];
      gates.push({ gateType, inputs, output });
      continue;
    }

    if (UNSUPPORTED_HINT[type]) unsupported.add(UNSUPPORTED_HINT[type]);
    else unsupported.add(type.replace(/Elm$/, ''));
  }

  // Prefer schematic labels ("NS Yellow") over RGB — Lab 4 LEDs are often all red in dump.
  for (const e of elems) {
    if (e.type !== 'led' || !labels.length) continue;
    let best = null, bd = Infinity;
    for (const lab of labels) {
      const d = (lab.x - e.x) ** 2 + (lab.y - e.y) ** 2;
      if (d < bd) { bd = d; best = lab; }
    }
    // ~120px in CircuitJS units is still "next to" the LED body
    if (best && bd < 180 * 180) e.color = best.color;
  }

  // Expand 3+/N-input gates into binary trees of 2-input gates (74xx packing)
  const expanded = expandMultiInputGates(gates, add);
  return { elems, gates: expanded, find, unsupported, parent };
}

/** Turn a 4-input OR/AND/etc into a tree of 2-input gates. */
function expandMultiInputGates(gates, add) {
  const out = [];
  let seq = 0;
  for (const g of gates) {
    const info = GATE_TO_IC[g.gateType];
    if (!info || g.gateType === 'dff' || g.gateType === 'inverter') {
      out.push(g);
      continue;
    }
    const maxIn = info.inputs;
    if (g.inputs.length <= maxIn) {
      out.push(g);
      continue;
    }
    // Left-associative reduction: (((a∨b)∨c)∨d)
    let acc = g.inputs[0];
    for (let i = 1; i < g.inputs.length; i++) {
      const isLast = i === g.inputs.length - 1;
      const dest = isLast ? g.output : `__t${seq++}`;
      if (!isLast) add(dest);
      out.push({ gateType: g.gateType, inputs: [acc, g.inputs[i]], output: dest });
      acc = dest;
    }
  }
  return out;
}

// ---- schematic → breadboard -------------------------------------------------

/**
 * @param {object} circuit  from readLiveCircuit()
 * @param {object} api      { addPart, addWire, clearBoard }
 */
export function buildBreadboard(circuit, api) {
  const { elems, gates, find, unsupported } = circuit;
  if (unsupported.size) {
    return `can't build — unsupported part(s): ${[...unsupported].join(', ')}. supported: resistor, LED, switch, logic gates, D flip-flops, logic in/out, power, ground.`;
  }
  const hasPassive = elems.some((e) => ['r', 'led', 's', 'lin', 'lout'].includes(e.type));
  if (!hasPassive && !gates.length) {
    return 'nothing to build — add a resistor, LED, switch, logic gate, or logic I/O';
  }

  // Pack gates into physical ICs
  const chipInstances = [];
  const gateToChip = new Map();
  for (const gate of gates) {
    const icInfo = GATE_TO_IC[gate.gateType];
    if (!icInfo) continue;
    let chip = chipInstances.find((c) =>
      c.type === gate.gateType && c.gates.length < icInfo.gatesPerChip);
    if (!chip) {
      const icDef = DEF_BY_ID.get(icInfo.id);
      if (!icDef) continue;
      chip = { type: gate.gateType, icDef, gates: [] };
      chipInstances.push(chip);
    }
    const slot = chip.gates.length;
    chip.gates.push(gate);
    gateToChip.set(gate, { chip, slot });
  }

  const dffCount = gates.filter((g) => g.gateType === 'dff').length;
  if (dffCount > 8) {
    return `can't build — schematic has ${dffCount} flip-flops (looks like two circuits in one file). Import one circuit: circuits/lab4-counter.txt or circuits/lab4-traffic.txt.`;
  }

  // 14-pin DIPs span 7 columns; leave 1 empty column between chips so they
  // never sit flush (physically impossible on a real board).
  const IC_WIDTH = 7;
  const IC_PITCH = IC_WIDTH + 1; // +1 gap
  const SWITCH_COLS = 8; // cols 1..7 for switches; ICs start at 8
  const icStart = SWITCH_COLS;
  const icColsNeeded = chipInstances.length
    ? icStart + (chipInstances.length - 1) * IC_PITCH + (IC_WIDTH - 1)
    : 0;
  if (icColsNeeded > COLS) {
    return `can't build — ${chipInstances.length} ICs need columns through ${icColsNeeded}, board has ${COLS}. Import one circuit at a time (Lab 4 has two — use circuits/lab4-counter.txt or circuits/lab4-traffic.txt).`;
  }

  api.clearBoard();

  // Classify power nets
  const ground = new Set(), plus = new Set();
  for (const e of elems) {
    if (e.type === 'g') ground.add(find(e.a));
    if (e.type === 'v') {
      if (e.a === e.b) plus.add(find(e.a));
      else { ground.add(find(e.a)); plus.add(find(e.b)); }
    }
  }
  const isGroundR = (root) => ground.has(root);
  const isPlusR = (root) => plus.has(root) && !ground.has(root);

  // Hole occupancy: part pins + each wire end get a unique hole (breadboard rule).
  const occupied = new Set();
  const markHoles = (holes) => { for (const h of holes || []) if (h) occupied.add(h); };
  // Prefer free rows; include e/f as last resort so dense builds still get jumpers
  const TOP_TAP = ['a', 'b', 'c', 'd', 'e'];
  const BOT_TAP = ['j', 'i', 'h', 'g', 'f'];
  const allocTap = (col, top) => {
    if (col < 1 || col > COLS) return null;
    for (const r of (top ? TOP_TAP : BOT_TAP)) {
      const id = `${col}${r}`;
      if (!HOLE_BY_ID.has(id) || occupied.has(id)) continue;
      occupied.add(id);
      return id;
    }
    return null;
  };
  const usedRails = new Set();
  const allocRail = (rail, col) => {
    let best = null, bd = Infinity;
    for (let i = 0; i < RAIL_COUNT; i++) {
      const id = `${rail}${i}`;
      if (!HOLE_BY_ID.has(id) || occupied.has(id) || usedRails.has(id)) continue;
      const rc = 2 + i + Math.floor(i / 5);
      const d = Math.abs(rc - col);
      if (d < bd) { bd = d; best = id; }
    }
    if (best) { usedRails.add(best); occupied.add(best); }
    return best;
  };

  const netHome = new Map();
  const netPinHole = new Map(); // schematic net root → IC / part pin hole (for direct wires)
  const powerPlus = new Map();  // key col:top → {col,top}
  const powerMinus = new Map();
  const jumpers = [];
  const signalWires = []; // { a: holeId, b: holeId } — IC pin → LED/resistor, etc.
  const registerNet = (root, col, top, pinHole = null) => {
    if (col < 1 || col > COLS) return;
    if (isGroundR(root)) { powerMinus.set(`${col}:${top ? 1 : 0}`, { col, top }); return; }
    if (isPlusR(root)) { powerPlus.set(`${col}:${top ? 1 : 0}`, { col, top }); return; }
    // Prefer a direct pin→pin wire when two IC pins share a net (ring counters,
    // gate chains). Column jumpers via allocTap silently drop when the board
    // is dense — that was killing Lab 4's last ring stage.
    if (pinHole) {
      if (!netPinHole.has(root)) netPinHole.set(root, pinHole);
      else if (netPinHole.get(root) !== pinHole) {
        signalWires.push({ a: netPinHole.get(root), b: pinHole });
      }
    }
    if (netHome.has(root)) {
      const h = netHome.get(root);
      if (h.col !== col || h.top !== top) jumpers.push({ a: h, b: { col, top } });
    } else netHome.set(root, { col, top });
  };

  const placed = { r: 0, led: 0, sw: 0, lin: 0, lout: 0 };
  let swCursor = 1;

  // Lab 4 "Reset from Fault" is an enable hold: the signal net feeds inverted
  // SET/RST on the DFFs. While held (active-low on that bus) the ring can run
  // and LED cathodes are grounded through the same button; released → LEDs off.
  const enableNets = new Set();
  for (const g of gates) {
    if (g.gateType !== 'dff' || !g.invertSR) continue;
    for (const k of [g.set, g.rst]) {
      if (!k) continue;
      const r = find(k);
      if (!isPlusR(r) && !isGroundR(r)) enableNets.add(r);
    }
  }
  /** @type {string|null} */
  let enableNet = null;
  /** Button hole on the enable bus — LED cathodes wire here directly. */
  let enableHole = null;

  // 1) Pushbuttons straddle the ravine (e↔f) so they bridge top and bottom halves
  for (const e of elems) {
    if (e.type !== 's' && e.type !== 'lin') continue;
    if (swCursor + 2 >= SWITCH_COLS) break;
    const c0 = swCursor;
    if (e.type === 'lin') {
      const pull = nearestResistorDef(10000);
      const pullCol = Math.min(c0 + 3, SWITCH_COLS - 1);
      const pullHoles = [`${c0}b`, `${pullCol}b`];
      api.addPart(pull, { holes: pullHoles, rot: 0, props: { ohms: 10000 } });
      markHoles(pullHoles);
      placed.r++;
      powerPlus.set(`${pullCol}:1`, { col: pullCol, top: true });
    }
    const btnHoles = [`${c0}e`, `${c0 + 2}e`, `${c0}f`, `${c0 + 2}f`];
    api.addPart(DEF_BY_ID.get('button'), { holes: btnHoles, rot: 0 });
    markHoles(btnHoles);
    const netA = find(e.a), netB = find(e.b || e.a);
    // Tactile switch: a1↔a2 and b1↔b2 are ALWAYS shorted. Only a1↔b1
    // closes on press (top↔bottom, same column). Never put the two switch
    // nets on a1/a2 (c0 and c0+2 top) — that welds them closed permanently.
    const wireHoldEnable = (sigNet) => {
      // 10k pull-up to VCC; press shorts signal → GND (active-low enable bus).
      // Pull must use column c0+1 — NOT c0+2. The tactile switch permanently
      // shorts a1↔a2 (c0↔c0+2), so putting VCC on c0+2 would hard-short the
      // rail to GND whenever the button is held.
      const pull = nearestResistorDef(10000);
      const pullCol = c0 + 1;
      const pullHoles = [`${c0}b`, `${pullCol}b`];
      if (pullCol < SWITCH_COLS && !pullHoles.some((h) => occupied.has(h))) {
        api.addPart(pull, { holes: pullHoles, rot: 0, props: { ohms: 10000 } });
        markHoles(pullHoles);
        placed.r++;
        powerPlus.set(`${pullCol}:1`, { col: pullCol, top: true });
      }
      registerNet(sigNet, c0, true, `${c0}e`);
      powerMinus.set(`${c0}:0`, { col: c0, top: false });
      enableNet = sigNet;
      enableHole = `${c0}e`;
      placed.sw++;
    };
    if (e.type === 'lin') {
      // signal on top, ground on bottom — press pulls signal low
      registerNet(netA, c0, true);
      powerMinus.set(`${c0}:0`, { col: c0, top: false });
      placed.lin++;
    } else if (isPlusR(netA) && !isPlusR(netB) && enableNets.has(netB)) {
      wireHoldEnable(netB);
    } else if (isPlusR(netB) && !isPlusR(netA) && enableNets.has(netA)) {
      wireHoldEnable(netA);
    } else if (isPlusR(netA) && !isPlusR(netB)) {
      // CLK style: VCC -- switch -- signal (active-high pulse)
      registerNet(netA, c0, true);
      registerNet(netB, c0, false);
      placed.sw++;
    } else if (isPlusR(netB) && !isPlusR(netA)) {
      registerNet(netB, c0, true);
      registerNet(netA, c0, false);
      placed.sw++;
    } else if (isGroundR(netA) && !isGroundR(netB)) {
      // signal on top, ground on bottom — press to ground
      registerNet(netB, c0, true);
      registerNet(netA, c0, false);
      placed.sw++;
    } else if (isGroundR(netB) && !isGroundR(netA)) {
      registerNet(netA, c0, true);
      registerNet(netB, c0, false);
      placed.sw++;
    } else {
      // Two signal nets: bridge across the ravine on one column
      registerNet(netA, c0, true);
      registerNet(netB, c0, false);
      placed.sw++;
    }
    swCursor = c0 + 3;
  }

  // 2) ICs packed along the ravine starting after the switch reserve
  const icPlacements = [];
  const icPower = [];
  let icCol = icStart;
  for (const chip of chipInstances) {
    if (icCol + IC_WIDTH - 1 > COLS) {
      return `can't build — ran out of board columns placing ${chip.icDef.id}. Split the schematic into one circuit.`;
    }
    const holes = dip14Holes(icCol);
    if (!holes.every((h) => HOLE_BY_ID.has(h))) {
      return `can't build — invalid IC placement at column ${icCol}`;
    }
    const icInst = api.addPart(chip.icDef, { holes, rot: 0 });
    markHoles(holes);
    icPlacements.push({ chip, inst: icInst, col: icCol });
    // VCC = pin14 @ col e, GND = pin7 @ col+6 f — tap other rows in those columns
    icPower.push(
      { type: 'vcc', col: icCol, top: true },
      { type: 'gnd', col: icCol + IC_WIDTH - 1, top: false },
    );
    icCol += IC_PITCH;
  }

  // Wire gate signals onto IC pins
  for (const gate of gates) {
    const mapping = gateToChip.get(gate);
    if (!mapping) continue;
    const { chip, slot } = mapping;
    const placement = icPlacements.find((p) => p.chip === chip);
    if (!placement) continue;
    const pins = gatePinMap(chip.type, slot);
    if (!pins) continue;
    const icInst = placement.inst;

    const nInputs = Math.min(gate.inputs.length, pins.input.length);
    for (let i = 0; i < nInputs; i++) {
      const inputNet = find(gate.inputs[i]);
      const hole = icInst.holes[pins.input[i]];
      const holeCol = parseInt(hole.match(/\d+/)[0], 10);
      registerNet(inputNet, holeCol, hole.endsWith('e'), hole);
    }
    const outputNet = find(gate.output);
    const outHole = icInst.holes[pins.output];
    registerNet(outputNet, parseInt(outHole.match(/\d+/)[0], 10), outHole.endsWith('e'), outHole);

    if (chip.type === 'dff') {
      // Wire SET/RST onto the real CD4013 (active-high). When the schematic
      // uses CircuitJS inverted S/R, an idle +5 V rail means "inactive" and
      // must become GND on the breadboard; a pulsed signal net stays a signal
      // (Lab 4 Reset-from-Fault: press → high → assert).
      const tieSR = (postIdx, netKey) => {
        if (postIdx == null) return;
        const h = icInst.holes[postIdx];
        const col = parseInt(h.match(/\d+/)[0], 10);
        const top = h.endsWith('e');
        const key = `${col}:${top ? 1 : 0}`;
        if (!netKey) {
          powerMinus.set(key, { col, top });
          return;
        }
        const root = find(netKey);
        if (gate.invertSR && isPlusR(root)) {
          powerMinus.set(key, { col, top });
          return;
        }
        if (gate.invertSR && isGroundR(root)) {
          powerPlus.set(key, { col, top });
          return;
        }
        registerNet(root, col, top, h);
      };
      tieSR(pins.rst, gate.rst);
      tieSR(pins.set, gate.set);
    }
  }

  // Tie unused gate inputs
  for (const { chip, inst } of icPlacements) {
    const used = new Set();
    for (let s = 0; s < chip.gates.length; s++) {
      const pins = gatePinMap(chip.type, s);
      if (!pins) continue;
      for (const idx of pins.input) used.add(idx);
      used.add(pins.output);
      if (pins.qn != null) used.add(pins.qn);
      if (pins.rst != null) used.add(pins.rst);
      if (pins.set != null) used.add(pins.set);
    }
    const icInfo = GATE_TO_IC[chip.type];
    for (let s = chip.gates.length; s < icInfo.gatesPerChip; s++) {
      const pins = gatePinMap(chip.type, s);
      if (!pins) continue;
      for (const idx of pins.input) {
        if (used.has(idx)) continue;
        const hole = inst.holes[idx];
        const holeCol = parseInt(hole.match(/\d+/)[0], 10);
        const top = hole.endsWith('e');
        const key = `${holeCol}:${top ? 1 : 0}`;
        if (chip.type === 'nor' || chip.type === 'or') powerMinus.set(key, { col: holeCol, top });
        else powerPlus.set(key, { col: holeCol, top });
      }
    }
  }

  // 3) LED + series resistor in free columns (never share a column with an IC pin)
  // Layout per LED (exclusive columns, no shared holes between chains):
  //   c0     c0+3      c0+4  c0+5     then ≥1 gap before next LED
  //   R──────R         LED+  LED-→GND
  // Drive ties into c0; resistor end and LED share column c0+3 (series net).
  const icColSet = new Set();
  for (const p of icPlacements) {
    for (let k = 0; k < IC_WIDTH; k++) icColSet.add(p.col + k);
  }
  const icRight = icPlacements.reduce((m, p) => Math.max(m, p.col + IC_WIDTH - 1), swCursor);
  const ledUsedCols = new Set();
  const LED_SPAN = 5;   // columns c0 .. c0+4 occupied by one R+LED chain
  const LED_STRIDE = 6; // +1 empty column between chains

  const findLedSlot = () => {
    const tryCol = (c) => {
      if (c < 1 || c + LED_SPAN - 1 > COLS) return null;
      for (let k = 0; k < LED_SPAN; k++) {
        if (icColSet.has(c + k) || ledUsedCols.has(c + k)) return null;
      }
      // Resistor on b: c0 ↔ c0+3; LED on a: c0+3 ↔ c0+4 (series at column c0+3).
      const holes = [`${c}b`, `${c + 3}b`, `${c + 3}a`, `${c + 4}a`];
      if (holes.some((h) => occupied.has(h) || !HOLE_BY_ID.has(h))) return null;
      return c;
    };
    // Prefer just past the rightmost IC (short jumpers), then scan right, then left
    for (let c = icRight + 2; c <= COLS - (LED_SPAN - 1); c++) {
      const hit = tryCol(c);
      if (hit != null) return hit;
    }
    for (let c = COLS - (LED_SPAN - 1); c >= 1; c--) {
      const hit = tryCol(c);
      if (hit != null) return hit;
    }
    return null;
  };

  // Only light LEDs that are actually driven by a placed gate output (lab4 a0/a1/a2).
  const gateOutNets = new Set();
  for (const gate of gates) {
    if (gate.output) gateOutNets.add(find(gate.output));
  }

  /** Drive net for an LED / logic-output: the side that is NOT ground. */
  const ledDriveNet = (e) => {
    const netA = find(e.a);
    const netB = find(e.b);
    if (e.type === 'lout') return netA;
    // Prefer the LED terminal that shares a node with a series resistor; the
    // resistor's other end is the gate/logic drive. Falls back to the non-GND end.
    const series = elems.find((x) => {
      if (x.type !== 'r') return false;
      const ra = find(x.a), rb = find(x.b);
      return ra === netA || rb === netA || ra === netB || rb === netB;
    });
    if (series) {
      const ra = find(series.a), rb = find(series.b);
      const mid = (ra === netA || ra === netB) ? ra : rb;
      const drive = mid === ra ? rb : ra;
      if (!isGroundR(drive)) return drive;
    }
    if (isGroundR(netA) && !isGroundR(netB)) return netB;
    if (isGroundR(netB) && !isGroundR(netA)) return netA;
    return netA;
  };

  // Place LEDs left→right in schematic order (Lab 4: NS R/Y/G, then EW R/Y/G).
  const ledElems = elems
    .filter((e) => e.type === 'led' || e.type === 'lout')
    .slice()
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0) || (a.y ?? 0) - (b.y ?? 0));

  for (const e of ledElems) {
    const signalNet = ledDriveNet(e);
    if (isGroundR(signalNet)) continue; // nowhere to drive from
    // Skip indicators that aren't tied to a gate we placed on the board
    if (!gateOutNets.has(signalNet)) continue;
    const c0 = findLedSlot();
    if (c0 == null) continue;
    const ohms = e.type === 'lout' ? 330 : (elems.find((x) => {
      if (x.type !== 'r') return false;
      const ra = find(x.a), rb = find(x.b);
      return ra === signalNet || rb === signalNet
        || ra === find(e.a) || rb === find(e.a)
        || ra === find(e.b) || rb === find(e.b);
    })?.ohms || 1000);
    const series = nearestResistorDef(ohms);
    const rHoles = [`${c0}b`, `${c0 + 3}b`];
    const lHoles = [`${c0 + 3}a`, `${c0 + 4}a`];
    // Final occupancy check — never put two part pins in one hole
    if ([...rHoles, ...lHoles].some((h) => occupied.has(h))) continue;
    const ledColor = e.color || 'red';
    api.addPart(series, { holes: rHoles, rot: 0, props: { ohms: series.props?.ohms || ohms } });
    api.addPart(DEF_BY_ID.get('led'), { holes: lHoles, rot: 0, props: { color: ledColor } });
    markHoles([...rHoles, ...lHoles]);
    for (let k = 0; k < LED_STRIDE; k++) {
      if (c0 + k <= COLS) ledUsedCols.add(c0 + k);
    }
    // Signal feeds the resistor's free end (column c0). Cathodes go to GND,
    // or — when Lab 4 has a hold-to-enable bus — to that bus so LEDs only
    // light while Reset-from-Fault is held (button shorts the bus to GND).
    const tap = allocTap(c0, true);
    const src = netPinHole.get(signalNet);
    if (src && tap) {
      signalWires.push({ a: src, b: tap });
    } else if (src) {
      // Tap failed — still register net home for a jumper
      registerNet(signalNet, c0, true);
    } else {
      registerNet(signalNet, c0, true);
    }
    if (enableHole) {
      // Share the LED cathode pin hole (same as IC pin→pin wires).
      const cath = `${c0 + 4}a`;
      if (HOLE_BY_ID.has(cath)) signalWires.push({ a: enableHole, b: cath });
      else powerMinus.set(`${c0 + 4}:1`, { col: c0 + 4, top: true });
    } else {
      powerMinus.set(`${c0 + 4}:1`, { col: c0 + 4, top: true });
    }
    placed.r++;
    placed.led++;
    if (e.type === 'lout') placed.lout++;
  }

  // Battery
  const supply = api.addPart(DEF_BY_ID.get('pow5'), { x: BODY.x - 78, y: BODY.y + BODY.h * 0.5 });
  const batPos = allocRail('T+', 3);
  const batNeg = allocRail('B-', 3);
  if (batPos) api.addWire({ port: [supply.uid, 'pos'] }, { hole: batPos }, '#d43c3c', 'wire');
  if (batNeg) api.addWire({ port: [supply.uid, 'neg'] }, { hole: batNeg }, '#26262a', 'wire');

  const safeWire = (a, b, color) => {
    if (!a?.hole || !b?.hole) return;
    if (!HOLE_BY_ID.has(a.hole) || !HOLE_BY_ID.has(b.hole)) return;
    api.addWire(a, b, color, 'wire');
  };

  for (const t of powerPlus.values()) {
    const board = allocTap(t.col, t.top);
    const rail = allocRail('T+', t.col);
    if (board && rail) safeWire({ hole: board }, { hole: rail }, '#d43c3c');
  }
  for (const t of powerMinus.values()) {
    const board = allocTap(t.col, t.top);
    const rail = allocRail('B-', t.col);
    if (board && rail) safeWire({ hole: board }, { hole: rail }, '#26262a');
  }
  for (const pwr of icPower) {
    const board = allocTap(pwr.col, pwr.top);
    const rail = allocRail(pwr.type === 'vcc' ? 'T+' : 'B-', pwr.col);
    if (board && rail) {
      safeWire({ hole: board }, { hole: rail }, pwr.type === 'vcc' ? '#d43c3c' : '#26262a');
    }
  }
  let ci = 0;
  for (const sw of signalWires) {
    safeWire({ hole: sw.a }, { hole: sw.b }, NET_COLORS[ci++ % NET_COLORS.length]);
  }
  for (const j of jumpers) {
    const ha = allocTap(j.a.col, j.a.top);
    const hb = allocTap(j.b.col, j.b.top);
    if (ha && hb) safeWire({ hole: ha }, { hole: hb }, NET_COLORS[ci++ % NET_COLORS.length]);
  }

  const parts = [];
  if (placed.r) parts.push(`${placed.r} resistor${placed.r > 1 ? 's' : ''}`);
  if (placed.led) parts.push(`${placed.led} LED${placed.led > 1 ? 's' : ''}`);
  if (placed.sw) parts.push(`${placed.sw} switch${placed.sw > 1 ? 'es' : ''}`);
  if (placed.lin) parts.push(`${placed.lin} logic input${placed.lin > 1 ? 's' : ''}`);
  if (placed.lout) parts.push(`${placed.lout} logic output${placed.lout > 1 ? 's' : ''}`);
  if (chipInstances.length) {
    const icCounts = {};
    for (const chip of chipInstances) {
      const name = chip.icDef.id.toUpperCase();
      icCounts[name] = (icCounts[name] || 0) + 1;
    }
    for (const [name, count] of Object.entries(icCounts)) parts.push(`${count} ${name}`);
  }
  return `built ${parts.join(', ')}`;
}

export function importFromSim(sim, api) {
  const circuit = readLiveCircuit(sim);
  return buildBreadboard(circuit, api);
}

/** True if the live schematic has parts Build can place on the breadboard. */
export function circuitHasBuildableContent(sim) {
  if (!sim || typeof sim.getElements !== 'function') return false;
  try {
    const { elems, gates } = readLiveCircuit(sim);
    const hasPassive = elems.some((e) => ['r', 'led', 's', 'lin', 'lout'].includes(e.type));
    return hasPassive || gates.length > 0;
  } catch {
    return false;
  }
}

// ---- breadboard → schematic -------------------------------------------------

const IC_TO_GATE = {
  hc14: 'inverter', hc08: 'and', hc32: 'or', hc00: 'nand',
  hc02: 'nor', hc86: 'xor', cd4013: 'dff',
};

const GATE_DUMP = {
  inverter: 73, and: 150, nand: 151, or: 152, nor: 153, xor: 154, dff: 155,
};

function epNet(ep, partsByUid) {
  if (ep.hole) return baseNetOf(ep.hole);
  const inst = partsByUid.get(ep.port?.[0]);
  if (!inst) return null;
  return `q${inst.uid}:${ep.port[1]}`;
}

function pinHoleNet(inst, pinIdx) {
  const hole = inst.holes?.[pinIdx];
  return hole ? baseNetOf(hole) : null;
}

/**
 * Build a conventional CircuitJS text circuit from the breadboard state.
 * ICs are exploded back into individual gate symbols.
 */
export function exportBreadboardToText(state) {
  const partsByUid = new Map(state.parts.map((p) => [p.uid, p]));

  // Union-find over breadboard nets via wires + shared columns
  const parent = new Map();
  const add = (a) => { if (a != null && !parent.has(a)) parent.set(a, a); };
  const find = (a) => {
    if (a == null) return null;
    add(a);
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r);
    let n = a;
    while (parent.get(n) !== r) { const nx = parent.get(n); parent.set(n, r); n = nx; }
    return r;
  };
  const uni = (a, b) => {
    if (a == null || b == null) return;
    add(a); add(b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const w of state.wires) {
    uni(epNet(w.a, partsByUid), epNet(w.b, partsByUid));
  }
  // Column continuity is already in baseNetOf (A{n}/B{n}/rails)

  // Identify power nets from supply parts
  let plusNet = null, gndNet = null;
  for (const inst of state.parts) {
    if (inst.def.sim?.type === 'supply') {
      plusNet = find(`q${inst.uid}:pos`);
      gndNet = find(`q${inst.uid}:neg`);
    }
  }
  // Also treat rail holes
  for (const [id] of HOLE_BY_ID) {
    if (id.startsWith('T+') || id.startsWith('B+')) {
      const n = find(baseNetOf(id));
      if (plusNet == null) plusNet = n;
      else uni(plusNet, n);
    }
    if (id.startsWith('T-') || id.startsWith('B-')) {
      const n = find(baseNetOf(id));
      if (gndNet == null) gndNet = n;
      else uni(gndNet, n);
    }
  }
  plusNet = plusNet != null ? find(plusNet) : null;
  gndNet = gndNet != null ? find(gndNet) : null;

  // Collect components to emit
  const passives = [];
  const gateElms = [];
  const logicIO = [];

  // Nets touched by a wire or non-IC part — used to ignore unused gates on a DIP
  const wiredNets = new Set();
  for (const w of state.wires) {
    const a = find(epNet(w.a, partsByUid));
    const b = find(epNet(w.b, partsByUid));
    if (a) wiredNets.add(a);
    if (b) wiredNets.add(b);
  }
  for (const inst of state.parts) {
    if (inst.def.sim?.type === 'ic') continue;
    for (const h of inst.holes || []) {
      const n = find(baseNetOf(h));
      if (n) wiredNets.add(n);
    }
  }

  for (const inst of state.parts) {
    const sim = inst.def.sim;
    if (!sim) continue;
    if (sim.type === 'resistor') {
      const a = find(pinHoleNet(inst, 0));
      const b = find(pinHoleNet(inst, 1));
      if (a && b) passives.push({ kind: 'r', a, b, ohms: inst.props.ohms || 1000 });
    } else if (sim.type === 'led') {
      const a = find(pinHoleNet(inst, 0));
      const b = find(pinHoleNet(inst, 1));
      if (a && b) passives.push({ kind: 'led', a, b });
    } else if (sim.type === 'button') {
      const a = find(pinHoleNet(inst, 0));
      const b = find(pinHoleNet(inst, 2)); // a1 ↔ b1 when pressed; use a1 and b1 columns
      if (a && b && a !== b) passives.push({ kind: 's', a, b });
    } else if (sim.type === 'ic') {
      const gateType = IC_TO_GATE[sim.icType];
      if (!gateType) continue;
      const icInfo = GATE_TO_IC[gateType];
      for (let slot = 0; slot < icInfo.gatesPerChip; slot++) {
        const pins = gatePinMap(gateType, slot);
        if (!pins) continue;
        const inputs = pins.input.map((idx) => find(pinHoleNet(inst, idx)));
        const output = find(pinHoleNet(inst, pins.output));
        const qn = pins.qn != null ? find(pinHoleNet(inst, pins.qn)) : null;
        // Skip unused gates: floating DIP pins still have column nets, so require a
        // wire (or other part) to touch at least one of this gate's signal pins.
        const pinNets = [...inputs, output, qn].filter(Boolean);
        const allInputsPower = inputs.every((n) => !n || n === plusNet || n === gndNet);
        if (!output || allInputsPower) continue;
        if (!pinNets.some((n) => wiredNets.has(n))) continue;
        if (gateType === 'dff') {
          const rst = pins.rst != null ? find(pinHoleNet(inst, pins.rst)) : null;
          const set = pins.set != null ? find(pinHoleNet(inst, pins.set)) : null;
          gateElms.push({ gateType, inputs, output, qn, rst, set });
        } else {
          gateElms.push({ gateType, inputs, output });
        }
      }
    }
  }

  // Detect conventional logic-I/O patterns created by import:
  //   pull-up (~10k to VCC) + button to GND  → LogicInput
  //   series R + LED to GND on a gate output → LogicOutput
  const skipPassive = new Set();
  const gateOutNets = new Set(gateElms.map((g) => g.output).filter(Boolean));

  for (const sw of passives.filter((p) => p.kind === 's')) {
    const signal = [sw.a, sw.b].find((n) => n !== gndNet && n !== plusNet);
    const other = signal === sw.a ? sw.b : sw.a;
    if (!signal || other !== gndNet) continue;
    const pull = passives.find((p) =>
      p.kind === 'r' &&
      ((p.a === signal && p.b === plusNet) || (p.b === signal && p.a === plusNet)) &&
      p.ohms >= 5000);
    if (!pull) continue;
    logicIO.push({ kind: 'lin', net: signal });
    skipPassive.add(sw);
    skipPassive.add(pull);
  }
  for (const led of passives.filter((p) => p.kind === 'led')) {
    // Import places: gateOut --Rseries-- LED+ --> LED- --> GND
    const series = passives.find((p) =>
      p.kind === 'r' && (p.a === led.a || p.b === led.a) && p.ohms <= 5000);
    if (!series) continue;
    const driveNet = series.a === led.a ? series.b : series.a;
    if (!gateOutNets.has(driveNet) && !gateOutNets.has(led.a) && !gateOutNets.has(led.b)) continue;
    const signal = gateOutNets.has(driveNet) ? driveNet
      : gateOutNets.has(led.a) ? led.a
      : led.b;
    logicIO.push({ kind: 'lout', net: signal });
    skipPassive.add(led);
    skipPassive.add(series);
  }

  const emitPassives = passives.filter((p) => !skipPassive.has(p));

  // Deduplicate logic IO
  const seenIO = new Set();
  const uniqIO = [];
  for (const io of logicIO) {
    const k = io.kind + ':' + io.net;
    if (seenIO.has(k)) continue;
    seenIO.add(k);
    uniqIO.push(io);
  }

  // Assign grid positions — lab4-style: DFF row, combo gates below, Manhattan wires
  const netXY = new Map();
  const lines = ['$ 1 5.0E-6 10.20027730826997 50 5.0 50'];
  const placed = [];

  const setNet = (net, pt) => {
    if (!net || !pt) return;
    if (!netXY.has(net)) netXY.set(net, { x: pt.x, y: pt.y });
  };

  /** Orthogonal wire segments (never diagonal). */
  const emitManhattan = (a, b, viaY = null) => {
    if (!a || !b) return;
    if (a.x === b.x && a.y === b.y) return;
    if (a.x === b.x || a.y === b.y) {
      lines.push(`w ${a.x} ${a.y} ${b.x} ${b.y} 0`);
      return;
    }
    if (viaY != null && viaY !== a.y && viaY !== b.y) {
      lines.push(`w ${a.x} ${a.y} ${a.x} ${viaY} 0`);
      lines.push(`w ${a.x} ${viaY} ${b.x} ${viaY} 0`);
      lines.push(`w ${b.x} ${viaY} ${b.x} ${b.y} 0`);
      return;
    }
    lines.push(`w ${a.x} ${a.y} ${b.x} ${a.y} 0`);
    lines.push(`w ${b.x} ${a.y} ${b.x} ${b.y} 0`);
  };

  // Digital rail (single-ended) — avoids VoltageElm "path to ground" shorts
  const vx = -320, vy = 80;
  lines.push(`R ${vx} ${vy} ${vx} ${vy - 32} 0 0 5.0`);
  lines.push(`g ${vx} 352 ${vx} 384 0`);
  if (plusNet) netXY.set(plusNet, { x: vx, y: vy });
  if (gndNet) netXY.set(gndNet, { x: vx, y: 352 });

  // Logic inputs stacked on the left (lab4 CLK / Reset style)
  let linY = 176;
  for (const io of uniqIO.filter((x) => x.kind === 'lin')) {
    if (netXY.has(io.net)) continue;
    const x = -176, y = linY;
    lines.push(`L ${x} ${y} ${x - 64} ${y} 0 false false`);
    netXY.set(io.net, { x, y });
    linY += 128;
  }

  const dffs = gateElms.filter((g) => g.gateType === 'dff');
  const combos = gateElms.filter((g) => g.gateType !== 'dff');

  // Flip-flops in a horizontal row (ChipElm cspc2=32 pin geometry)
  // Dump: 155 x1 y1 x2 y2 flags volts — f=14 = set+reset+invert
  const dffY = -16;
  const dffPitch = 224;
  let dffX = 16;
  for (const g of dffs) {
    const x1 = dffX;
    const y1 = dffY;
    const x2 = x1 + 64;
    lines.push(`155 ${x1} ${y1} ${x2} ${y1} 14 0`);
    const pins = {
      d: { x: x1, y: y1 },
      clk: { x: x1, y: y1 + 32 },
      set: { x: x1, y: y1 + 64 },
      q: { x: x1 + 96, y: y1 },
      qn: { x: x1 + 96, y: y1 + 32 },
      rst: { x: x1 + 96, y: y1 + 64 },
    };
    setNet(g.inputs[1], pins.d);
    setNet(g.inputs[0], pins.clk);
    setNet(g.output, pins.q);
    setNet(g.qn, pins.qn);
    setNet(g.set, pins.set);
    setNet(g.rst, pins.rst);
    // Tie Set to VCC with a local rail when the breadboard has it on +5
    if (g.set && plusNet && find(g.set) === plusNet) {
      lines.push(`R ${pins.set.x - 48} ${pins.set.y} ${pins.set.x - 16} ${pins.set.y} 0 0 5.0`);
      lines.push(`w ${pins.set.x - 16} ${pins.set.y} ${pins.set.x} ${pins.set.y} 0`);
    }
    placed.push({ gate: g, x1, y1, x2, y2: y1, pins });
    dffX += dffPitch;
  }
  const dffRight = dffs.length ? 16 + (dffs.length - 1) * dffPitch + 96 : 400;

  // Combinational gates BELOW the DFF row (lab4), not far off to the right
  const comboX = dffs.length
    ? Math.max(400, 16 + Math.max(0, dffs.length - 4) * dffPitch + 160)
    : 400;
  let comboY = dffY + 400;
  const comboH = 96;
  for (const g of combos) {
    const dump = GATE_DUMP[g.gateType];
    if (dump == null) continue;
    // Face left (output on left) so wires run back under the DFF row like lab4
    const x1 = comboX + 128;
    const y1 = comboY;
    const x2 = comboX;
    const y2 = y1;
    const inputCount = g.gateType === 'inverter' ? 1 : Math.min(2, g.inputs.length || 2);

    if (g.gateType === 'inverter') {
      lines.push(`73 ${x1} ${y1} ${x2} ${y2} 0 1 0.0 5.0`);
    } else {
      lines.push(`${dump} ${x1} ${y1} ${x2} ${y2} 0 ${inputCount} 0.0 5.0`);
    }

    const hs = 16;
    const pins = { out: { x: x2, y: y2 } };
    if (inputCount === 1) {
      pins.in0 = { x: x1, y: y1 };
      setNet(g.inputs[0], pins.in0);
    } else {
      pins.in0 = { x: x1, y: y1 - hs };
      pins.in1 = { x: x1, y: y1 + hs };
      setNet(g.inputs[0], pins.in0);
      setNet(g.inputs[1], pins.in1);
    }
    setNet(g.output, pins.out);
    placed.push({ gate: g, x1, y1, x2, y2, pins });
    comboY += comboH;
  }

  // Remaining passives below the flip-flop / gate block
  let px = 192;
  const py = Math.max(comboY + 48, dffY + 688);
  for (const p of emitPassives) {
    if (p.kind === 'r') {
      const drive = gateOutNets.has(p.a) ? p.a : gateOutNets.has(p.b) ? p.b : null;
      const src = drive ? netXY.get(drive) : null;
      const horiz = !drive;
      const ax = src ? src.x : px;
      const ay = src ? Math.max(src.y + 80, py) : py;
      const bx = horiz ? ax + 64 : ax;
      const by = horiz ? ay : ay + 96;
      lines.push(`r ${ax} ${ay} ${bx} ${by} 0 ${p.ohms}`);
      if (!netXY.has(p.a)) netXY.set(p.a, { x: ax, y: ay });
      if (!netXY.has(p.b)) netXY.set(p.b, { x: bx, y: by });
      if (drive && src && (p.a === drive || p.b === drive)) {
        const top = p.a === drive ? { x: ax, y: ay } : { x: bx, y: by };
        emitManhattan(src, top);
      } else {
        const ca = netXY.get(p.a), cb = netXY.get(p.b);
        if (ca) emitManhattan(ca, { x: ax, y: ay });
        if (cb) emitManhattan({ x: bx, y: by }, cb);
      }
      px = Math.max(px, ax) + 112;
    } else if (p.kind === 'led') {
      const drive = gateOutNets.has(p.a) ? p.a : null;
      const src = (drive && netXY.get(drive)) || netXY.get(p.a);
      const ax = src ? src.x : px;
      const ay = src ? Math.max(src.y + 160, py + 80) : py + 80;
      const bx = ax, by = ay + 48;
      lines.push(`162 ${ax} ${ay} ${bx} ${by} 1 default-led 1 0 0 0.01`);
      if (!netXY.has(p.a)) netXY.set(p.a, { x: ax, y: ay });
      if (!netXY.has(p.b)) netXY.set(p.b, { x: bx, y: by });
      const ca = netXY.get(p.a), cb = netXY.get(p.b);
      if (ca) emitManhattan(ca, { x: ax, y: ay });
      if (cb) emitManhattan({ x: bx, y: by }, cb);
      if (gndNet && find(p.b) === gndNet) {
        lines.push(`g ${bx} ${by + 16} ${bx} ${by + 32} 0`);
        lines.push(`w ${bx} ${by} ${bx} ${by + 16} 0`);
      }
      px = Math.max(px, ax) + 112;
    } else if (p.kind === 's') {
      const ax = px, ay = py + 160, bx = px + 48, by = py + 160;
      lines.push(`s ${ax} ${ay} ${bx} ${by} 0 1 false`);
      if (!netXY.has(p.a)) netXY.set(p.a, { x: ax, y: ay });
      if (!netXY.has(p.b)) netXY.set(p.b, { x: bx, y: by });
      const ca = netXY.get(p.a), cb = netXY.get(p.b);
      if (ca) emitManhattan(ca, { x: ax, y: ay });
      if (cb) emitManhattan({ x: bx, y: by }, cb);
      px += 96;
    }
  }

  // Logic outputs under their driving nets
  let loutFallbackX = Math.max(comboX + 48, dffRight + 48, 520);
  let loutY = py;
  for (const io of uniqIO.filter((x) => x.kind === 'lout')) {
    const src = netXY.get(io.net);
    const x = src ? src.x : loutFallbackX;
    const y = src ? Math.max(src.y + 112, py) : loutY;
    lines.push(`M ${x} ${y} ${x} ${y + 48} 0`);
    if (src) emitManhattan(src, { x, y });
    else netXY.set(io.net, { x, y });
    if (!src) {
      loutFallbackX += 96;
      loutY += 64;
    }
  }

  const terminals = new Map();
  const addTerm = (net, x, y) => {
    if (!net || x == null || y == null) return;
    if (!terminals.has(net)) terminals.set(net, []);
    const list = terminals.get(net);
    if (!list.some((t) => t.x === x && t.y === y)) list.push({ x, y });
  };

  for (const p of placed) {
    const g = p.gate;
    const pins = p.pins;
    if (g.gateType === 'dff') {
      addTerm(g.inputs[1], pins.d.x, pins.d.y);
      addTerm(g.inputs[0], pins.clk.x, pins.clk.y);
      addTerm(g.output, pins.q.x, pins.q.y);
      addTerm(g.qn, pins.qn.x, pins.qn.y);
      if (g.set && !(plusNet && find(g.set) === plusNet)) addTerm(g.set, pins.set.x, pins.set.y);
      if (g.rst) addTerm(g.rst, pins.rst.x, pins.rst.y);
    } else {
      if (pins.in0) addTerm(g.inputs[0], pins.in0.x, pins.in0.y);
      if (pins.in1) addTerm(g.inputs[1], pins.in1.x, pins.in1.y);
      addTerm(g.output, pins.out.x, pins.out.y);
    }
  }
  for (const io of uniqIO) {
    const pt = netXY.get(io.net);
    if (pt) addTerm(io.net, pt.x, pt.y);
  }
  for (const p of emitPassives) {
    if (p.kind !== 'r' && p.kind !== 'led') continue;
    const pa = netXY.get(p.a), pb = netXY.get(p.b);
    if (pa) addTerm(p.a, pa.x, pa.y);
    if (pb) addTerm(p.b, pb.x, pb.y);
  }
  // Power nets: only attach signal-side terminals; rails are already placed
  if (gndNet) {
    for (const p of placed) {
      if (p.gate.gateType === 'dff' && p.gate.rst && find(p.gate.rst) === gndNet) {
        addTerm(gndNet, p.pins.rst.x, p.pins.rst.y);
      }
    }
    const gp = netXY.get(gndNet);
    if (gp) addTerm(gndNet, gp.x, gp.y);
  }

  // MST with Manhattan edges; high-fanout nets use a horizontal bus channel
  const clkBusY = dffY + 192;
  const rstBusY = dffY + 320;
  for (const [net, terms] of terminals) {
    if (terms.length < 2) continue;
    const n = terms.length;
    const used = new Array(n).fill(false);
    used[0] = true;
    const busY = n >= 4
      ? (terms.every((t) => Math.abs(t.y - (dffY + 32)) < 8) ? clkBusY
        : terms.some((t) => Math.abs(t.y - (dffY + 64)) < 8) ? rstBusY
        : null)
      : null;
    for (let edge = 1; edge < n; edge++) {
      let bestI = -1, bestJ = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (!used[i]) continue;
        for (let j = 0; j < n; j++) {
          if (used[j]) continue;
          const dx = terms[i].x - terms[j].x;
          const dy = terms[i].y - terms[j].y;
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bestD) { bestD = d; bestI = i; bestJ = j; }
        }
      }
      if (bestJ < 0) break;
      used[bestJ] = true;
      emitManhattan(terms[bestI], terms[bestJ], busY);
    }
  }

  if (lines.length <= 1) {
    return { text: null, message: 'nothing to export — place parts on the breadboard first' };
  }

  const nGates = gateElms.length;
  const nPass = emitPassives.length;
  const nIO = uniqIO.length;
  return {
    text: lines.join('\n') + '\n',
    message: `exported ${nGates} gate${nGates === 1 ? '' : 's'}${nIO ? `, ${nIO} logic I/O` : ''}${nPass ? `, ${nPass} passive${nPass === 1 ? '' : 's'}` : ''} → schematic`,
  };
}
