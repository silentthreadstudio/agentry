import type { BacklogItem } from "@agentry/workbench-shared";
// Backlog — everything captured but not started, as a list.
//
// The board already shows the backlog as a column, so why a page: a column is a glance, and a list is
// for reading. When you are triaging twenty captured ideas you want their context, their age and their
// kind in one scannable place, not four cards and a scrollbar. Queueing from here is the same patch the
// board's drag performs — one write path, two surfaces.
import { useCallback, useEffect, useState } from "react";
import { fetchBacklog, patchBacklogItem } from "../../api/index.js";
import { getWsClient } from "../../api/ws.js";
import { EmptyState } from "../../ui/index.js";
import { relativeTime } from "../board/board-view.js";

export function Backlog() {
  const [items, setItems] = useState<BacklogItem[] | null>(null);

  const load = useCallback(() => {
    void fetchBacklog()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);

  useEffect(() => {
    load();
    return getWsClient().subscribe((msg) => {
      if (msg.type === "works-changed") load();
    });
  }, [load]);

  if (items === null) return <div aria-busy="true" />;

  const open = items.filter((i) => i.status === "backlog" || i.status === "ready");
  if (open.length === 0) {
    return (
      <EmptyState title="Nothing captured">
        Anything you add from the board lands here until it is claimed.
      </EmptyState>
    );
  }

  const move = async (item: BacklogItem, status: "backlog" | "ready") => {
    await patchBacklogItem(item.id, { status });
    load();
  };

  return (
    <div className="blist">
      {open.map((item) => (
        <article className="brow" key={item.id}>
          <div className="main">
            <div className="ttl">{item.title}</div>
            {item.body.trim().length > 0 ? <div className="ctx">{item.body.trim()}</div> : null}
            <div className="meta">
              <span className="chip kind">{item.kind}</span>
              <span className={`chip ${item.status === "ready" ? "queued" : ""}`}>
                {item.status}
              </span>
              <span className="ago">added {relativeTime(item.createdAt)}</span>
            </div>
          </div>
          <button
            type="button"
            className={item.status === "ready" ? "ghost" : "newwork-open"}
            onClick={() => void move(item, item.status === "ready" ? "backlog" : "ready")}
          >
            {item.status === "ready" ? "Put back" : "Queue"}
          </button>
        </article>
      ))}
    </div>
  );
}
