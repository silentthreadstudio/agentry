// @agentry/core — the typed contract. Single source of truth for every structured shape Agentry
// reads or writes. Split by concern (SRP); this file is a pure re-export barrel.
//
// Consumers: @agentry/memory, the benchmark, the check-plugin gate, and (later) the workbench.
// Keep in lockstep with the design docs (.docs/internal).

export * from "./enums.js";
export * from "./memory.js";
export * from "./artifacts.js";
export * from "./events.js";
export * from "./config.js";
