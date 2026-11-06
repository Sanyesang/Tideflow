import { describe, expect, it, vi } from "vitest";
import { parseOkxTickerMessage } from "../src/market/okx_ticker.js";
import { PaperBroker } from "../src/paper/paper_broker.js";
import { PaperRuntime } from "../src/runtime/paper_runtime.js";
import { PaperJournal, type PaperJournalStorage } from "../src/persistence/paper_journal.js";
import { TickMomentumStrategy } from "../src/strategy/tick_momentum.js";

describe("market ticker normalization", () => {
  it("accepts valid ticker rows and skips malformed data", () => {
    const parsed = parseOkxTickerMessage({
      arg: { channel: "tickers", instId: "BTC-USDT" },
      data: [
        { instId: "BTC-USDT", last: "100", bidPx: "99.9", askPx: "100.1", ts: "1792500000000" },
        { instId: "ETH-USDT", last: "0", bidPx: "0", askPx: "0", ts: "bad" },
      ],
    }, 1234);
    expect(parsed).toEqual([{
      instId: "BTC-USDT", last: 100, bid: 99.9, ask: 100.1, exchangeTimestampMs: 1792500000000, receivedAtMs: 1234,
    }]);
  });
});

describe("tick momentum signal", () => {
  it("waits for its lookback, then emits direction from observed ticks", () => {
    const strategy = new TickMomentumStrategy({ lookbackTicks: 2, entryThresholdBps: 10, allowShort: true });
    expect(strategy.update(100).direction).toBe("flat");
    expect(strategy.update(100).direction).toBe("flat");
    expect(strategy.update(100.2).direction).toBe("long");
    expect(strategy.update(99.8).direction).toBe("short");
  });
});

describe("paper broker", () => {
  it("tracks simulated exposure, fees, protective levels, and net PnL", () => {
    const broker = new PaperBroker({
      initialBalanceUsd: 1_000,
      fixedNotionalUsd: 100,
      takerFeeBps: 5,
      slippageBps: 2,
      stopLossBps: 100,
      takeProfitBps: 100,
    });
    broker.open("long", 100, 100.02, 1_000);
    expect(broker.position?.stopPrice).toBeLessThan(broker.position!.entryPrice);
    expect(broker.equityUsd(100.5, 100.52)).toBeGreaterThan(broker.cashBalanceUsd);
    const trade = broker.close(101.2, 101.22, 2_000, "take_profit");
    expect(trade.exitReason).toBe("take_profit");
    expect(trade.netPnlUsd).toBeCloseTo(trade.grossPnlUsd - trade.feesUsd, 10);
    expect(broker.position).toBeUndefined();
    expect(broker.orderTimestampsMs).toEqual([1_000, 2_000]);
  });
});

describe("paper runtime session report", () => {
  it("reports open simulated exposure on stop without auto-closing it", async () => {
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const report = vi.fn();
    const runtime = new PaperRuntime({
      endpoint: "wss://region.example.test/ws/v5/public",
      instId: "BTC-USDT",
      initialBalanceUsd: 1_000,
      fixedNotionalUsd: 100,
      takerFeeBps: 5,
      slippageBps: 2,
      stopLossBps: 35,
      takeProfitBps: 50,
      lookbackTicks: 1,
      entryThresholdBps: 1,
      allowShort: false,
      riskLimits: {
        maxOrderNotionalUsd: 100,
        maxPositionNotionalUsd: 100,
        dailyLossLimitUsd: 25,
        maxOrdersPerMinute: 4,
        maxSpreadBps: 20,
        orderCooldownMs: 1_000,
        maxMarketAgeMs: 2_000,
      },
      onReport: report,
      onStatus: () => undefined,
      webSocketFactory: () => ({
        readyState: 1,
        addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => listeners.set(type, listener),
        send: () => undefined,
        close: () => undefined,
      }),
    });
    const connected = runtime.start();
    listeners.get("open")?.({});
    await connected;
    const now = Date.now();
    const emit = (last: number) => listeners.get("message")?.({ data: JSON.stringify({
      arg: { channel: "tickers", instId: "BTC-USDT" },
      data: [{ instId: "BTC-USDT", last: String(last), bidPx: String(last - 0.01), askPx: String(last + 0.01), ts: String(now) }],
    }) });
    emit(100);
    emit(100.1);
    runtime.stop();
    runtime.stop();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      instrumentId: "BTC-USDT",
      closedTradeCount: 0,
      openPosition: expect.objectContaining({ side: "long" }),
      note: expect.stringContaining("not closed automatically"),
    }));
  });
});

describe("paper journal", () => {
  it("appends simulated activity and refuses invalid records", () => {
    const lines: string[] = [];
    const storage: PaperJournalStorage = { appendLine: (line) => lines.push(line) };
    const journal = new PaperJournal(storage);
    const trade = {
      side: "long" as const,
      entryAtMs: 1_000,
      exitAtMs: 2_000,
      entryPrice: 100,
      exitPrice: 101,
      quantity: 1,
      grossPnlUsd: 1,
      feesUsd: 0.1,
      netPnlUsd: 0.9,
      exitReason: "take_profit" as const,
    };
    journal.append({ kind: "paper_trade", sessionId: "session-1", at: new Date(2_000).toISOString(), trade });
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "paper_trade", sessionId: "session-1", trade });
    expect(() => journal.append({ kind: "paper_trade", sessionId: "", at: "bad-date", trade })).toThrow("valid session ID and timestamp");
    expect(lines).toHaveLength(1);
  });
});
