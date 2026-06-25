// GOLDEN overlay — event constructors with validation: amount must be a positive integer (cents); transfer's two
// accounts must differ. seed+golden PASSES the oracle.
function assertAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error("amount must be a positive integer (cents)");
  }
}

function deposit(account, amount) {
  assertAmount(amount);
  return { type: "deposit", account, amount };
}

function withdraw(account, amount) {
  assertAmount(amount);
  return { type: "withdraw", account, amount };
}

function transfer(from, to, amount) {
  assertAmount(amount);
  if (from === to) throw new Error("transfer accounts must differ");
  return { type: "transfer", from, to, amount };
}

module.exports = { deposit, withdraw, transfer };
