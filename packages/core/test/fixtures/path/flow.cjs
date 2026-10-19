// Switch fall-through, labeled break, ternary / && / ??, try/catch/finally.
function grade(n) {
  let out = "";
  switch (n) {
    case 0:
      out += "zero";
    case 1:
      out += "small";
      break;
    case 5:
    case 6:
      out = "mid";
      break;
    default:
      out = "big";
  }
  return out;
}

function find(grid, want) {
  let seen = 0;
  outer: for (const row of grid) {
    for (const cell of row) {
      seen++;
      if (cell === want) break outer;
    }
  }
  return seen;
}

function pick(user, log) {
  const tier = user.vip ? "gold" : "basic";
  const note = user.name && log.push(user.name);
  return tier + (note ? "!" : "") + (user.nick ?? "");
}

function guarded(fn) {
  let state = "start";
  try {
    state = fn();
  } catch (err) {
    state = "caught";
  } finally {
    state += ".";
  }
  return state;
}

// `??` as the value a function returns: a decision (it picks what the caller gets).
function first(rows) {
  return rows[0] ?? null;
}

module.exports = { grade, find, pick, guarded, first };
