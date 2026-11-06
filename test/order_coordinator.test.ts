import { describe, expect, it, vi } from "vitest";
import { OkxExecutionClient } from "../src/adapters/okx_execution.js";
import { OkxOrderCoordinator } from "../src/execution/order_coordinator.js";
import { TradeJournal, type JournalStorage } from "../src/persistence/trade_journal.js";

class MemoryJournalStorage implements JournalStorage {
  private lines: string[] = [];

  async appendLine(line: string): Promise<void> {
    this.lines.push(line);
  }

  async readText(): Promise<string> {
    return this.lines.join("\n");
  }
}

function makeClient() {
  return new OkxExecutionClient({
    environment: "demo",
    restBaseUrl: "https://region.example.test",
    credentials: { apiKey: "test-key", secretKey: "test-secret", passphrase: "test-pass" },
  });
}

const order = { instId: "BTC-USDT", tdMode: "cash" as const, side: "buy" as const, ordType: "market" as const, sz: "0.001" };

describe("durable order coordination", () => {
  it("performs spot startup preflight with read-only requests and records the reconciliation", async () => {
    const storage = new MemoryJournalStorage();
    const journal = new TradeJournal(storage);
    const coordinator = new OkxOrderCoordinator(makeClient(), journal);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.method ?? "GET").toBe("GET");
      if (url.pathname === "/api/v5/account/config") return new Response(JSON.stringify({ code: "0", data: [{ acctLv: "2" }] }));
      if (url.pathname === "/api/v5/account/balance") return new Response(JSON.stringify({ code: "0", data: [{ details: [
        { ccy: "USDT", availBal: "50", frozenBal: "0", eq: "50" },
        { ccy: "BTC", availBal: "0", frozenBal: "0", eq: "0" },
      ] }] }));
      if (url.pathname === "/api/v5/trade/orders-pending") return new Response(JSON.stringify({ code: "0", data: [] }));
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(coordinator.assertSafeSpotStartup("BTC-USDT", "BTC", "USDT"))
      .resolves.toEqual({ quoteAvailable: 50, quoteEquity: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await journal.readEvents()).at(-1)).toMatchObject({ kind: "account_reconciliation", instId: "BTC-USDT", outcome: "flat" });
  });

  it("writes an intent before submission and keeps unknown transport outcomes unresolved", async () => {
    const storage = new MemoryJournalStorage();
    const journal = new TradeJournal(storage);
    const coordinator = new OkxOrderCoordinator(makeClient(), journal);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network lost"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(coordinator.submit(order)).rejects.toMatchObject({ name: "OkxUnknownOrderOutcomeError" });
    const events = await journal.readEvents();
    expect(events.map((event) => event.kind)).toEqual(["order_intent", "order_outcome"]);
    expect(await journal.getUnresolvedOrderIntents()).toHaveLength(1);
    await expect(journal.assertNoUnresolvedOrders()).rejects.toThrow("remain unresolved");
    expect(await storage.readText()).not.toContain("test-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit exchange reconciliation to clear an accepted intent", async () => {
    const storage = new MemoryJournalStorage();
    const journal = new TradeJournal(storage);
    const client = makeClient();
    const coordinator = new OkxOrderCoordinator(client, journal);
    let fetchCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      fetchCount += 1;
      let data: Array<Record<string, string>>;
      if (fetchCount === 1) {
        data = [{ ordId: "exchange-1", sCode: "0" }];
      } else {
        const intent = (await journal.readEvents()).find((event) => event.kind === "order_intent");
        if (!intent || intent.kind !== "order_intent") throw new Error("Expected a journaled client order ID.");
        data = [{ ordId: "exchange-1", instId: "BTC-USDT", clOrdId: intent.clientOrderId, state: "filled", accFillSz: "0.001" }];
      }
      return new Response(JSON.stringify({ code: "0", msg: "", data }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const submitted = await coordinator.submit(order);
    expect(await journal.getUnresolvedOrderIntents()).toHaveLength(1);
    await coordinator.reconcile(submitted.prepared.clientOrderId, order.instId);
    await journal.assertNoUnresolvedOrders();
    expect(await journal.getUnresolvedOrderIntents()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an order unresolved when a lookup response is incomplete or mismatched", async () => {
    const storage = new MemoryJournalStorage();
    const journal = new TradeJournal(storage);
    const client = makeClient();
    const coordinator = new OkxOrderCoordinator(client, journal);
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ code: "0", msg: "", data: [{ ordId: "exchange-2", sCode: "0" }] }));
      return new Response(JSON.stringify({ code: "0", msg: "", data: [{
        ordId: "exchange-2", instId: "BTC-USDT", clOrdId: "different-order", state: "filled", accFillSz: "0.001",
      }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const submitted = await coordinator.submit(order);
    await expect(coordinator.reconcile(submitted.prepared.clientOrderId, order.instId)).rejects.toThrow("complete, matching exchange state");
    await expect(journal.assertNoUnresolvedOrders()).rejects.toThrow("remain unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks trading when the append-only journal contains corrupt data", async () => {
    const storage = new MemoryJournalStorage();
    await storage.appendLine("not-json");
    const journal = new TradeJournal(storage);
    await expect(journal.readEvents()).rejects.toThrow("corrupt");
  });
});
