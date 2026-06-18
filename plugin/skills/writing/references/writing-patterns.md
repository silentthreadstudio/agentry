# Writing Patterns — depth

Reference for the `writing` skill: format templates, voice calibration, the plain-language swaps, and a before/after gallery. The principles in the skill (audience-first, point-first, scannable, filler-free) are constant; this file is how to apply them per format.

## Voice & tone, calibrated to the reader

Match register to who's reading and why:

- **End users** — warm, plain, jargon-free. Verbs they recognize. Never expose internals.
- **Developers / contributors** — precise, terse, assume competence but not context. Code and exact names over prose.
- **Operators / on-call** — imperative and unambiguous. State the action and the expected result; no ambiguity under pressure.
- **Decision-makers** — lead with impact and trade-off; details are optional depth, not the opener.

Default voice across all: **active, present-tense, second-person** ("Run `x`", "You get `y`"). It's shorter and clearer than passive/third-person.

## Format templates

### README

```
# <Name> — <one-line what + why>

<1–2 sentences: what problem it solves, for whom.>

## Quickstart
<the shortest path from zero to a working result — commands that actually run>

## Usage
<the common cases, each with a runnable example>

## Configuration / API
<reference detail, after the reader is already running>
```

The first screen is the whole pitch — a reader decides to continue or leave there. Put the runnable quickstart high.

### Release notes / changelog

```
## <version> — <date>

### Breaking
- <user-visible effect>. **Action:** <what they must do>.

### Added
- <capability>, stated as what the user can now do.

### Changed / Fixed
- <the effect on the user>, not the internal diff.
```

Rules: group by impact; lead each line with the **user-visible effect**, not the commit; make **Breaking** impossible to miss and always pair it with the required action.

### How-to / guide

```
# <Task, as a verb phrase: "Configure SSO">

<one line: what you'll have when done.>

## Before you start
<prerequisites, in a checklist>

## Steps
1. <action> — <copy-pasteable command/code>
2. ...

## Verify
<how to confirm it worked — an observable result>
```

Task-titled, numbered, copy-pasteable, and ends with a way to confirm success.

### API / reference doc

Per item: signature → one-line purpose → parameters (name · type · required? · meaning) → return → a minimal example → errors/edge cases. Consistency of shape across entries matters more than prose.

### User-facing copy & error messages

Three beats, in the reader's words: **what happened · why (if useful) · what to do next.**

- ❌ "Error: null reference exception in AuthHandler."
- ✅ "We couldn't sign you in. Check your email and password, then try again."

No stack traces, no internal identifiers, no blame.

## The plain-language swap list

Cut or replace on sight:

| Filler / inflated | Replace with |
| :--- | :--- |
| "in order to" | "to" |
| "simply" / "just" / "easily" | (delete — it's not simple if they're reading this) |
| "it should be noted that" / "please note" | (delete; just state it) |
| "very" / "really" / "quite" | (delete, or use a stronger word) |
| "utilize" | "use" |
| "in the event that" | "if" |
| "at this point in time" | "now" |
| "is able to" | "can" |
| "a number of" | "some" / the actual number |
| "due to the fact that" | "because" |

Passive → active: "the file is created by the script" → "the script creates the file."

## Before / after gallery

**Burying the lede**
- ❌ "There are many factors to consider when configuring the cache, and depending on your setup, you may want to adjust several of them. One of the most important is the TTL."
- ✅ "Set the cache TTL first — it has the biggest effect. \<then the rest\>"

**Wall of text → scannable**
- ❌ One 9-line paragraph describing install, then config, then run.
- ✅ Three headed sections (Install / Configure / Run), each 2 lines, with the commands as code blocks.

**Audience blindness**
- ❌ (in a user help doc) "The mutation resolver rejects unauthenticated requests."
- ✅ "If you're signed out, saving won't work — sign in and try again."

**Filler-dense → tight**
- ❌ "In order to be able to start the server, you will simply need to just run the following command."
- ✅ "Start the server: `npm start`."

The edit is always the same move: find the reader's takeaway, put it first, and delete everything that isn't on their path.
