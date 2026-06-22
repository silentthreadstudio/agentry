// The library barrel — re-exports the public API (pageCount, pageInfo). This wiring is correct; the planted bug
// lives in meta.js's page-count math.
const { pageCount } = require("./meta.js");
const { pageInfo } = require("./paginate.js");

module.exports = { pageCount, pageInfo };
