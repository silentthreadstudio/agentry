# Debt

| Debt | What | Status | Verdict | Commit |
| :--- | :--- | :--- | :--- | :--- |
| DEBT-1 | Rename the config helper | todo | | |
| DEBT-2 | Drop the unused CSV path | todo | | |

# Contracts

### DEBT-1 · Rename the config helper
- **Owns:** `src/config.rs`, `src/main.rs`
- **Exposes:** `load_config()` in place of `cfg()`
- **Acceptance:** `cargo test` passes and `cfg(` appears nowhere

### DEBT-2 · Drop the unused CSV path
- **Owns:** `src/export/csv.rs`, `src/export/mod.rs`
- **Exposes:** nothing new; `export::csv` is gone
- **Acceptance:** `cargo test` passes and no code calls the CSV writer
