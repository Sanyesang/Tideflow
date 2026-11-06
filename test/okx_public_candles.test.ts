import { describe, expect, it, vi } from "vitest";
import { candlesToCsv, OkxPublicCandleClient } from "../src/adapters/okx_public_candles.js";

function row(timestamp: number, confirm = "1") {
  return [String(timestamp), "100", "102", "99", "101", "12.5", "0", "0", confirm];
}

describe("OKX public candle adapter", () => {
  it("paginates backward, excludes unconfirmed bars and returns strict chronological CSV", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "0", data: [row(3_000), row(2_000), row(1_000, "0")] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "0", data: [row(2_000 - 1), row(1_000 - 1)] }), { status: 200 }));
    const client = new OkxPublicCandleClient({ restBaseUrl: "https://region.example.test", fetcher, sleep: async () => undefined });
    const candles = await client.getHistory({ instId: "BTC-USDT", bar: "1m", limit: 4 });
    expect(candles.map((candle) => candle.timestampMs)).toEqual([999, 1_999, 2_000, 3_000]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/v5/market/history-candles?");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("after=2000");
    expect(candlesToCsv(candles)).toContain("timestamp,open,high,low,close,volume");
  });

  it("rejects cursor loops and invalid endpoint origins before network access", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "0", data: [row(2_000), row(1_000)] }), { status: 200 }));
    const client = new OkxPublicCandleClient({ restBaseUrl: "https://region.example.test", fetcher, sleep: async () => undefined });
    await expect(client.getHistory({ instId: "BTC-USDT", bar: "1m", limit: 12 })).rejects.toThrow("pagination did not move backward");
    expect(() => new OkxPublicCandleClient({ restBaseUrl: "http://region.example.test", fetcher })).toThrow("HTTPS origin");
  });
});
