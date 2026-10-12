// Transparent formula engine. Expressions are parsed into an AST (no eval),
// identifiers are validated against the available curves, then compiled into
// closures and evaluated sample-by-sample on TypedArrays.

type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'between'; x: Node; lo: Node; hi: Node };

const FUNCS: Record<string, (...a: number[]) => number> = {
  log10: Math.log10, log: Math.log10, ln: Math.log, exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs,
  pow: Math.pow, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  clip: (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x),
  if: (c, a, b) => (c ? a : b),
  isnull: (x) => (x !== x ? 1 : 0),
  nz: (x, d) => (x !== x ? d : x),
};
export const FUNCTION_NAMES = Object.keys(FUNCS);

interface Tok { k: 'num' | 'id' | 'op' | '(' | ')' | ','; v: string }
function lex(s: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i))!; out.push({ k: 'num', v: m[0] }); i += m[0].length; continue; }
    if (/[A-Za-z_\[]/.test(c)) {
      if (c === '[') { const j = s.indexOf(']', i); if (j < 0) throw new Error('Unclosed [ in identifier'); out.push({ k: 'id', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i))!; out.push({ k: 'id', v: m[0] }); i += m[0].length; continue;
    }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||', '**'].includes(two)) { out.push({ k: 'op', v: two === '**' ? '^' : two }); i += 2; continue; }
    if ('+-*/^<>!'.includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push({ k: c, v: c } as Tok); i++; continue; }
    if (c === '=') { out.push({ k: 'op', v: '==' }); i++; continue; }
    throw new Error(`Unexpected character "${c}" at position ${i + 1}`);
  }
  return out;
}

export function parse(src: string): Node {
  const toks = lex(src); let p = 0;
  const peek = () => toks[p]; const next = () => toks[p++];
  const isKw = (w: string) => peek()?.k === 'id' && peek().v.toUpperCase() === w;
  const expect = (k: string) => { const t = next(); if (!t || t.k !== k) throw new Error(`Expected "${k}"`); return t; };
  function or(): Node { let a = and(); while (peek() && ((peek().k === 'op' && peek().v === '||') || isKw('OR'))) { next(); a = { t: 'bin', op: '||', a, b: and() }; } return a; }
  function and(): Node { let a = not(); while (peek() && ((peek().k === 'op' && peek().v === '&&') || isKw('AND'))) { next(); a = { t: 'bin', op: '&&', a, b: not() }; } return a; }
  function not(): Node { if (isKw('NOT') || (peek()?.k === 'op' && peek().v === '!')) { next(); return { t: 'un', op: '!', a: not() }; } return cmp(); }
  function cmp(): Node {
    const a = add();
    if (isKw('BETWEEN')) { next(); const lo = add(); if (!isKw('AND')) throw new Error('BETWEEN requires AND'); next(); const hi = add(); return { t: 'between', x: a, lo, hi }; }
    const t = peek(); if (t && t.k === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(t.v)) { next(); return { t: 'bin', op: t.v, a, b: add() }; }
    return a;
  }
  function add(): Node { let a = mul(); while (peek()?.k === 'op' && '+-'.includes(peek().v)) { const op = next().v; a = { t: 'bin', op, a, b: mul() }; } return a; }
  function mul(): Node { let a = unary(); while (peek()?.k === 'op' && '*/'.includes(peek().v)) { const op = next().v; a = { t: 'bin', op, a, b: unary() }; } return a; }
  function unary(): Node { if (peek()?.k === 'op' && (peek().v === '-' || peek().v === '+')) { const op = next().v; const a = unary(); return op === '-' ? { t: 'un', op: '-', a } : a; } return pow(); }
  function pow(): Node { const a = atom(); if (peek()?.k === 'op' && peek().v === '^') { next(); return { t: 'bin', op: '^', a, b: unary() }; } return a; }
  function atom(): Node {
    const t = next(); if (!t) throw new Error('Unexpected end of expression');
    if (t.k === 'num') return { t: 'num', v: parseFloat(t.v) };
    if (t.k === '(') { const e = or(); expect(')'); return e; }
    if (t.k === 'id') {
      if (peek()?.k === '(' && FUNCS[t.v.toLowerCase()]) {
        next(); const args: Node[] = [];
        if (peek()?.k !== ')') { args.push(or()); while (peek()?.k === ',') { next(); args.push(or()); } }
        expect(')'); return { t: 'call', fn: t.v.toLowerCase(), args };
      }
      if (t.v.toUpperCase() === 'PI') return { t: 'num', v: Math.PI };
      return { t: 'var', name: t.v };
    }
    throw new Error(`Unexpected token "${t.v}"`);
  }
  const e = or(); if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}" after end of expression`);
  return e;
}

