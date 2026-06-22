# dedupe-refactor (extract one shared money formatter)

Three CommonJS modules each carry their OWN copy-pasted `formatMoney(cents)` helper, and the copies have DRIFTED
— so the same amount renders differently across modules. Refactor to a single shared helper.

## The canonical format

`formatMoney(cents)` takes an integer number of cents and returns a US dollar string with a leading `$`, comma
thousands separators, and exactly two decimal places:

- `123456` -> `"$1,234.56"`
- `5` -> `"$0.05"`
- `0` -> `"$0.00"`
- `100000000` -> `"$1,000,000.00"`

## The task

- Create `src/format-money.js` exporting the ONE canonical `formatMoney(cents)`.
- Rewire `src/invoice.js` (`renderInvoice`), `src/receipt.js` (`renderReceipt`), and `src/report.js`
  (`renderReport`) to use that shared helper — remove every local copy.
- Each module keeps its public function and CommonJS export; the rendered money must be canonical in ALL three.

Each `render*` function takes an amount in cents and returns a short string embedding the formatted money (see the
seed for the exact wrapper text each module uses — keep that wrapper, only the money formatting changes).

No dependencies; keep the CommonJS exports.
