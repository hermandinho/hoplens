// Exceptions: a callee that throws synchronously (no counter follows the call), an awaited
// rejection (V8 counts the statement after the await: exact), and a callee error caught here.
function boom(x) {
  if (x) throw new Error("boom");
  return 1;
}

function caller(x) {
  let a = 1;
  boom(x);
  a = 2;
  a += 3;
  return a;
}

function branchAfter(x, y) {
  let a = 0;
  boom(x);
  if (y) {
    a = 1;
  }
  return a;
}

function catches(x) {
  let a = 0;
  try {
    boom(x);
    a = 1;
    if (a) a = 2;
  } catch {
    a = -1;
  }
  return a;
}

async function awaited(fail) {
  let n = 0;
  try {
    await (fail ? Promise.reject(new Error("no")) : Promise.resolve(1));
    n += 10;
  } catch (err) {
    n += 100;
  }
  return n;
}

// A traced callee that rejects: its hop records the error, whose stack names the await below.
const recorded = [];
async function load(fail) {
  await null;
  if (fail) {
    const err = new Error("not found");
    recorded.push(err.stack);
    throw err;
  }
  return 1;
}

async function viaCallee(fail) {
  let n = 0;
  try {
    n += await load(fail);
    n += 10;
  } catch (err) {
    n += 100;
  }
  return n;
}

// The first statement of an arm is exactly the arm's count, even with a throw later in the arm.
function anchored(x, y) {
  let a = 0;
  if (y) {
    a = 1;
    boom(x);
    a = 2;
  }
  return a;
}

// One untraced throw (no stack recorded anywhere) and one traced throw in the same try: the
// recorded line must not narrow the region past the unrecorded one.
function bare(x) {
  if (x) throw new Error("bare");
}
function traced(x) {
  if (x) {
    const err = new Error("traced");
    recorded.push(err.stack);
    throw err;
  }
}
function twoThrows(xs) {
  let a = 0;
  for (const x of xs) {
    try {
      bare(x === 1);
      if (x === 2) a++;
      traced(x === 2);
    } catch {
      a--;
    }
  }
  return a;
}

// A finally that throws replaces the exception pending from its try block. The rejection is
// counted (the statement after the await reads 0) but never reaches the hop; the finally's own
// throw does, and nothing counts what it skipped.
async function rej(x) {
  if (x) throw new Error("rej");
}
async function replaced(x) {
  let a = 0;
  try {
    await rej(x);
    a = 1;
  } finally {
    boom(x);
    if (a > 5) a = 1;
  }
  return a;
}

// ...and the reverse: an exception raised in a catch body (nobody records it) vanishes in a
// finally whose own throw is counted, recorded, and caught further out. Nothing counts what the
// catch body skipped.
function replacedInCatch(x) {
  let a = 0;
  try {
    try {
      bare(x);
    } catch {
      bare(x);
      if (a > 5) a = 1;
    } finally {
      if (x) traced(x);
      a += 1;
    }
  } catch {
    a = -1;
  }
  return a;
}

module.exports = {
  boom,
  caller,
  branchAfter,
  catches,
  awaited,
  viaCallee,
  recorded,
  anchored,
  twoThrows,
  replaced,
  replacedInCatch,
};
