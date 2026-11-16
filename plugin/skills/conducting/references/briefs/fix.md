# Fix {{id}}, round {{round}}

You are the builder for contract {{id}}, continuing on the same branch in the same worktree. If you built
it before, carry on from where you are. If you are new to it, read the branch first:
`{{cd}} && git log --oneline {{base}}..HEAD`.
Main may have moved since the cut: never `git rebase` or `git merge` main into the branch; report it and ask for
`exec rebase` (a verified lane) or `exec restart --carry`.

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

You asked for a fact in {{from}}. If this brief ends with a section "The fact", that is the conductor's answer:
use it and finish the contract. If it has no such section, no fact was supplied: report NEEDS_CONTEXT again
and say so. Anything else missing is NEEDS_CONTEXT again too, and the lane then holds for the owner.

{{/needed}}
{{inner}}
