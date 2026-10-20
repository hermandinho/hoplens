// Probe ux/branchy.ts as plain CommonJS: a route-ish handler with every structured branch shape.
async function checkout(order, user) {
  if (!user) {
    return { ok: false, reason: "anon" };
  }
  let total = 0;
  for (const item of order.items) {
    if (item.qty <= 0) continue;
    total += item.qty * 10;
  }
  const discount = user.vip ? 0.2 : 0;
  const label = order.coupon && order.coupon.toUpperCase();
  switch (order.status) {
    case "new":
      total = total * (1 - discount);
      break;
    case "paid":
      return { ok: false, reason: "already paid" };
    default:
      throw new Error("bad status");
  }
  try {
    await save(order.id, total, label);
  } catch (err) {
    return { ok: false, reason: String(err) };
  } finally {
    total = Math.round(total);
  }
  return { ok: true, total };
}

async function save(id, total, label) {
  if (total > 1000) throw new Error("too big");
  void id;
  void label;
}

module.exports = { checkout, save };