export function variables(n: Node, out = new Set<string>()): Set<string> {
  switch (n.t) {
    case 'var': out.add(n.name); break;
    case 'un': variables(n.a, out); break;
    case 'bin': variables(n.a, out); variables(n.b, out); break;
    case 'call': n.args.forEach((a) => variables(a, out)); break;
    case 'between': variables(n.x, out); variables(n.lo, out); variables(n.hi, out); break;
  }
  return out;
}

type Fn = (i: number) => number;
function compile(n: Node, arrs: Record<string, ArrayLike<number>>): Fn {
  switch (n.t) {
    case 'num': { const v = n.v; return () => v; }
    case 'var': { const a = arrs[n.name]; if (!a) throw new Error(`Unknown curve "${n.name}"`); return (i) => a[i]; }
    case 'un': { const f = compile(n.a, arrs); return n.op === '-' ? (i) => -f(i) : (i) => { const v = f(i); return v !== v ? NaN : v ? 0 : 1; }; }
    case 'between': { const x = compile(n.x, arrs), lo = compile(n.lo, arrs), hi = compile(n.hi, arrs); return (i) => { const v = x(i); return v !== v ? NaN : v >= lo(i) && v <= hi(i) ? 1 : 0; }; }
    case 'call': { const fs = n.args.map((a) => compile(a, arrs)); const F = FUNCS[n.fn]; return (i) => F(...fs.map((f) => f(i))); }
    case 'bin': {
      const a = compile(n.a, arrs), b = compile(n.b, arrs);
      const nanGuard = (g: (x: number, y: number) => number): Fn => (i) => { const x = a(i), y = b(i); return x !== x || y !== y ? NaN : g(x, y); };
      switch (n.op) {
        case '+': return (i) => a(i) + b(i);
        case '-': return (i) => a(i) - b(i);
        case '*': return (i) => a(i) * b(i);
        case '/': return (i) => a(i) / b(i);
        case '^': return (i) => Math.pow(a(i), b(i));
        case '<': return nanGuard((x, y) => +(x < y));
        case '>': return nanGuard((x, y) => +(x > y));
        case '<=': return nanGuard((x, y) => +(x <= y));
        case '>=': return nanGuard((x, y) => +(x >= y));
        case '==': return nanGuard((x, y) => +(Math.abs(x - y) < 1e-9));
        case '!=': return nanGuard((x, y) => +(Math.abs(x - y) >= 1e-9));
        case '&&': return nanGuard((x, y) => +(!!x && !!y));
        case '||': return nanGuard((x, y) => +(!!x || !!y));
      }
    }
  }
  throw new Error('Invalid expression');
}

export interface EvalOptions { clip?: [number, number] | null }
/** Evaluate expression over n samples. Missing (NaN) inputs propagate to NaN outputs. */
export function evaluate(expr: string, arrs: Record<string, ArrayLike<number>>, n: number, opt: EvalOptions = {}): { out: Float32Array; nInvalid: number } {
  const ast = parse(expr);
  const f = compile(ast, arrs);
  const out = new Float32Array(n); let nInvalid = 0;
  const [lo, hi] = opt.clip ?? [-Infinity, Infinity];
  for (let i = 0; i < n; i++) {
    let v = f(i);
    if (v !== v || v === Infinity || v === -Infinity) { v = NaN; nInvalid++; }
    else if (v < lo) v = lo; else if (v > hi) v = hi;
    out[i] = v;
  }
  return { out, nInvalid };
}

