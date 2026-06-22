// GOLDEN overlay — index.js: the barrel. validate wraps the runner into the {ok, errors} shape (first error only),
// and re-exports the rule factories.
const { runRules } = require("./runner.js");
const { required, minLength, isEmail } = require("./rules.js");

function validate(input, rules) {
  const message = runRules(input, rules);
  return message === null ? { ok: true, errors: [] } : { ok: false, errors: [message] };
}

module.exports = { validate, required, minLength, isEmail };
