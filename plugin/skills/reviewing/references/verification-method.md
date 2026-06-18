# Verification Method — depth

Reference for the `reviewing` skill. The job is to make every verdict **provable**. This file gives the evidence taxonomy (what counts as proof), the security checklist with signatures to grep for, and the shape of a citable verdict line.

## Evidence taxonomy — what counts as proof per criterion type

A criterion is only PASS when you can point at an observation. Match the evidence to the criterion's shape:

| Criterion shape | Acceptable evidence | Not evidence |
| :--- | :--- | :--- |
| "function returns / computes X" | the unit test that asserts it, with its pass count; or the command + its output | "the code looks like it returns X" |
| "endpoint behaves / status code" | the request you made + the response (command, status, body) | reading the handler and inferring |
| "UI shows / does X" | a screenshot path + what it shows; a driven interaction (click → observed result) | "the component renders X" from the JSX |
| "the suite passes" | `N passed, M failed` from the actual run | "tests should pass" |
| "no regression in Y" | the Y test(s) run *after* the change, green | the change "shouldn't affect Y" |
| "performs within budget" | a measured number (timing, trace) vs the budget | "it's probably fast enough" |

**The rule:** if the only thing behind a verdict is the diff, it is not verified — it is reviewed-by-reading, which is rubber-stamping. Run it.

**UNVERIFIED is a legitimate, honest verdict.** When there is no harness to observe the behavior (no test, no runnable entry point, no browser for a UI), mark the criterion UNVERIFIED and name the exact blocker and the tool/access that would unblock it. Never round UNVERIFIED up to PASS.

## Behavior over diffs — why

Independently-built tasks can each be locally correct and still break at the seam where they meet (mismatched contract assumptions, ordering, shared state). A diff cannot show this; only running the assembled behavior can. Reading patches is how the "all tasks pass, product broken" gap survives review. Always reach for the observable behavior first.

## Security checklist — signatures to look for

For each, the question and a concrete thing to search for or test. Apply regardless of whether the change "is a security feature."

- **Injection** — is untrusted input concatenated into a query/command/template/log?
  - Look for string-built SQL (`"... WHERE id = " + id`), shell calls with interpolation, template engines fed raw input. PASS requires parameterization/escaping *at the sink*.
- **Authz / authn** — is every privileged path gated, and gated on the *right* subject?
  - Look for handlers that read/write a resource by id without checking the caller owns it (IDOR), routes missing an auth middleware, role checks that can be bypassed. Test: call the path as a user who shouldn't be allowed.
- **Secrets** — are credentials hardcoded, logged, or returned?
  - Grep for `api_key`, `secret`, `password`, `token`, private-key headers in source, logs, and error responses. PASS requires they come from config/secret store and never leave in output.
- **Path traversal** — can user input choose a filesystem path?
  - Look for `../` reaching a file read/write, user input joined into a path without normalization + confinement to a base dir.
- **Unsafe deserialization** — is untrusted data fed to a deserializer that can instantiate/execute?
  - Look for pickle/yaml-unsafe-load/native-object deserialization of request bodies. PASS requires a safe loader or schema-validated parsing.
- **SSRF** — does user input determine a URL/host the server fetches?
  - Look for a request library called with a user-supplied URL. PASS requires an allowlist (not a denylist) and blocking internal/metadata addresses.

A security FAIL outranks feature-completeness: a feature that works *and* leaks is a FAIL.

## The shape of a citable verdict line

Each criterion gets one line. The pattern:

```
AC2  PASS    ran `pnpm test auth/middleware` → 14 passed, 0 failed; covers expiry + missing-token paths
AC3  FAIL    POST /users with no session returned 200 (expected 401) — `curl -i ...` output below; authz gate missing on the create path
AC4  UNVERIFIED  no browser MCP available to drive the login form; needs chrome-devtools / claude-in-chrome to observe
```

Every line names the **method**. A line that says only `AC2 PASS` is not a verdict — it is the exact thing this skill exists to forbid.

## Gotchas — name them for the moat

When a check surfaces a failure mode worth remembering (a seam that breaks under condition X, a test that lies, an input that wasn't handled), state it as a named gotcha. The conductor harvests these into memory so the *next* task touching that file is born with the warning in its `## Gotchas`. A discovered-but-unnamed gotcha is value left on the floor.
