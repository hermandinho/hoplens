// P2 review fixes: shapes the truth model got wrong (each pinned in path-truth.test.ts).
const G = (globalThis.__edgesG ??= {});
function T(k) { G[k] = (G[k] || 0) + 1; return k; }
function boom() { throw new Error("boom"); }
function risky(x) { if (x) boom(); return 1; }

// Optional chains and destructuring defaults: code that may be skipped.
function optc(o, c) {
  T("o0");
  o?.f(c ? T("ot") : T("of"));
  T("o1");
  o?.f(c && T("oand"));
  T("o2");
}

function destr(obj, c) {
  T("d0");
  const { a = c ? T("dt") : T("df") } = obj;
  T("d1");
  const { b = c && T("dand") } = obj;
  T("d2");
  return a;
}

function optif(o, c) {
  T("oi0");
  if (o?.f(c ? 1 : 2)) {
    T("oithen");
  }
  T("oi1");
}

function arrDestr(arr, c) {
  T("ar0");
  const [x = c ? T("art") : T("arf")] = arr;
  T("ar1");
  return x;
}

function assignDestr(o, c) {
  let a;
  T("ad0");
  ({ a = c && T("adand") } = o);
  T("ad1");
  return a;
}

function forofdef(xs, c) {
  T("fo0");
  for (const { a = c ? 1 : 2 } of xs) {
    T("fobody");
  }
  T("fo1");
}

// Logical assignment: V8 keeps no counter for the right side.
function logassign(x, y, z) {
  T("la0");
  x ||= T("laor");
  y &&= T("laand");
  z ??= T("lanull");
  T("la1");
  return x;
}

// What runs between the function's counter and its body.
function dparam(a = boom()) {
  T("dp0");
  if (a) {
    T("dpthen");
  }
  T("dp1");
}

function* gen(x) {
  T("g0");
  if (x) {
    T("gthen");
  }
  yield 1;
  T("g1");
}

async function hang(x) {
  T("h0");
  await new Promise(() => {});
  T("h1");
}

// Exits: a return whose value threw did not complete; a caught throw is no exit.
function retboom() {
  return boom();
}

function retcatch() {
  try {
    return boom();
  } catch {
    return T("rccatch");
  }
}

function caughtThrow(x) {
  T("ct0");
  try {
    if (x) throw new Error("t");
    T("ct1");
  } catch (e) {
    T("ctc");
  }
  return 1;
}

// A caught callee error, then an uncaught one.
function uc(mode) {
  T("u0");
  try {
    risky(mode === "a");
  } catch (e) {
    T("ucatch");
  }
  risky(mode === "c");
  T("u1");
}

function swc(v) {
  switch (v) {
    case 1: {
      T("s1");
      break;
    }
    case 2:
    case 3:
      T("s23");
      if (v === 2) return 2;
      else break;
    default:
      T("sd");
  }
  return 0;
}

function loopTry(n, x) {
  try {
    T("lt0");
    for (let i = 0; i < n; i++) {
      T("lt");
    }
    risky(x);
  } catch (e) {
    T("ltc");
  }
}

// Graph links: a callback created at a statement, and a call the trace recorded as a hop.
function helper(x) {
  return x + 1;
}

function cbHost(xs) {
  const out = xs.map(function each(x) { return helper(x); });
  helper(0);
  return out;
}

// A return whose own value threw before its ternary's arms; a logical assignment after an early
// return (V8's range there still reads the call count).
function retTernBoom(c) {
  return boom() ? c : 2;
}

function laAfterReturn(u, x) {
  if (!u) return 0;
  x ||= T("lar");
  T("la2");
  return x;
}

// A return the finally replaced, though it sits right after its arm's counter.
function finRet(c, d) {
  try {
    if (c) {
      return T("fr1");
    }
    T("fr0");
  } finally {
    if (d) return 2;
  }
  return 3;
}

module.exports = { finRet, retTernBoom, laAfterReturn, helper, cbHost, G, boom, optc, destr, optif, arrDestr, assignDestr, forofdef, logassign, dparam, gen, hang, retboom, retcatch, caughtThrow, uc, swc, loopTry };
