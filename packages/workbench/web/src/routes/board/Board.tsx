import type { BoardCard, BoardColumn, BoardModel } from "@agentry/workbench-shared";
// Board — the workspace home: every piece of work in this project, from intent to shipped.
//
// It replaces the Works list. Works answered "which runs exist"; the board answers the question you
// actually hold — *what is moving, and what needs me* — by putting backlog items and runs on ONE
// lifecycle instead of two views of two things.
//
// The columns are NOT derived here. `/api/board` folds them server-side (doc 18 AC4) because a client
// that inferred a column from a task tally could disagree with disk the moment either side moved. This
// component renders what it is given and owns only interaction: drag, open, and the refusal message.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, fetchBoard, patchBacklogItem, resetRun } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { EmptyState } from "../../ui/index.js";
import { NewWork } from "./NewWork.js";
import { RunView } from "./RunView.js";
import {
  COLUMNS,
  assignedByAgent,
  blockedLabel,
  canDrop,
  cardNote,
  conflictText,
  countChips,
  currentTask,
  elapsedOf,
  initialsOf,
  isReset,
  keyboardTarget,
  progressOf,
  refusalReason,
  resetPrompt,
  runHref,
  totalCards,
} from "./board-view.js";

import "./board.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; board: BoardModel };

export function Board() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback((signal?: AbortSignal) => {
    fetchBoard(signal)
      .then((board) => setState({ kind: "ready", board }))
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setState({
          kind: "error",
          message: e instanceof ApiError ? e.message : "Couldn't reach the server.",
        });
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Live: a change to the WORK TREE — a new item, a task status flip, a run appearing — broadcasts
  // `works-changed`, and refetching the fold is cheap (one read of files already in page cache).
  //
  // Deliberately NOT `file-changed`. That fires for every write inside a run, including a chat message
  // landing on the conversation's `.review/` sidecar — so reloading on it made the whole board flash
  // each time you sent a message. A message is not a board change.
  useEffect(() => {
    return getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed") load();
    });
  }, [load]);

  // The ONE move path — drag and keyboard both land here, so a card cannot behave differently
  // depending on which one you used (the reset confirm in particular).
  const move = async (card: BoardCard | null, target: BoardColumn) => {
    // An unwelcome column never reaches here from a drag — it refused the dragover, so the browser fires
    // no drop (that refusal is shown on hover instead). The guard is what the KEYBOARD path leans on.
    if (!card || card.column === target || !canDrop(card, target)) return;
    setRefusal(null);
    try {
      if (isReset(card, target)) {
        // A reset is not a move — it rewinds real work, so it asks first. The prompt spells out that
        // nothing is deleted and no agent is stopped, because "reset" reads like "kill it" otherwise.
        if (!window.confirm(resetPrompt(card))) return;
        await resetRun(card.run ?? card.id);
      } else {
        await patchBacklogItem(card.id, { status: target === "ready" ? "ready" : "backlog" });
      }
      load(); // the ws nudge will also fire; refetching now makes the move feel immediate
    } catch {
      setRefusal("Couldn't move that — the server rejected the change.");
    }
  };

  const drop = (target: BoardColumn) => {
    const card = dragging;
    setDragging(null);
    setOver(null);
    return move(card, target);
  };

  if (state.kind === "loading") return <div className="board-wrap" aria-busy="true" />;
  if (state.kind === "error") {
    return (
      <div className="board-wrap">
        <EmptyState title="Can't read the board">{state.message}</EmptyState>
      </div>
    );
  }

  const { columns } = state.board;
  const total = totalCards(columns);

  return (
    <div className="board-wrap">
      <div className="board-head">
        <div>
          <h1>Board</h1>
          <p>
            {total === 0
              ? "Nothing here yet — add the first piece of work."
              : `${total} piece${total === 1 ? "" : "s"} of work, from intent to shipped.`}
          </p>
        </div>
        <div className="grow" />
        <NewWork onCreated={load} />
      </div>

      {refusal !== null ? (
        // biome-ignore lint/a11y/useSemanticElements: <output> is inline; the div keeps the block layout
        <div className="board-refusal" role="status">
          {refusal}
          <button type="button" onClick={() => setRefusal(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ) : null}

      {state.board.conflicts.map((c) => (
        <div className="board-conflict" role="alert" key={c.tasks.join("|")}>
          <span aria-hidden="true">⚠</span>
          <span>
            <b>Contract overlap</b> — {conflictText(c)}
          </span>
        </div>
      ))}

      <div className="board">
        {COLUMNS.map((col) => (
          <section
            key={col.key}
            className={`bcol${over === col.key ? " over" : ""}`}
            data-col={col.key}
            // In focus mode the columns that do not change minute-to-minute collapse to a count, so the
            // conversation can take the width without the board clipping (AC13).
            {...(col.key === "running" || col.key === "in-review" ? {} : { "data-digest": "" })}
            onDragOver={(e) => {
              if (!dragging) return;
              const welcome = canDrop(dragging, col.key);
              if (welcome) {
                // preventDefault is what marks a target as droppable — without it `drop` never fires.
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(col.key);
                setRefusal(null);
                return;
              }
              // An unwelcome column is explained ON HOVER, not on release. It cannot be explained on
              // drop: leaving dropEffect at "none" (which is what gives the correct no-drop cursor)
              // means the browser never fires `drop` at all. Saying it while the card is still in the
              // air is better anyway — you learn the rule before committing to it.
              e.dataTransfer.dropEffect = "none";
              setOver(null);
              setRefusal((current) => {
                const next = refusalReason(dragging, col.key);
                return current === next ? current : next; // don't re-render on every dragover tick
              });
            }}
            onDragLeave={(e) => {
              // dragleave fires when crossing into a CHILD too, which would flicker the highlight off
              // while still inside the column. Ignore those: only a leave that actually exits the
              // column's box counts.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setOver((c) => (c === col.key ? null : c));
            }}
            onDrop={(e) => {
              e.preventDefault();
              void drop(col.key);
            }}
          >
            <div className="bcolhd">
              <span className="dot" style={{ background: col.hue }} />
              <span className="t">{col.label}</span>
              <span className="n">{columns[col.key].length}</span>
            </div>
            <div className="bstack">
              {columns[col.key].map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  onDragStart={() => setDragging(card)}
                  onMove={(dir) => {
                    const target = keyboardTarget(card, dir);
                    if (target !== null) void move(card, target);
                  }}
                  onOpen={() => card.run !== undefined && navigate(runHref(card.run))}
                  onDragEnd={() => {
                    // Clears on cancel (Esc, drop outside a column) as well as on a real drop —
                    // otherwise a column stays highlighted with nothing being dragged.
                    setDragging(null);
                    setOver(null);
                  }}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Card({
  card,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  onOpen: () => void;
  onMove: (dir: -1 | 1) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const progress = progressOf(card);
  const chips = countChips(card);
  const blocked = blockedLabel(card);
  const agents = card.agents ?? [];
  const assigned = assignedByAgent(card);
  const note = cardNote(card);
  // A gate is the one thing on this board that is waiting on YOU rather than on an agent, so an
  // in-review card says which artifact is at the gate rather than only that it is in review.
  const gate = card.column === "in-review";
  const task = currentTask(card);
  // Only a run can be previewed — an item has no artifacts yet, which is the honest signal that it has
  // not started. Opening PREVIEWS it in a pane rather than navigating away; the full run view (graph,
  // activity, the editor) is one click further, from inside the pane.
  const open = card.run !== undefined ? onOpen : undefined;
  // Every card is focusable, not only the openable ones: a backlog ITEM has no run to open, and if focus
  // skipped it there would be no way to reach ←/→ and move it. Drag is the mouse affordance; the arrows
  // are the same action, and an action only one input device can perform is not an action everyone has.
  const label = [
    open ? `Open run ${card.title}` : card.title,
    `in ${COLUMNS.find((c) => c.key === card.column)?.label ?? card.column}`,
    "left and right arrows move it",
  ].join(", ");

  return (
    <article
      className={`bcard${card.origin === "run" ? " run" : ""}${card.conflict === true ? " conflict" : ""}${blocked !== null ? " blocked-run" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={open}
      onKeyDown={(e) => {
        if (open && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
          return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault(); // otherwise the column scrolls sideways under the card that just left it
          onMove(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}
      role={open ? "button" : undefined}
      tabIndex={0}
      aria-label={label}
    >
      <div className="ttl">{card.title}</div>
      <div className="meta">
        {card.kind !== undefined ? <span className="chip kind">{card.kind}</span> : null}
        {card.shape !== undefined ? <span className="chip">{card.shape}</span> : null}
        {card.item !== undefined && card.origin === "run" ? (
          <span className="chip from" title={`From backlog item ${card.item}`}>
            from backlog
          </span>
        ) : null}
        {task !== null ? <span className="chip mono">{task}</span> : null}
        {gate ? <span className="chip gate">gate</span> : null}
        {blocked !== null ? <span className="chip blocked">{blocked}</span> : null}
        {note.length > 0 ? <span className="note">{note}</span> : null}
      </div>
      {progress !== null ? (
        <div className="bar">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
      {chips.length > 0 ? (
        <div className="counts">
          {chips.map((c) => (
            <span key={c.label}>
              <b>{c.n}</b> {c.label}
            </span>
          ))}
        </div>
      ) : null}
      {agents.length > 0 || assigned.length > 0 ? (
        <div className="presence">
          {agents.map((a) => {
            const elapsed = elapsedOf(a);
            return (
              <span className="who" key={a.id} title={`${a.role} · ${a.state}`}>
                <span className={`av ${a.state}`}>{initialsOf(a)}</span>
                <span className="act">
                  {a.role}
                  {a.file !== undefined ? <code> · {a.file}</code> : null}
                </span>
                {a.state === "working" ? <span className="pulse" /> : null}
                {elapsed !== null ? <span className="ago">{elapsed}</span> : null}
              </span>
            );
          })}
          {/* Staffed but not started — dimmed, because it is a commitment rather than motion. */}
          {assigned.map((a) => (
            <span
              className="who waiting"
              key={a.to}
              title={`${a.to} assigned to ${a.tasks.length} task(s)`}
            >
              <span className="av">{a.to.slice(0, 2).toUpperCase()}</span>
              <span className="act">
                {a.to} · assigned <code>{a.tasks.map((t) => `T-${t}`).join(", ")}</code>
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
