// The WebSocket subscription — the web side of AC7 (live, no-reload updates). It connects to the
// local server's WS, parses each pushed WsMessage (the closed union from @agentry/workbench-shared),
// and fans it out to subscribers who update their store. Nothing here reloads the page: a doc-updated
// / file-changed / diff-ready message flows into React state and re-renders in place.
//
// This module owns transport (connect, reconnect-with-backoff, parse, dispatch) only — it holds no
// view state. Pages call `subscribe()` to receive typed messages and wire them into their own store.
import type { WsMessage } from "@agentry/workbench-shared";
import { FOCUS_EVENT, focusedRun } from "../routes/rail/rail-state.js";
import { currentProject } from "./http.js";

export type WsListener = (msg: WsMessage) => void;
export type WsStatusListener = (status: WsStatus) => void;
export type WsStatus = "connecting" | "open" | "closed";

const WS_PATH = "/ws";

// The run this socket subscribes to.
//
// The URL path (`/work/<slug>`) names it while you are inside a run. But the conversation rail is now
// AMBIENT — it sits beside the board too, talking about a focused run that the URL says nothing about —
// and its live updates ride the same run-scoped socket. Deriving the subscription from the path alone
// therefore left the socket bound to NO run on the board, so an agent's reply never arrived: the message
// you sent appeared (the optimistic insert) and nothing ever came back.
//
// So the path wins when you are in a run, and the rail's focused run is the fallback everywhere else.
function currentRunLabel(): string | null {
  const m = /^\/work\/([^/]+)/.exec(location.pathname);
  const raw = m?.[1];
  if (raw !== undefined && raw.length > 0) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return focusedRun();
}

function wsUrl(run: string | null): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // The socket is scoped by BOTH: a run id is only unique within a project, so the server keys
  // subscriptions on the pair. Same seam as every REST call (`apiPath`).
  const params = new URLSearchParams();
  if (run !== null) params.set("run", run);
  const project = currentProject();
  if (project !== null) params.set("project", project);
  const query = params.toString();
  return `${proto}//${location.host}${WS_PATH}${query ? `?${query}` : ""}`;
}

/**
 * A single shared connection to the server's WebSocket, with automatic reconnect. Returns a handle
 * to subscribe to typed messages and connection status, and to close. The connection opens lazily on
 * the first `subscribe` and closes when the last subscriber leaves.
 */
export function createWsClient() {
  const listeners = new Set<WsListener>();
  const statusListeners = new Set<WsStatusListener>();
  let socket: WebSocket | null = null;
  let status: WsStatus = "closed";
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closedByUs = false;
  // The label the OPEN socket subscribed with — compared against the URL on `retarget` so an in-app
  // move from one run to another re-subscribes instead of quietly streaming the previous run's changes.
  let subscribedRun: string | null = null;

  function setStatus(next: WsStatus) {
    status = next;
    for (const l of statusListeners) l(next);
  }

  // The rail can point at a different run without the URL changing, so the socket follows the focus
  // event rather than the rail calling into transport — the dependency points one way, from transport
  // to state, and never back.
  if (typeof window !== "undefined") {
    window.addEventListener(FOCUS_EVENT, () => client.retarget());
  }

  function connect() {
    closedByUs = false;
    setStatus("connecting");
    subscribedRun = currentRunLabel();
    const sock = new WebSocket(wsUrl(subscribedRun));
    socket = sock;

    sock.onopen = () => {
      retry = 0;
      setStatus("open");
    };

    sock.onmessage = (ev: MessageEvent) => {
      const msg = parseMessage(ev.data);
      if (!msg) return; // ignore malformed frames rather than crashing the stream
      for (const l of listeners) l(msg);
    };

    sock.onclose = () => {
      socket = null;
      setStatus("closed");
      if (!closedByUs && listeners.size > 0) scheduleReconnect();
    };

    sock.onerror = () => {
      sock.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    // exponential backoff, capped — the local server may be restarting (reload-gated changes).
    const delay = Math.min(1000 * 2 ** retry, 10000);
    retry += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (listeners.size > 0) connect();
    }, delay);
  }

  function close() {
    closedByUs = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
    setStatus("closed");
  }

  const client = {
    /** Subscribe to typed push messages. Opens the connection on first subscriber. Returns an unsubscribe. */
    subscribe(listener: WsListener): () => void {
      listeners.add(listener);
      if (!socket && status === "closed") connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) close();
      };
    },
    /** Observe connection status (connecting / open / closed) for a live indicator. */
    onStatus(listener: WsStatusListener): () => void {
      statusListeners.add(listener);
      listener(status);
      return () => statusListeners.delete(listener);
    },
    getStatus: (): WsStatus => status,
    /**
     * Re-point the connection at the run the URL now names. Called after client-side navigation between
     * runs: the socket is long-lived (a project-global subscriber like the approvals banner keeps it open
     * across route changes), so without this it would stay bound to the run it was opened on and the new
     * run's live updates would never arrive.
     */
    retarget(): void {
      const next = currentRunLabel();
      if (next === subscribedRun) return;
      if (listeners.size === 0) {
        subscribedRun = next; // nothing listening — the next connect() picks the new label up anyway
        return;
      }
      closedByUs = true;
      socket?.close();
      socket = null;
      connect();
    },
    close,
  };

  return client;
}

export type WsClient = ReturnType<typeof createWsClient>;

// Parse + validate a frame into the closed WsMessage union. Anything off-contract returns null.
function parseMessage(data: unknown): WsMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
  const type = (parsed as { type: unknown }).type;
  if (
    type === "file-changed" ||
    type === "works-changed" ||
    type === "doc-updated" ||
    type === "diff-ready" ||
    type === "permission-added" ||
    type === "permission-removed"
  ) {
    return parsed as WsMessage;
  }
  return null;
}

// A lazily-created, module-singleton client — most pages share one connection.
let shared: WsClient | null = null;
export function getWsClient(): WsClient {
  if (!shared) shared = createWsClient();
  return shared;
}
