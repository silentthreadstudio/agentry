// GOLDEN overlay — assembler composing the two helpers into the public result.
const { pageCount } = require("./meta.js");
const { pageSlice } = require("./slice.js");

function paginate(items, perPage, page) {
  return {
    page,
    perPage,
    pageCount: pageCount(items.length, perPage),
    total: items.length,
    items: pageSlice(items, perPage, page),
  };
}

module.exports = { paginate };
