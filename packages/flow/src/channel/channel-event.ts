// Channel-event diff — the PURE half of the comment→push bridge (no I/O, unit-testable). Given a
// run/gate, the comments currently on a sidecar, and the set of comment ids already pushed, decide
// which comments are *new* (not yet seen) AND *human-origin, unresolved* and turn each into a
// `notifications/claude/channel` payload. The bridge (infra) owns the watcher + the seen-set; this
// module owns the decision + the wire shape, so the emit logic can be tested without chokidar or fs.
//
// `meta` keys MUST be snake_case (`run_id`, `comment_id`) — the host drops hyphenated keys, so a
// kebab key would silently strip the context the conductor needs to act on the comment.
import { isHumanComment, type ReviewComment } from "../domain/review.js";

// The payload of one `notifications/claude/channel` notification — `content` is what Claude reads,
// `meta` is the structured context the host surfaces in the `<channel …>` tag (snake_case only).
export interface ChannelNotification {
  content: string;
  // The structured context surfaced as `<channel …>` attributes. Keys MUST be snake_case (the host drops
  // hyphenated keys). A loose record so the one channel carries different event families — review comments
  // (run_id/doc/comment_id/decision) and human status changes (run_id/task/status) — through one EmitFn.
  meta: Record<string, string>;
}

// Quote-cap so a long anchor snippet doesn't dominate the channel content. The comment body carries
// the substance; the quote is just enough to locate what the human commented on.
const QUOTE_MAX = 120;

function quoteAnchor(originalText: string): string {
  const trimmed = originalText.trim();
  if (trimmed.length <= QUOTE_MAX) return trimmed;
  return `${trimmed.slice(0, QUOTE_MAX - 1)}…`;
}

// Render the human-facing channel content: a short quote of the span + the comment body, so Claude
// sees both *what* was commented on and *what was said* (e.g. `Review on "the auth guard": tighten this`).
export function renderChannelContent(comment: ReviewComment): string {
  return `Review on "${quoteAnchor(comment.anchor.originalText)}": ${comment.body}`;
}

// Whether a comment is eligible to push: NOT already seen, unresolved (`resolved !== true`), and
// HUMAN-origin. The human-origin gate (Phase 2, ADR-002) is what stops the echo loop: an agent's own
// `channel_reply` lands on the SAME `.review/` bus marked `origin:"agent"`, so without this check the
// bridge would re-push the reply back into the session as a `<channel>` — the agent answering itself.
export function isPushable(comment: ReviewComment, seen: ReadonlySet<string>): boolean {
  if (seen.has(comment.id)) return false;
  if (comment.resolved === true) return false;
  if (!isHumanComment(comment)) return false; // skip agent-authored replies — no echo loop
  return true;
}

// The pure diff: given the comments now on a sidecar and the ids already pushed, return the
// notifications to emit (in sidecar order) and the ids to add to the seen-set. Resolved/already-seen
// comments yield nothing. The caller owns mutating the seen-set with `newlySeen` AFTER a successful
// pass, so a failed emit can be retried on the next change.
export function diffNewComments(
  run: string,
  gate: string,
  comments: readonly ReviewComment[],
  seen: ReadonlySet<string>,
): { notifications: ChannelNotification[]; newlySeen: string[] } {
  const notifications: ChannelNotification[] = [];
  const newlySeen: string[] = [];
  for (const comment of comments) {
    if (!isPushable(comment, seen)) continue;
    notifications.push({
      content: renderChannelContent(comment),
      meta: {
        run_id: run,
        doc: gate,
        comment_id: comment.id,
        decision: comment.decision,
      },
    });
    newlySeen.push(comment.id);
  }
  return { notifications, newlySeen };
}

// Collect every comment id on a sidecar — the seed at startup records these WITHOUT pushing, so
// pre-existing comments are treated as history and only comments added after start fire a channel.
export function commentIds(comments: readonly ReviewComment[]): string[] {
  return comments.map((c) => c.id);
}
