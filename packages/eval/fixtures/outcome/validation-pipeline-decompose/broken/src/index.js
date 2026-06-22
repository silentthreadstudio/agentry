// BROKEN overlay — index.js: wraps the aggregate runner. Because runRules returns an ARRAY of all failures,
// validate reports {ok:false, errors: [...all messages]} — so on multiple failures it returns every error in
// order rather than ONLY the first, and the short-circuit (later rules must not run) is violated. The all-pass
// happy path still produces {ok:true, errors:[]}.
const { runRules } = require("./runner.js");
const { required, minLength, isEmail } = require("./rules.js");

function validate(input, rules) {
  const messages = runRules(input, rules);
  return messages.length === 0 ? { ok: true, errors: [] } : { ok: false, errors: messages };
}

module.exports = { validate, required, minLength, isEmail };
