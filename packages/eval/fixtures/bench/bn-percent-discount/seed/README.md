# pricing

A pricing helper. Add `priceCents(unitCents, qty)` — total in integer cents for `qty` units, with a tiered bulk
discount: ≥100 → 20% off, ≥50 → 10% off, ≥10 → 5% off, else none. Discount applies to the whole subtotal; round the
final total to the nearest cent (half up). Keep the CommonJS export. No dependencies.
