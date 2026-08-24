// Settings — what this workspace is, and what is switched on.
//
// Deliberately READ-ONLY. Agentry's contract is that the user owns every toggle and that changing one
// is a deliberate act through `/agentry:config`, where the change is explained and written to a file you
// can read. A settings screen that quietly wrote config from a checkbox would put a second, competing
// authority on the same keys. So this shows the truth and names where to change it.
import { useEffect, useState } from "react";
import { fetchContext, type AppContext } from "../../api/index.js";

export function Settings() {
  const [ctx, setCtx] = useState<AppContext | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchContext(undefined, ctrl.signal)
      .then(setCtx)
      .catch(() => setCtx({}));
    return () => ctrl.abort();
  }, []);

  return (
    <div className="blist">
      <article className="brow">
        <div className="main">
          <div className="ttl">Project root</div>
          <div className="ctx mono">{ctx?.root ?? "—"}</div>
        </div>
      </article>
      <article className="brow">
        <div className="main">
          <div className="ttl">Configuration</div>
          <div className="ctx">
            Every Agentry toggle lives in <code>.agentry/config.json</code> and defaults to stock behavior.
            Run <code>/agentry:config</code> in a session to see what is on, what each key does, and to change one.
          </div>
        </div>
      </article>
      <article className="brow">
        <div className="main">
          <div className="ttl">Workbench</div>
          <div className="ctx">
            One server serves every registered project on <code>:4317</code>. Adding a repo is
            <code> /agentry:workbench</code> from inside it.
          </div>
        </div>
      </article>
    </div>
  );
}
