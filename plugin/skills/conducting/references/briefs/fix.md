# Fix {{id}}, round {{round}}

You are the builder for contract {{id}}, continuing on the same branch in the same worktree. If you built
it before, carry on from where you are. If you are new to it, read the branch first:
`{{cd}} && git log --oneline {{base}}..HEAD`.

{{#noted}}
## The owner's answer

{{answer}}

{{answerNext}}

{{/noted}}
{{#parked}}
The lane was parked with uncommitted work in the worktree: read git status first and carry on from it.

{{/parked}}
{{#fail}}
## Fix list

The verifier's FAIL is in {{from}}. Fix every FAIL item. Each probe that report names becomes a committed
test that fails without your fix and passes with it.

{{/fail}}
{{#guard}}
## Refused report

The lane refused your last report ({{from}}): {{reason}}. Fix exactly that, then report again.

{{/guard}}
{{#needed}}
## Supplied context

You asked for a fact in {{from}}. The conductor added it at the end of this brief, under "The fact". Use it
and finish the contract; anything else missing is NEEDS_CONTEXT again, and the lane then stops.

{{/needed}}
{{inner}}
