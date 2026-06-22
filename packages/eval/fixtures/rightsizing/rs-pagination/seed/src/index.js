// Assembler component. STUB — compose `pageCount` + `pageSlice` into the public `paginate` result. See README.
const { pageCount } = require("./meta.js");
const { pageSlice } = require("./slice.js");

function paginate(items, perPage, page) {
  throw new Error("not implemented");
}

module.exports = { paginate };
