---
name: writing
description: This skill should be used when producing clear technical or product prose for a reader — documentation, READMEs, release notes, changelogs, user-facing copy, error messages, API docs, or guides. Loaded whenever the deliverable is words meant to be read and acted on, and the goal is plain, structured, audience-first writing that leads with the point. Not for writing code or shaping requirements.
version: 0.1.0
---

# Writing

Write prose a reader can act on: **plain, structured, audience-first, point-first.** Good technical writing is not decorated — it is *clear*. The reader has a goal; your job is to get them there with the least friction. Every sentence earns its place or is cut.

## The four rules that govern every piece

1. **Audience-first.** Decide who reads this and what they already know *before* writing a word. A README for users, a guide for new contributors, and release notes for an upgrading team are three different documents — never one. Write for their context, not your own.
2. **Lead with the point.** Put the conclusion, the action, or the answer **first** — then support it. Don't bury the verb under a paragraph of throat-clearing. The reader should get the takeaway from the first line and the details only if they want them (BLUF — bottom line up front).
3. **Structure for scanning.** Readers scan before they read. Use descriptive headings, short paragraphs, and lists for parallel items. A reader should find their answer from the headings alone. (Micro-copy — an error message, a commit subject, a tooltip — scales this down: it *is* the bottom line, so it gets no headings; lead with what happened and what to do, in one line.)
4. **Cut filler — but clarity is the floor, brevity serves it (not the reverse).** Delete words that carry no information ("simply", "just", "in order to", "it should be noted that", "very"). Prefer the short word, the active voice, the concrete noun. If a sentence still means the same thing with a clause removed, remove it. **The symmetric failure is just as real:** cutting a prerequisite, an edge case, or the "why" leaves the reader unable to act — terse but unusable is a failure, not an achievement. Cut words, never the information the reader needs to act. A clause is filler only if removing it costs the reader nothing.

## Method

1. **Name the reader and their job.** One line: "this is for \<who\>, who wants to \<do what\>." Everything else serves that.
2. **State the point first.** Draft the single most important sentence — the thing the reader most needs — and lead with it.
3. **Outline by what the reader needs, in their order** (not the order you built it). For a how-to: what it does → prerequisites → steps → verify. For release notes: what changed for *them* → action required → details.
4. **Draft plainly.** Active voice, present tense, concrete subjects. One idea per paragraph. Show, with an example, rather than only telling.
5. **Cut.** Read it back as the reader. Remove filler, redundancy, and anything off their path. Shorter is almost always better.

## Per-format guidance (essentials)

- **README** — what it is + why (one line), quickstart that actually runs, then usage. The first screen decides whether they keep reading.
- **Release notes / changelog** — group by impact (Added / Changed / Fixed / **Breaking**); lead each entry with the user-visible effect, not the internal change; call out required actions loudly.
- **How-to / guide** — task-titled ("Configure X"), numbered steps, copy-pasteable commands, a way to confirm success at the end.
- **User-facing copy / error messages** — say what happened and what to do next, in the reader's words; no stack traces or jargon in the user's face.

Full templates, voice/tone calibration, and a before/after edit gallery are in `references/writing-patterns.md`.

## Output

Finished prose, fit for its audience and format, that leads with the point and contains no filler. When the piece states facts about the product or its behavior, ground them in the Spec / code — don't invent capabilities. **When a fact the prose needs isn't in the Spec or the code, mark it `TODO` and flag it for the conductor — never write a confident sentence over an unverified behavior.** A plausible-sounding invented capability is worse than a visible gap: the reader acts on it.

## Anti-patterns (refuse these)

- **Burying the lede** — the point arrives in paragraph three. Move it to line one.
- **Wall of text** — no headings, no lists, no paragraph breaks. Structure it for scanning.
- **Filler and hedging** — "simply", "just", "very", "in order to", passive throat-clearing. Cut them.
- **Under-explaining** — omitting a prerequisite, an edge case, or the "why", so the reader can't act. The symmetric trap to over-writing: brevity that strips out what the reader needs is terse but unusable. Clarity is the floor; cut words, not the information.
- **Audience blindness** — explaining to experts what they know, or to novices in terms they don't. Calibrate.
- **Decorative writing** — clever or padded prose that costs the reader time. Clarity over flourish, always.

## Additional resources

### Reference files
- **`references/writing-patterns.md`** — format templates (README / release notes / how-to / API doc / error copy), voice & tone calibration per audience, the plain-language word-swap list, and a before/after gallery of tightened prose.
