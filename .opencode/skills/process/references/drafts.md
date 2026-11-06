# Drafts: owner calls caught in conversation

An owner's decision often arrives in prose: a proposal rejected or changed, a rule stated, an answer typed into a
question's "Other" field. A **draft** holds that call until the owner says OK. Nothing in a draft is final, and no
board or prompt file changes until `agentry board draft apply <n> --apply`.

Drafts live in
`.agentry/run/process/drafts.jsonl` under the main checkout: local, never committed.

## Kinds

| Kind | What it is | `apply` does |
| :--- | :--- | :--- |
| `decision` | A call the owner made between options. | Takes the next free id (`next-id`) and writes the decision through `add`, filling the kind's fields from the workflow file's `drafts.decision.map` (or, with none, from the decision kind's own fields). |
| `rule` | A standing rule: "from now on…", "I want…", "should…". | Appends it as a bullet under the `conductor.rules` heading of the conductor prompt (`conductor.prompt`). |

A draft is `{ n, kind, answer, why?, question?, unpicked?, source?, at, state }`. `answer` is the call in the owner's
words, `why` the reason for it, `question` what it answered, `unpicked` the options not taken, `source` where it was said. `n` is never
reused: a dropped or applied draft keeps its number.

## When to draft (cues)

Run `agentry board draft add` and say one line ("drafted 3: decision, keep the board in markdown") when the owner:

- rejects or changes a proposal ("not that, rather this");
- states a rule ("from now on…", "I want…", "should…");
- answers a question with "Other" and a sentence.

Do not draft a plain yes, a clarification or a preference for this one task.

```sh
agentry board draft add --fields '{"kind":"decision","answer":"Keep the board in markdown","question":"Where does the board live?","unpicked":["a database"],"source":"session"}'
agentry board draft add --fields '{"kind":"rule","answer":"Recall before any change outside a command."}'
agentry board draft list
agentry board draft drop 3
agentry board draft apply 3            # shows what it would write; writes nothing
agentry board draft apply 3 --apply    # writes it, after the owner's OK
```

The JSON is one single-quoted argument, `'` written `'\''`. Unknown keys, an unknown kind or an empty answer exit 2
and store nothing.

## When to show them

1. **In the moment**: the line above, nothing more.
2. **At `/agentry/close`**: re-read the session for owner calls that were not drafted, add them, then show every
   pending draft (`agentry board draft list`) and ask the owner to OK, drop or correct each one (a correction is a drop plus
   a new draft).
3. **At `/agentry/new decision`**: pending drafts are shown first.

`agentry board status` shows the pending count on its **Drafts** row; a night session leaves them for the morning.

## Applying

Run `agentry board draft apply <n>` to show the owner exactly what it would write (it writes nothing). Only after
the owner's OK for that draft, run `agentry board draft apply <n> --apply` and show its output.

- **decision**: `drafts.decision` (`kind`, `map`) in the workflow file says where it goes. Its `map` fills the kind's
  fields from `{answer}`, `{why}`, `{question}` and `{unpicked}`; any other placeholder exits 2. `{why}` is the
  draft's `why`, or its `question` when it has none; `{unpicked}` is the options not taken, joined with commas.
  Without `drafts.decision`, `apply` derives the map: the kind named `decision` with no status (else the only kind
  with a `decision` field) gets `decision` from `{answer}`, `why` from `{why}` and `rejected` from `{unpicked}`, for
  the fields it has, and the output says so; with no such kind it exits 2 and writes nothing. Set `drafts.decision`
  in the workflow file to change the map. The kind's `create.id` must be a pattern
  `next-id` can follow. Then `agentry board check` and report the delta, as `/agentry/new` does.
- **rule**: needs `conductor.prompt` and `conductor.rules` in the workflow file, and that heading in the prompt. Without
  them `apply` exits 2 and writes nothing; tell the owner to add the heading or run `/agentry/init`.

The owner may correct a draft at apply: `agentry board draft apply <n> --answer "…" [--why "…"]` previews the
edited text, and with `--apply` writes it and keeps it on the draft's line, with the text it replaced under
`edited`. `--why` goes with a decision draft only (a rule draft exits 2).

Exit 2 leaves the draft pending. Never commit; the owner reviews the diff.
