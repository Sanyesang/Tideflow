import { describe, expect, it, vi } from "vitest";
import { OkxExecutionClient } from "../src/adapters/okx_execution.js";
import { OkxOrderCoordinator } from "../src/execution/order_coordinator.js";
import { TradeJournal, type JournalStorage } from "../src/persistence/trade_journal.js";
import { DemoSpotRuntime } from "../src/runtime/demo_spot_runtime.js";

class MemoryJournalStorage implements JournalStorage {
  private lines: string[] = [];

  async appendLine(line: string): Promise<void> {
    this.lines.push(line);
  }

  async readText(): Promise<string> {
    return this.lines.join("\n");
  }
}

const instrument = {
  instId: "BTC-USDT",
  baseCcy: "BTC",
  quoteCcy: "USDT",
  lotSz: "0.01",
  minSz: "0.01",
  tickSz: "0.1",
  state: "live" as const,
};

describe("demo spot runtime", () => {
  it("reconciles an uncertain buy without retrying, then sells and journals the close", async () => {
    const storage = new MemoryJournalStorage();
    const journal = new TradeJournal(storage);
    const client = new OkxExecutionClient({
      environment: "demo",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    const coordinator = new OkxOrderCoordinator(client, journal);
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const orderSides: string[] = [];
    const orderPayloads: Array<Record<string, unknown>> = [];
    const sideByClientId = new Map<string, string>();
    const lookupCounts = new Map<string, number>();
    let buySubmitted = false;
    let sellSubmitted = false;
    const balances = (): unknown[] => [{ details: [
      { ccy: "USDT", availBal: sellSubmitted ? "1000.4" : buySubmitted ? "949.9" : "1000", frozenBal: "0", eq: sellSubmitted ? "1000.4" : buySubmitted ? "949.9" : "1000" },
      { ccy: "BTC", availBal: sellSubmitted ? "0" : buySubmitted ? "0.5" : "0", frozenBal: "0", eq: sellSubmitted ? "0" : buySubmitted ? "0.5" : "0" },
    ] }];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v5/account/config") return new Response(JSON.stringify({ code: "0", data: [{ acctLv: "2" }] }));
      if (url.pathname === "/api/v5/account/balance") return new Response(JSON.stringify({ code: "0", data: balances() }));
      if (url.pathname === "/api/v5/trade/orders-pending") return new Response(JSON.stringify({ code: "0", data: [] }));
      if (url.pathname === "/api/v5/trade/order" && method === "POST") {
        const payload = JSON.parse(String(init?.body)) as { side: string; clOrdId: string; tgtCcy?: string; sz?: string; banAmend?: string };
        expect(new Headers(init?.headers).get("x-simulated-trading")).toBe("1");
        orderSides.push(payload.side);
        orderPayloads.push(payload);
        sideByClientId.set(payload.clOrdId, payload.side);
        if (payload.side === "buy") buySubmitted = true;
        else sellSubmitted = true;
        if (payload.side === "buy") throw new Error("simulated accepted order with lost response");
        return new Response(JSON.stringify({ code: "0", data: [{ ordId: payload.side === "buy" ? "buy-order" : "sell-order", sCode: "0" }] }));
      }
      if (url.pathname === "/api/v5/trade/order" && method === "GET") {
        const clOrdId = url.searchParams.get("clOrdId");
        const side = clOrdId ? sideByClientId.get(clOrdId) : undefined;
        if (!side) throw new Error("Mock could not match the order query to a submitted client ID.");
        const lookups = (lookupCounts.get(clOrdId!) ?? 0) + 1;
        lookupCounts.set(clOrdId!, lookups);
        return new Response(JSON.stringify({ code: "0", data: [{
          ordId: side === "buy" ? "buy-order" : "sell-order",
          instId: "BTC-USDT",
          clOrdId,
          state: side === "sell" ? "filled" : lookups === 1 ? "partially_filled" : "canceled",
          accFillSz: side === "sell" ? "0.5" : "0.5",
          avgPx: side === "buy" ? "100.2" : "101",
        }] }));
      }
      throw new Error(`Unexpected mock request: ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = new DemoSpotRuntime({
      endpoint: "wss://region.example.test/ws/v5/public",
      instId: "BTC-USDT",
      instrument,
      client,
      coordinator,
      journal,
      quoteBudget: "100",
      slippagePct: "0.005",
      stopLossBps: 35,
      takeProfitBps: 50,
      lookbackTicks: 1,
      entryThresholdBps: 10,
      riskLimits: {
        maxOrderNotionalUsd: 100,
        maxPositionNotionalUsd: 100,
        dailyLossLimitUsd: 25,
        maxOrdersPerMinute: 4,
        maxSpreadBps: 20,
        orderCooldownMs: 0,
        maxMarketAgeMs: 2_000,
      },
      onStatus: () => undefined,
      webSocketFactory: () => ({
        readyState: 1,
        addEventListener: (type, listener) => listeners.set(type, listener),
        send: () => undefined,
        close: () => undefined,
      }),
    });

    const startPromise = runtime.start();
    for (let attempt = 0; attempt < 20 && !listeners.has("open"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get("open")?.({});
    await startPromise;
    const emit = async (last: number): Promise<void> => {
      listeners.get("message")?.({ data: JSON.stringify({
        arg: { channel: "tickers", instId: "BTC-USDT" },
        data: [{ instId: "BTC-USDT", last: String(last), bidPx: String(last - 0.01), askPx: String(last + 0.01), ts: String(Date.now()) }],
      }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await emit(100);
    await emit(100.2);
    await emit(100.3);
    await emit(100.4);
    await emit(101);
    await emit(101.1);
    runtime.stop();

    expect(orderSides).toEqual(["buy", "sell"]);
    expect(orderPayloads[0]).toMatchObject({ side: "buy", tgtCcy: "base_ccy", banAmend: "true" });
    expect(orderPayloads[1]).toMatchObject({ side: "sell", tgtCcy: "quote_ccy", banAmend: "false" });
    expect(Number(orderPayloads[1]?.sz)).toBeCloseTo(50.495, 6);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    const events = await journal.readEvents();
    expect(events.filter((event) => event.kind === "spot_position_open")).toHaveLength(1);
    const closed = events.find((event) => event.kind === "spot_trade_closed");
    expect(closed).toMatchObject({ baseSize: "0.5", entryPrice: "100.2", exitPrice: "101" });
    if (closed?.kind === "spot_trade_closed") expect(Number(closed.realizedPnlQuote)).toBeCloseTo(0.4, 6);
    await journal.assertNoUnresolvedOrders();
  });

  it("refuses any live-mode client before opening a socket", () => {
    const client = new OkxExecutionClient({
      environment: "live",
      restBaseUrl: "https://region.example.test",
      credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
    });
    expect(() => new DemoSpotRuntime({
      endpoint: "wss://region.example.test/ws/v5/public",
      instId: "BTC-USDT",
      instrument,
      client,
      coordinator: new OkxOrderCoordinator(client, new TradeJournal(new MemoryJournalStorage())),
      journal: new TradeJournal(new MemoryJournalStorage()),
      quoteBudget: "10",
      slippagePct: "0.005",
      stopLossBps: 35,
      takeProfitBps: 50,
      lookbackTicks: 1,
      entryThresholdBps: 10,
      riskLimits: {
        maxOrderNotionalUsd: 10,
        maxPositionNotionalUsd: 10,
        dailyLossLimitUsd: 5,
        maxOrdersPerMinute: 2,
        maxSpreadBps: 20,
        orderCooldownMs: 0,
        maxMarketAgeMs: 2_000,
      },
    })).toThrow("requires an OKX client explicitly configured for the simulated-trading environment");
  });
});
