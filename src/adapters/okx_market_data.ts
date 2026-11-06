/**
 * Minimal OKX public market-data WebSocket adapter.
 *
 * The caller must provide the region-appropriate endpoint explicitly. Importing
 * this module or constructing a client does not open a network connection.
 */

export type OkxMarketChannel = "tickers" | "trades" | "books5";

export type OkxMarketMessage = unknown;

type SocketEvent = {
  data?: unknown;
  message?: string;
  error?: unknown;
  code?: number;
  reason?: string;
};

export type OkxSocketLike = {
  readyState: number;
  addEventListener(type: string, listener: (event: SocketEvent) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type OkxWebSocketFactory = (endpoint: string) => OkxSocketLike;

export type OkxMarketDataOptions = {
  /** Explicit, region-appropriate public WebSocket URL, e.g. supplied by the operator. */
  endpoint: string;
  instId: string;
  channels: OkxMarketChannel[];
  onMessage: (message: OkxMarketMessage) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number | undefined, reason: string | undefined) => void;
  /** Must remain below OKX's 30-second idle disconnect threshold. */
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** Injection point for deterministic local tests. */
  webSocketFactory?: OkxWebSocketFactory;
};

function makeSocket(endpoint: string): OkxSocketLike {
  const SocketConstructor = globalThis.WebSocket;
  if (typeof SocketConstructor !== "function") {
    throw new Error("This runtime does not provide WebSocket; pass webSocketFactory explicitly.");
  }
  return new SocketConstructor(endpoint) as unknown as OkxSocketLike;
}

function parseMessage(data: unknown): OkxMarketMessage {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

export class OkxMarketDataClient {
  private readonly endpoint: string;
  private readonly instId: string;
  private readonly channels: OkxMarketChannel[];
  private readonly onMessage: (message: OkxMarketMessage) => void;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly onClose: ((code: number | undefined, reason: string | undefined) => void) | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly webSocketFactory: OkxWebSocketFactory;
  private socket: OkxSocketLike | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: OkxMarketDataOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "wss:") {
      throw new Error("OKX market-data endpoint must use wss://.");
    }
    if (endpoint.port === "8443") throw new Error("OKX is retiring WebSocket port 8443 on 2026-10-31; use the region endpoint on port 443.");
    if (!options.instId.trim()) throw new Error("instId is required.");
    if (options.channels.length === 0) throw new Error("At least one market-data channel is required.");
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
    if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0 || heartbeatIntervalMs >= 30_000
      || !Number.isInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0 || heartbeatTimeoutMs >= 30_000) {
      throw new Error("WebSocket heartbeat interval and timeout must be positive integers below 30,000 ms.");
    }

    this.endpoint = endpoint.toString();
    this.instId = options.instId.trim();
    this.channels = [...new Set(options.channels)];
    this.onMessage = options.onMessage;
    this.onError = options.onError;
    this.onClose = options.onClose;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.webSocketFactory = options.webSocketFactory ?? makeSocket;
  }

  /** Opens the socket and subscribes; this is the only method that connects. */
  connect(): Promise<void> {
    if (this.socket) throw new Error("Market-data client is already connected or connecting.");

    return new Promise((resolve, reject) => {
      let settled = false;
      let lastMessageAt = Date.now();
      let pingSentAt: number | undefined;
      const socket = this.webSocketFactory(this.endpoint);
      this.socket = socket;

      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify({
            op: "subscribe",
            args: this.channels.map((channel) => ({ channel, instId: this.instId })),
          }));
          this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            try {
              if (pingSentAt !== undefined) {
                if (now - pingSentAt >= this.heartbeatTimeoutMs) {
                  this.onError?.(new Error("OKX WebSocket heartbeat timed out; connection is being closed fail-stop."));
                  this.clearHeartbeat();
                  socket.close(4000, "heartbeat timeout");
                }
                return;
              }
              if (now - lastMessageAt >= this.heartbeatIntervalMs) {
                socket.send("ping");
                pingSentAt = now;
              }
            } catch {
              this.onError?.(new Error("OKX WebSocket heartbeat send failed; connection is being closed fail-stop."));
              this.clearHeartbeat();
              socket.close(4000, "heartbeat send failed");
            }
          }, this.heartbeatIntervalMs);
          settled = true;
          resolve();
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error("WebSocket subscribe failed.");
          this.onError?.(normalized);
          this.clearHeartbeat();
          this.socket = undefined;
          if (!settled) reject(normalized);
        }
      });

      socket.addEventListener("message", (event) => {
        lastMessageAt = Date.now();
        pingSentAt = undefined;
        if (event.data === "pong") return;
        this.onMessage(parseMessage(event.data));
      });

      socket.addEventListener("error", (event) => {
        const error = new Error(event.message || "Market-data WebSocket error.");
        this.onError?.(error);
        this.clearHeartbeat();
        if (!settled) {
          settled = true;
          this.socket = undefined;
          reject(error);
        }
      });

      socket.addEventListener("close", (event) => {
        this.clearHeartbeat();
        this.socket = undefined;
        this.onClose?.(event.code, event.reason);
        if (!settled) {
          settled = true;
          reject(new Error(`Market-data WebSocket closed before opening (code ${event.code ?? "unknown"}).`));
        }
      });
    });
  }

  /** Closes an active connection; it does not attempt automatic reconnection. */
  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.clearHeartbeat();
    socket?.close();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
