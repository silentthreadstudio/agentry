# notes

add a rate limiter. limit N per window. just keep a count per key and reset it each window, return false when the
count is over the limit.

this is a deliberately weak decision artifact. it never surfaces the real fork — fixed vs sliding window — and just
picks the fixed-window count without noticing that a fixed window lets a 2×limit burst through across the boundary.
no scope, no non-goals, no override hint, no acceptance. just ship it, whatever works.
