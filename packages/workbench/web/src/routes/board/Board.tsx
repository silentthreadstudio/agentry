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
import type { BoardCard, BoardColumn, BoardModel } from "@agentry/workbench-shared";
import { ApiError, fetchBoard, patchBacklogItem, resetRun } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { EmptyState } from "../../ui/index.js";
import {
  COLUMNS,
  blockedLabel,
  canDrop,
  conflictText,
  countChips,
  isReset,
  elapsedOf,
  initialsOf,
  progressOf,
  refusalReason,
  resetPrompt,
  totalCards,
} from "./board-view.js";
import { NewWork } from "./NewWork.js";
import { runHref } from "../works/works-view.js";

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

  const load = useCallback((signal?: AbortSignal) => {
    fetchBoard(signal)
      .then((board) => setState({ kind: "ready", board }))
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setState({ kind: "error", message: e instanceof ApiError ? e.message : "Couldn't reach the server." });
      });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Live: any change to the work tree — a new item, a task status flip, a run appearing — broadcasts
  // `works-changed`. Refetching the whole board is cheap (it is one read of files already in page cache)
  // and keeps the client from maintaining a second, drifting copy of the fold.
  useEffect(() => {
    return getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed" || msg.type === "file-changed") load();
    });
  }, [load]);

  const drop = async (target: BoardColumn) => {
    const card = dragging;
    setDragging(null);
    setOver(null);
    // An unwelcome column never reaches here — it refused the dragover, so the browser fires no drop
    // (that refusal is shown on hover instead). This guard is belt-and-braces, not the message path.
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
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const navigate = useNavigate();
  const progress = progressOf(card);
  const chips = countChips(card);
  const blocked = blockedLabel(card);
  const agents = card.agents ?? [];
  // Only a run can be opened — an item has nothing to look at yet, which is the honest signal that it
  // has not started.
  const open = card.run !== undefined ? () => navigate(runHref(card.run as string)) : undefined;

  return (
    <article
      className={`bcard${card.origin === "run" ? " run" : ""}${card.conflict === true ? " conflict" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={open}
      onKeyDown={(e) => {
        if (open && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      aria-label={open ? `Open run ${card.title}` : card.title}
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
        {blocked !== null ? <span className="chip blocked">{blocked}</span> : null}
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
      {agents.length > 0 ? (
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
        </div>
      ) : null}
    </article>
  );
}
