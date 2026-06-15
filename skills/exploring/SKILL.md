---
name: exploring
description: This skill should be used when comprehending an existing codebase read-only — orienting in an unfamiliar repo, locating where a feature or symbol lives, tracing how data or control flows end to end, inferring the conventions in force, or producing a Context map of how the repo is built. Loaded for understanding-existing-code tasks, not for editing, designing, or investigating external/unknown information.
version: 0.1.0
---

# Exploring

Comprehend an existing codebase **fast, accurately, and read-only** — then return a **distilled map**, not a dump of files. The output is coordinates and structure (where things live, how they connect, what conventions hold), so the next specialist can act without re-reading the world. The craft is knowing what *not* to read: map to the depth the ask needs and stop at its boundary.

## The two rules that govern every exploration

1. **Distill, don't dump.** A map is structure + location + the load-bearing why — paths and symbols as coordinates, short excerpts only where the exact text matters. If the answer is mostly pasted file contents, the job has failed.
2. **Scoped, not exhaustive.** Match depth to the ask: a whole-repo survey goes breadth-first; a targeted trace follows one path deep. Never chase every dependency, generated file, or vendored library — rabbit-holing is the signature failure. **The symmetric failure is just as real:** under-reading — stopping *before* the load-bearing logic — ships a confident WRONG map that misleads every downstream specialist, and that costs more than over-reading because it's invisible. The **depth floor is the ask's named site**: you are not done until you've traced *to it*. Scope is a ceiling on breadth, never an excuse to stop short of the thing you were asked to find.

## Method

Work in this order; stop early when the ask is answered.

1. **Frame the ask.** State what comprehension is needed and at what depth — a broad **Context map** (orient in the whole repo) or a **targeted trace** ("where/how does X work"). Depth follows the ask.
2. **Profile the environment.** Language(s), package manager, framework, build/test/run commands, and which code-intel tools are available. This is repo-fact the whole team needs, and it tells you how to read the rest.
3. **Find entry points + top-level shape.** The mains/handlers/exports that start execution, and how the tree is organized into major parts. Entry points are the threads you pull to understand flow.
4. **Map responsibilities + dependencies.** For each part that matters, name its single responsibility and what it imports / what imports it. The dependency direction *is* the architecture.
5. **Trace the relevant flow.** Follow control/data from the entry point through the seams to the place that matters — and stop at the boundary of the ask. Prefer a semantic code-intel tool's call hierarchy / find-references over manual text chasing.
6. **Infer conventions.** Naming, layering, error handling, test layout, config patterns — the rules already in force, so downstream work stays repo-consistent.
7. **Distill.** Collapse what you read into the map below: coordinates + structure + the few load-bearing facts.

## Navigating fast (capability-first)

Name the *job*, prefer the sharp tool if present, fall back gracefully — never assume a fixed toolset:

- **Find a definition / all references / call hierarchy** → prefer a semantic code-intel MCP (Serena / LSP) if present (precise, type-aware, fast) → fallback: grep / glob / read.
- **Locate where-things-live by name/pattern** → glob for files, grep for symbols; let the matches point you, then read only the few that matter.
- **Understand the stack/run** → read the manifest (package.json / pyproject / go.mod / Cargo.toml…), lockfile, and CI/scripts — they state the package manager, deps, and commands without guessing.

Reading order that scales: **manifest → entry points → the few files the ask points at.** Skim signatures and structure before bodies; read a body only when its logic is load-bearing.

## Staying scoped (avoid the rabbit hole)

- **Survey wide, dive narrow.** Big repo → breadth-first (structure + entry points + conventions), deep only where the ask points.
- **Skip the noise.** Generated code, vendored deps, build output, and lockfile internals are rarely the answer — note they exist, don't read them through.
- **But noise on the load-bearing path is not noise.** When the flow you were asked to trace runs *through* generated, vendored, or dynamically-dispatched code, that is **not** skippable — read it. If it can't be resolved statically (runtime dispatch, codegen, reflection), **flag the trace as UNRESOLVED / low-confidence** and say where it goes opaque; never guess the path and present it as fact.
- **Stop at the boundary.** When the ask is "where does auth validate," you're done at the validation site — not three libraries down its dependencies.
- **Codebase-only.** External, current, or unknown information (third-party API behavior, what a version changed, best practices) is **not exploration** — flag it for the researcher. The explorer comprehends *this repo*.

## Memory (don't re-explore what's known)

You are primed with what memory already knows about this repo. **Recall before reading.** If a Context map already exists, verify it still holds and report only the delta — do not re-map from scratch. Record the environment/tools you observe as repo-facts, and report every memory that shaped the map in `used_memories`.

## Anti-patterns (refuse these)

- **Editing anything** — exploration is read-only; a needed change is *reported*, never made.
- **Dumping** — pasting file contents in place of a distilled map.
- **Rabbit-holing** — chasing dependencies/generated/vendored code past the depth the ask needs.
- **Under-reading** — stopping before the ask's named site and shipping a confident wrong map; the symmetric twin of rabbit-holing. Not done until you've traced *to* the thing asked for.
- **Re-exploring** — re-deriving a map memory already holds instead of recalling + updating the delta.
- **Answering external/unknown questions** — guessing at what belongs to the researcher.

## Output

A **Context map** — *Stack/environment · Structure & where-things-live · Key flows · Conventions · Entry points* (doc-01 format) — or, for a narrow ask, a **targeted trace**: the path through the code and the load-bearing location. Plus the **available capabilities** observed (tools, package manager, run commands), `used_memories`, and any external/out-of-scope items flagged for the researcher.

## Additional resources

### Reference files
- **`references/comprehension-techniques.md`** — entry-point discovery, dependency/data-flow tracing, convention inference, the per-language stack-profiling cheat-sheet, and the Context-map template with a worked distill (dump → map).
