// BROKEN overlay — the assembler is wired correctly; it inherits the wrong pageCount from the broken meta.js.
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