export interface Preset {
  id: string; name: string; output: string; unit: string; expr: string; // expression template with {param}
  params: { key: string; label: string; def: number | string; hint?: string }[];
  inputs: string[]; // family names expected
  clip?: [number, number] | null; description: string;
}

export const PRESETS: Preset[] = [
  { id: 'vsh_lin', name: 'Vsh — linear GR index', output: 'VSH', unit: 'v/v', expr: '({GR} - {GRmin}) / ({GRmax} - {GRmin})', params: [{ key: 'GR', label: 'GR curve', def: 'GR' }, { key: 'GRmin', label: 'GR clean (sand)', def: 'P05' }, { key: 'GRmax', label: 'GR shale', def: 'P95' }], inputs: ['GR'], clip: [0, 1], description: 'IGR = (GR − GRclean)/(GRshale − GRclean), clipped 0–1.' },
  { id: 'vsh_lar_t', name: 'Vsh — Larionov (Tertiary)', output: 'VSH', unit: 'v/v', expr: '0.083 * (2 ^ (3.7 * clip(({GR} - {GRmin}) / ({GRmax} - {GRmin}), 0, 1)) - 1)', params: [{ key: 'GR', label: 'GR curve', def: 'GR' }, { key: 'GRmin', label: 'GR clean', def: 'P05' }, { key: 'GRmax', label: 'GR shale', def: 'P95' }], inputs: ['GR'], clip: [0, 1], description: 'Vsh = 0.083·(2^(3.7·IGR) − 1)' },
  { id: 'vsh_lar_o', name: 'Vsh — Larionov (older rocks)', output: 'VSH', unit: 'v/v', expr: '0.33 * (2 ^ (2 * clip(({GR} - {GRmin}) / ({GRmax} - {GRmin}), 0, 1)) - 1)', params: [{ key: 'GR', label: 'GR curve', def: 'GR' }, { key: 'GRmin', label: 'GR clean', def: 'P05' }, { key: 'GRmax', label: 'GR shale', def: 'P95' }], inputs: ['GR'], clip: [0, 1], description: 'Vsh = 0.33·(2^(2·IGR) − 1)' },
  { id: 'phid', name: 'PHID — density porosity', output: 'PHID', unit: 'v/v', expr: '({RHOma} - {RHOB}) / ({RHOma} - {RHOfl})', params: [{ key: 'RHOB', label: 'Bulk density', def: 'RHOB' }, { key: 'RHOma', label: 'Matrix density (g/cm³)', def: 2.65 }, { key: 'RHOfl', label: 'Fluid density (g/cm³)', def: 1.0 }], inputs: ['RHOB'], clip: [-0.15, 0.6], description: 'PHID = (ρma − ρb)/(ρma − ρfl)' },
  { id: 'phit_nd', name: 'PHIT — neutron-density average', output: 'PHIT', unit: 'v/v', expr: '({PHID} + {NPHI}) / 2', params: [{ key: 'PHID', label: 'Density porosity', def: 'PHID' }, { key: 'NPHI', label: 'Neutron porosity (v/v)', def: 'NPHI' }], inputs: ['PHID', 'NPHI'], clip: [0, 0.6], description: 'PHIT = (PHID + NPHI)/2' },
  { id: 'phit_rms', name: 'PHIT — neutron-density RMS (gas)', output: 'PHIT', unit: 'v/v', expr: 'sqrt(({PHID}^2 + {NPHI}^2) / 2)', params: [{ key: 'PHID', label: 'Density porosity', def: 'PHID' }, { key: 'NPHI', label: 'Neutron porosity (v/v)', def: 'NPHI' }], inputs: ['PHID', 'NPHI'], clip: [0, 0.6], description: 'PHIT = √((PHID² + NPHI²)/2)' },
  { id: 'phis', name: 'PHIS — Wyllie sonic porosity', output: 'PHIS', unit: 'v/v', expr: '({DT} - {DTma}) / ({DTfl} - {DTma})', params: [{ key: 'DT', label: 'DT curve (µs/ft)', def: 'DT' }, { key: 'DTma', label: 'DT matrix', def: 55.5 }, { key: 'DTfl', label: 'DT fluid', def: 189 }], inputs: ['DT'], clip: [0, 0.6], description: 'PHIS = (Δt − Δtma)/(Δtfl − Δtma)' },
  { id: 'phie', name: 'PHIE — shale-corrected', output: 'PHIE', unit: 'v/v', expr: '{PHIT} * (1 - {VSH})', params: [{ key: 'PHIT', label: 'Total porosity', def: 'PHIT' }, { key: 'VSH', label: 'Vsh', def: 'VSH' }], inputs: ['PHIT', 'VSH'], clip: [0, 0.6], description: 'PHIE = PHIT·(1 − Vsh)' },
  { id: 'sw_archie', name: 'Sw — Archie', output: 'SW', unit: 'v/v', expr: '(({a} * {Rw}) / ({PHIT} ^ {m} * {RT})) ^ (1 / {n})', params: [{ key: 'RT', label: 'Deep resistivity', def: 'RT' }, { key: 'PHIT', label: 'Porosity', def: 'PHIT' }, { key: 'Rw', label: 'Rw (ohm·m)', def: 0.05 }, { key: 'a', label: 'a', def: 1 }, { key: 'm', label: 'm', def: 2 }, { key: 'n', label: 'n', def: 2 }], inputs: ['RT', 'PHIT'], clip: [0, 1], description: 'Sw = (a·Rw / (φ^m·Rt))^(1/n)' },
  { id: 'rwa', name: 'Rwa — apparent water resistivity', output: 'RWA', unit: 'ohm.m', expr: '{RT} * {PHIT} ^ {m} / {a}', params: [{ key: 'RT', label: 'Deep resistivity', def: 'RT' }, { key: 'PHIT', label: 'Porosity', def: 'PHIT' }, { key: 'a', label: 'a', def: 1 }, { key: 'm', label: 'm', def: 2 }], inputs: ['RT', 'PHIT'], clip: null, description: 'Rwa = Rt·φ^m / a' },
  { id: 'k_fzi', name: 'K from FZI and porosity', output: 'K_FZI', unit: 'mD', expr: '{PHI} * ({FZI} * {PHI} / (1 - {PHI}) / {c}) ^ 2', params: [{ key: 'FZI', label: 'FZI (µm)', def: 'FZI_PRED' }, { key: 'PHI', label: 'Porosity (fraction)', def: 'PHIE' }, { key: 'c', label: 'RQI constant', def: 0.0314 }], inputs: ['FZI', 'PHI'], clip: [0, 1e6], description: 'K = φ·(FZI·φz / 0.0314)², φz = φ/(1−φ)' },
  { id: 'k_timur', name: 'K — Timur (Swirr)', output: 'K_TIMUR', unit: 'mD', expr: '0.136 * ({PHI} * 100) ^ 4.4 / ({SWI} * 100) ^ 2', params: [{ key: 'PHI', label: 'Porosity (fraction)', def: 'PHIE' }, { key: 'SWI', label: 'Irreducible Sw (fraction)', def: 'SW' }], inputs: ['PHI', 'SW'], clip: [0, 1e6], description: 'K = 0.136·φ%^4.4 / Swi%²' },
  { id: 'custom', name: 'Custom expression', output: 'NEW_CURVE', unit: '', expr: '', params: [], inputs: [], clip: null, description: 'Free-form expression on any curves.' },
];
