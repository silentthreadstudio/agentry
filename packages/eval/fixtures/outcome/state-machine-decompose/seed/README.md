# state-machine

A tiny CommonJS finite state machine split across THREE coordinating modules. Each file in `src/` ships a stub
that throws; implement them so invalid transitions are rejected rather than blindly applied.

## The concrete machine (a document workflow)

States: `draft`, `review`, `published`, `archived`. `archived` is FINAL (no event leaves it).

Transitions (from state, on event -> to state):

- `draft` + `submit` -> `review`
- `review` + `approve` -> `published`
- `review` + `reject` -> `draft`
- `published` + `archive` -> `archived`

Any event not listed for the current state is INVALID. `archived` accepts no events at all.

## The three modules

- `src/states.js` — exports `STATES` (the set/list of valid state names) and `FINAL` (the set/list of final
  states; only `archived` is final), plus `isFinal(state)`.
- `src/transitions.js` — exports `TRANSITIONS` (the table above: `{ [state]: { [event]: nextState } }`) and a
  guard `nextState(state, event)` that returns the target state if the transition is allowed, or `undefined` if
  not (including any event from a final state).
- `src/machine.js` — the barrel/entry: `create(initial)` returns `{ state, send }`. `send(event)` applies the
  transition if `nextState` allows it (updating `state`) and returns `true`; otherwise it REJECTS — leaves
  `state` unchanged — and returns `false`. `create` throws if `initial` is not a valid state.

No dependencies; keep the CommonJS exports.
