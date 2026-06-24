# csv

A tiny CSV helper. Add `parseLine(line)` — parse ONE record line into string fields.

Rules: comma-separated; a double-quoted field may contain commas and `""` for a literal quote (surrounding quotes
stripped); empty fields (including a trailing one) are preserved as `""`. Keep the CommonJS export. No dependencies.
