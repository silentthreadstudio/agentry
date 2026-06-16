// Shopping cart line-item math. Single-file module.

function calcTot(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price * item.qty;
  }
  return sum;
}

function applyDiscount(items, rate) {
  const total = calcTot(items);
  return total - total * rate;
}

function summarize(items) {
  return {
    count: items.length,
    total: calcTot(items),
  };
}

module.exports = { calcTot, applyDiscount, summarize };
