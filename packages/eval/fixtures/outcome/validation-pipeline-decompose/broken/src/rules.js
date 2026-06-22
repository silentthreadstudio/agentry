// BROKEN overlay — rules.js is correct here; the bug lives in the runner/barrel (no short-circuit), not the rules.
function required(field) {
  return (input) => {
    const v = input[field];
    if (v === undefined || v === null || v === "") return `${field} is required`;
    return null;
  };
}

function minLength(field, n) {
  return (input) => {
    const v = input[field];
    if (typeof v !== "string" || v.length < n) return `${field} must be at least ${n} characters`;
    return null;
  };
}

function isEmail(field) {
  return (input) => {
    const v = input[field];
    if (typeof v !== "string" || !/^[^@\s]+@[^@\s]+$/.test(v)) return `${field} must be a valid email`;
    return null;
  };
}

module.exports = { required, minLength, isEmail };
