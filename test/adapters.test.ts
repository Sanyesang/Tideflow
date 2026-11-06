import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OkxExecutionClient, OkxUnknownOrderOutcomeError } from "../src/adapters/okx_execution.js";
import { OkxMarketDataClient } from "../src/adapters/okx_market_data.js";

describe("OKX market data adapter", () => {
  it("does not connect during construction and subscribes only after connect", async () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const sent: string[] = [];
    const factory = vi.fn(() => ({
      readyState: 1,
      addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => listeners.set(type, listener),
      send: (message: string) => sent.push(message),
      close: vi.fn(),
    }));
    const onMessage = vi.fn();

    const client = new OkxMarketDataClient({
      endpoint: "wss://region.example.test/ws",
      instId: "BTC-USDT",
      channels: ["tickers", "trades", "tickers"],
      onMessage,
      webSocketFactory: factory,
    });
    expect(factory).not.toHaveBeenCalled();

    const connecting = client.connect();
    listeners.get("open")?.({});
    await connecting;
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({
      op: "subscribe",
      args: [{ channel: "tickers", instId: "BTC-USDT" }, { channel: "trades", instId: "BTC-USDT" }],
    });
    listeners.get("message")?.({ data: "{\"event\":\"subscribe\"}" });
    expect(onMessage).toHaveBeenCalledWith({ event: "subscribe" });
    client.close();
  });

  it("rejects a non-TLS websocket endpoint", () => {
    expect(() => new OkxMarketDataClient({
      endpoint: "ws://region.example.test/ws",
      instId: "BTC-USDT",
      channels: ["tickers"],
      onMessage: () => undefined,
    })).toThrow("wss://");
  });

  it("rejects the OKX WebSocket port scheduled for retirement", () => {
    expect(() => new OkxMarketDataClient({
      endpoint: "wss://region.example.test:8443/ws/v5/public",
      instId: "BTC-USDT",
      channels: ["tickers"],
      onMessage: () => undefined,
    })).toThrow("retiring WebSocket port 8443");
  });

  it("sends idle pings, consumes pongs, and closes after a missing heartbeat reply", async () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, (event: { data?: unknown; code?: number; reason?: string }) => void>();
      const sent: string[] = [];
      const socket = {
        readyState: 1,
        addEventListener: (type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void) => listeners.set(type, listener),
        send: (message: string) => sent.push(message),
        close: vi.fn(),
      };
      const onMessage = vi.fn();
      const onError = vi.fn();
      const client = new OkxMarketDataClient({
        endpoint: "wss://region.example.test/ws/v5/public",
        instId: "BTC-USDT",
        channels: ["tickers"],
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 1_000,
        onMessage,
        onError,
        webSocketFactory: () => socket,
      });
      const connecting = client.connect();
      listeners.get("open")?.({});
      await connecting;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent.at(-1)).toBe("ping");
      listeners.get("message")?.({ data: "pong" });
      expect(onMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent.filter((message) => message === "ping")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.close).toHaveBeenCalledWith(4000, "heartbeat timeout");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("heartbeat timed out") }));
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OKX execution adapter", () => {
  it("sets the demo header and signs the exact request body without making live calls", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => new Response(JSON.stringify({ code: "0", msg: "", data: [{ ordId: "mock-1", sCode: "0" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });

    await expect(client.placeOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001" }))
      .resolves.toMatchObject({ ordId: "mock-1", clientOrderId: expect.stringMatching(/^[a-f0-9]{32}$/) });
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://region.example.test/api/v5/trade/order");
    const init = request?.[1];
    if (!init) throw new Error("Expected a captured fetch request.");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("x-simulated-trading")).toBe("1");
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({
      instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001",
      clOrdId: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
    const headers = new Headers(init.headers);
    const expectedSignature = createHmac("sha256", "test-secret")
      .update(`${headers.get("OK-ACCESS-TIMESTAMP")}POST/api/v5/trade/order${body}`)
      .digest("base64");
    expect(headers.get("OK-ACCESS-SIGN")).toBe(expectedSignature);
  });

  it("pins spot market-order size currency and disables exchange size amendment when requested", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "0", msg: "", data: [{ ordId: "spot-1", sCode: "0" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await client.placeOrder({
      instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "25",
      tgtCcy: "quote_ccy", banAmend: true, slippagePct: "0.005",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ sz: "25", tgtCcy: "quote_ccy", banAmend: "true", slippagePct: "0.005" });
  });

  it("restricts spot size-unit and no-amend fields to spot market orders", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.placeOrder({
      instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "limit", sz: "25", px: "100", tgtCcy: "quote_ccy",
    })).rejects.toThrow("cash market orders");
    await expect(client.placeOrder({
      instId: "BTC-USDT", tdMode: "cross", side: "buy", ordType: "market", sz: "25", banAmend: true,
    })).rejects.toThrow("cash market orders");
    await expect(client.placeOrder({
      instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "25", slippagePct: "0.05001",
    })).rejects.toThrow("slippagePct must be");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a clean spot base balance and no pending orders before startup", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v5/account/config") return new Response(JSON.stringify({ code: "0", data: [{ acctLv: "2" }] }));
      if (url.pathname === "/api/v5/account/balance") return new Response(JSON.stringify({ code: "0", data: [{ details: [
        { ccy: "USDT", availBal: "40", frozenBal: "0", eq: "40" },
        { ccy: "BTC", availBal: "0", frozenBal: "0", eq: "0" },
      ] }] }));
      if (url.pathname === "/api/v5/trade/orders-pending") return new Response(JSON.stringify({ code: "0", data: [] }));
      return new Response(JSON.stringify({ code: "1", msg: "unexpected", data: [] }), { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });

    const snapshot = await client.reconcileFlatSpotStartup("BTC-USDT", "BTC", "USDT");
    expect(snapshot.baseBalance.equity).toBe(0);
    expect(snapshot.quoteBalance.available).toBe(40);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("https://region.example.test/api/v5/"))).toBe(true);
  });

  it("blocks spot startup when the base currency is already held", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v5/account/config") return new Response(JSON.stringify({ code: "0", data: [{}] }));
      if (url.pathname === "/api/v5/account/balance") return new Response(JSON.stringify({ code: "0", data: [{ details: [
        { ccy: "BTC", availBal: "0.01", frozenBal: "0", eq: "0.01" },
      ] }] }));
      if (url.pathname === "/api/v5/trade/orders-pending") return new Response(JSON.stringify({ code: "0", data: [] }));
      throw new Error("Unexpected endpoint.");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.reconcileFlatSpotStartup("BTC-USDT", "BTC", "USDT")).rejects.toThrow("existing base-currency balance");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed for live order changes unless explicitly enabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "live",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.placeOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001" }))
      .rejects.toThrow("disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed order quantities before network access", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.placeOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0" }))
      .rejects.toThrow("positive decimal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes a stable client order ID and blocks resubmission after an unknown transport outcome", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("simulated network loss"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    const prepared = client.prepareOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001" });
    await expect(client.submitPreparedOrder(prepared)).rejects.toMatchObject({
      name: "OkxUnknownOrderOutcomeError",
      operation: "place",
      instId: "BTC-USDT",
      clientOrderId: prepared.clientOrderId,
    });
    await expect(client.submitPreparedOrder(prepared)).rejects.toThrow("already been attempted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new OkxUnknownOrderOutcomeError({ operation: "place", instId: "BTC-USDT", clientOrderId: prepared.clientOrderId }, "timeout"))
      .toBeInstanceOf(Error);
  });

  it("classifies OKX timeout code 50004 as unknown rather than a failed order", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "50004", msg: "timeout", data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.placeOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001" }))
      .rejects.toMatchObject({ name: "OkxUnknownOrderOutcomeError" });
  });

  it("distinguishes per-order rejection from accepted top-level envelopes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "0", msg: "", data: [{ sCode: "51008", sMsg: "insufficient balance" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.placeOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001" }))
      .rejects.toThrow("sCode 51008");
  });

  it("fails safe when an order-change response omits the per-order status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "0", msg: "", data: [{ ordId: "mock-1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    await expect(client.placeOrder({ instId: "BTC-USDT", tdMode: "cash", side: "buy", ordType: "market", sz: "0.001" }))
      .rejects.toMatchObject({ name: "OkxUnknownOrderOutcomeError" });
  });
});
