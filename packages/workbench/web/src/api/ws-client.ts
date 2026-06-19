// The WebSocket subscription — the web side of AC7 (live, no-reload updates). It connects to the
// local server's WS, parses each pushed WsMessage (the closed union from @agentry/workbench-shared),
// and fans it out to subscribers who update their store. Nothing here reloads the page: a doc-updated
// / file-changed / diff-ready message flows into React state and re-renders in place.
//
// This module owns transport (connect, reconnect-with-backoff, parse, dispatch) only — it holds no
// view state. Pages call `subscribe()` to receive typed messages and wire them into their own store.
import type { WsMessage } from "@agentry/workbench-shared";

export type WsListener = (msg: WsMessage) => void;
export type WsStatusListener = (status: WsStatus) => void;
export type WsStatus = "connecting" | "open" | "closed";

const WS_PATH = "/ws";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${WS_PATH}`;
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

  function setStatus(next: WsStatus) {
    status = next;
    for (const l of statusListeners) l(next);
  }

  function connect() {
    closedByUs = false;
    setStatus("connecting");
    const sock = new WebSocket(wsUrl());
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

  return {
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
    close,
  };
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
  if (type === "file-changed" || type === "doc-updated" || type === "diff-ready") {
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
