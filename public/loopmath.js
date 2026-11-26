// Formula engine for the Gameplay Loop tab: the loop models Claude writes are small formulas over
// the loop's parameters (and x, the chart's axis), compiled here without eval. The same file runs in
// the browser (live charts as sliders move) and on the server (formulas are checked before they're
// kept). No imports or exports, so it loads as a plain script and as a module.
(function () {
  const FN = {
    if: (c, a, b) => (c ? a : b), min: Math.min, max: Math.max, clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2, pow: Math.pow,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, sin: Math.sin, cos: Math.cos, tanh: Math.tanh,
    sigmoid: (z) => 1 / (1 + Math.exp(-z)), lerp: (a, b, t) => a + (b - a) * t,
    smoothstep: (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a || 1))); return t * t * (3 - 2 * t); },
  };
  const CONST = { pi: Math.PI, e: Math.E };
  const TOKEN = /\s*(?:((?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/^%(),<>?:!]))/y;

  function tokenize(src) {
    const out = [];
    TOKEN.lastIndex = 0;
    const s = String(src);
    while (TOKEN.lastIndex < s.length) {
      if (/^\s*$/.test(s.slice(TOKEN.lastIndex))) break;
      const at = TOKEN.lastIndex;
      const m = TOKEN.exec(s);
      if (!m) throw new Error(`Can't read "${s.slice(at, at + 12)}"`);
      out.push(m[1] ? { t: 'num', v: Number(m[1]) } : m[2] ? { t: 'id', v: m[2] } : { t: 'op', v: m[3] });
    }
    return out;
  }

  // Recursive descent to closures: ternary < || < && < comparison < + - < * / % < unary < ^ < call.
  function compile(src, names) {
    const tk = tokenize(src);
    let i = 0;
    const used = new Set();
    const peek = (v) => tk[i] && tk[i].t === 'op' && tk[i].v === v;
    const eat = (v) => { if (!peek(v)) throw new Error(`Expected "${v}"`); i++; };
    function ternary() {
      const c = or();
      if (!peek('?')) return c;
      i++;
      const a = ternary(); eat(':'); const b = ternary();
      return (x) => (c(x) ? a(x) : b(x));
    }
    function or() { let l = and(); while (peek('||')) { i++; const a = l; const r = and(); l = (x) => (a(x) || r(x) ? 1 : 0); } return l; }
    function and() { let l = cmp(); while (peek('&&')) { i++; const a = l; const r = cmp(); l = (x) => (a(x) && r(x) ? 1 : 0); } return l; }
    function cmp() {
      let l = add();
      for (;;) {
        const op = ['<', '>', '<=', '>=', '==', '!='].find((o) => peek(o));
        if (!op) return l;
        i++;
        const a = l; const r = add();
        l = { '<': (x) => +(a(x) < r(x)), '>': (x) => +(a(x) > r(x)), '<=': (x) => +(a(x) <= r(x)), '>=': (x) => +(a(x) >= r(x)), '==': (x) => +(a(x) === r(x)), '!=': (x) => +(a(x) !== r(x)) }[op];
      }
    }
    function add() {
      let l = mul();
      while (peek('+') || peek('-')) { const op = tk[i++].v; const a = l; const r = mul(); l = op === '+' ? (x) => a(x) + r(x) : (x) => a(x) - r(x); }
      return l;
    }
    function mul() {
      let l = unary();
      while (peek('*') || peek('/') || peek('%')) { const op = tk[i++].v; const a = l; const r = unary(); l = op === '*' ? (x) => a(x) * r(x) : op === '/' ? (x) => a(x) / r(x) : (x) => a(x) % r(x); }
      return l;
    }
    function unary() {
      if (peek('-')) { i++; const a = unary(); return (x) => -a(x); }
      if (peek('+')) { i++; return unary(); }
      if (peek('!')) { i++; const a = unary(); return (x) => +!a(x); }
      return pow();
    }
    function pow() {
      const b = call();
      if (!peek('^')) return b;
      i++;
      const e = unary(); // right-associative, and 2^-x works
      return (x) => Math.pow(b(x), e(x));
    }
    function call() {
      const t = tk[i++];
      if (!t) throw new Error('The formula ends too early');
      if (t.t === 'num') return () => t.v;
      if (t.t === 'op' && t.v === '(') { const e = ternary(); eat(')'); return e; }
      if (t.t !== 'id') throw new Error(`Unexpected "${t.v}"`);
      if (peek('(')) {
        const f = FN[t.v];
        if (!f) throw new Error(`Unknown function ${t.v}()`);
        i++;
        const args = [];
        if (!peek(')')) { args.push(ternary()); while (peek(',')) { i++; args.push(ternary()); } }
        eat(')');
        return (x) => f(...args.map((a) => a(x)));
      }
      if (t.v in CONST) return () => CONST[t.v];
      if (names && !names.includes(t.v)) throw new Error(`Unknown name "${t.v}"`);
      used.add(t.v);
      const k = t.v;
      return (x) => { const v = x[k]; return typeof v === 'number' ? v : NaN; };
    }
    const fn = ternary();
    if (i < tk.length) throw new Error(`Unexpected "${tk[i].v}"`);
    fn.uses = [...used];
    return fn;
  }

  const cache = new Map();
  function cached(src) {
    let f = cache.get(src);
    if (!f) {
      try { f = compile(src); } catch (err) { f = Object.assign(() => NaN, { error: err.message, uses: [] }); }
      if (cache.size > 2000) cache.clear();
      cache.set(src, f);
    }
    return f;
  }

  // A loop's values as the formulas see them: every parameter by key, at its draft or its base value.
  function scope(params, which) {
    const v = {};
    for (const p of params || []) v[p.key] = Number(which === 'base' ? p.base : p.value);
    return v;
  }

  // Points of one series over the chart's x range.
  function sample(expr, vars, x0, x1, n = 120) {
    const f = cached(expr);
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const x = x0 + ((x1 - x0) * k) / n;
      const y = f({ ...vars, x });
      pts.push([x, Number.isFinite(y) ? y : null]);
    }
    return pts;
  }

  const value = (expr, vars) => { const y = cached(expr)(vars); return Number.isFinite(y) ? y : null; };

  globalThis.LoopMath = { compile, sample, value, scope, FN: Object.keys(FN), CONST: Object.keys(CONST) };
})();
