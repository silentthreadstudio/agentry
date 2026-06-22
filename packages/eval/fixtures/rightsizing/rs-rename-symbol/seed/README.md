# billing

A small CommonJS billing module across three files:
- `src/format.js` — exports `fmt(n)`, a currency formatter.
- `src/invoice.js` — exports `invoiceLine(label, n)`, uses `fmt`.
- `src/receipt.js` — exports `receiptTotal(n)`, uses `fmt`.

Rename `fmt` to `formatCurrency` everywhere (export + both call sites), keeping behavior identical. No dependencies.
