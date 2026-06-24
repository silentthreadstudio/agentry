# money

Money helpers, all in integer CENTS to avoid float drift. `formatCents(c)` renders cents as a dollar string.

Add `splitAmount(totalCents, n)` — split an integer cent amount into `n` shares that sum back EXACTLY to the total,
with leftover cents going to the earliest shares. Keep the CommonJS export. No dependencies.
