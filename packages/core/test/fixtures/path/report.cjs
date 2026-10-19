// The example app's GET /api/report loop shape: 16 copies of every row.
function report(rows) {
  const lines = [];
  for (let copy = 0; copy < 16; copy++) {
    for (const r of rows) {
      lines.push({ ...r, batch: copy, totalCents: r.qty * r.price_cents });
    }
  }
  return { count: lines.length, lines };
}

module.exports = { report };
