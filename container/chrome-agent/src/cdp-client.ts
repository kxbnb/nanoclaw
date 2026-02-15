import * as http from "node:http";
import WebSocket from "ws";

export type CdpEventHandler = (params: unknown, sessionId?: string) => void;

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(event: string, handler: CdpEventHandler): void;
  off(event: string, handler: CdpEventHandler): void;
  close(): void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
};

/**
 * Discover the browser-level CDP WebSocket URL from the HTTP endpoint.
 * Fetches http://host:port/json/version and returns webSocketDebuggerUrl.
 */
export async function discoverWsUrl(cdpHttpUrl: string): Promise<string> {
  const base = cdpHttpUrl.replace(/\/$/, "");
  const parsed = new URL(base);

  // Chrome CDP rejects non-localhost Host headers (HTTP 500).
  // Node.js fetch (undici) silently ignores Host overrides, so we use http.request.
  const body = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error("timeout")); }, 5000);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || "9222",
        path: "/json/version",
        method: "GET",
        headers: { Host: `localhost:${parsed.port || "9222"}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          reject(new Error(`HTTP ${res.statusCode} from ${base}/json/version`));
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => { clearTimeout(timer); resolve(data); });
      },
    );
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });

  const json = JSON.parse(body) as { webSocketDebuggerUrl?: string };
  let wsUrl = json?.webSocketDebuggerUrl?.trim();
  if (!wsUrl) {
    throw new Error("CDP /json/version missing webSocketDebuggerUrl");
  }
  // The returned URL uses the Host header's hostname (localhost).
  // Replace it with the actual host so the WebSocket connects correctly.
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    wsUrl = wsUrl.replace(/ws:\/\/[^/]+/, `ws://${parsed.host}`);
  }
  return wsUrl;
}

/**
 * Create a persistent CDP client over WebSocket.
 * Keeps the connection open for the lifetime of the client.
 */
export function createCdpClient(ws: WebSocket): CdpClient {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<CdpEventHandler>>();

  const send = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> => {
    if (ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP socket not open"));
    }
    const id = nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params) {
      msg.params = params;
    }
    if (sessionId) {
      msg.sessionId = sessionId;
    }
    ws.send(JSON.stringify(msg));
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const dispatchEvent = (method: string, params: unknown, sessionId?: string) => {
    const handlers = listeners.get(method);
    if (!handlers) {
      return;
    }
    for (const h of handlers) {
      try {
        h(params, sessionId);
      } catch {
        // swallow handler errors
      }
    }
  };

  const closeWithError = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on("error", (err) => {
    closeWithError(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("message", (data) => {
    try {
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8");
      const msg = JSON.parse(raw) as CdpMessage;

      // Response to a request
      if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error?.message) {
            p.reject(new Error(msg.error.message));
          } else {
            p.resolve(msg.result);
          }
        }
        return;
      }

      // CDP event
      if (msg.method) {
        dispatchEvent(msg.method, msg.params, msg.sessionId);
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on("close", () => {
    closeWithError(new Error("CDP socket closed"));
  });

  return {
    send,
    on(event: string, handler: CdpEventHandler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
    },
    off(event: string, handler: CdpEventHandler) {
      listeners.get(event)?.delete(handler);
    },
    close() {
      pending.clear();
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Connect to a CDP endpoint and return a ready client.
 * Accepts either a ws:// URL directly or an http:// URL (auto-discovers WS URL).
 */
export async function connectCdp(urlOrHttp: string): Promise<CdpClient> {
  let wsUrl: string;
  if (urlOrHttp.startsWith("ws://") || urlOrHttp.startsWith("wss://")) {
    wsUrl = urlOrHttp;
  } else {
    wsUrl = await discoverWsUrl(urlOrHttp);
  }

  const ws = new WebSocket(wsUrl);
  const client = createCdpClient(ws);

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });

  return client;
}
