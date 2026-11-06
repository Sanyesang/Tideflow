import { describe, expect, it, vi } from "vitest";
import { OkxPublicInstrumentClient } from "../src/adapters/okx_instruments.js";
import { quantizeSpotBuySize, quantizeSpotSellSize } from "../src/execution/spot_sizing.js";
import { parseSpotCurrencyBalance, parseSpotCurrencyBalanceExact } from "../src/execution/spot_balance.js";

const instrument = { instId: "BTC-USDT", baseCcy: "BTC", quoteCcy: "USDT", lotSz: "0.0001", minSz: "0.0001", tickSz: "0.1", state: "live" as const };

describe("OKX spot specifications and exact size quantization", () => {
  it("reads only active spot instruments from the explicitly supplied regional origin", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: "0", data: [{
      instId: "BTC-USDT", instType: "SPOT", state: "live", baseCcy: "BTC", quoteCcy: "USDT",
      lotSz: "0.0001", minSz: "0.0001", tickSz: "0.1",
    }] }), { status: 200 }));
    const client = new OkxPublicInstrumentClient("https://region.example.test", fetcher);
    await expect(client.getSpotInstrument("BTC-USDT")).resolves.toEqual(instrument);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("instType=SPOT");
  });

  it("rounds base size down exactly and rejects sizes below minimum", () => {
    expect(quantizeSpotBuySize("100", "60000", instrument)).toBe("0.0016");
    expect(quantizeSpotBuySize("100", "100", { ...instrument, lotSz: "0.03", minSz: "0.03" })).toBe("0.99");
    expect(() => quantizeSpotBuySize("1", "60000", instrument)).toThrow("below the exchange minimum");
  });

  it("rounds sell size down without exceeding the available base balance", () => {
    expect(quantizeSpotSellSize("0.00379", instrument)).toBe("0.0037");
    expect(() => quantizeSpotSellSize("0.00009", instrument)).toThrow("below the exchange minimum sell size");
  });

  it("reads a currency balance strictly and treats an absent row as zero", () => {
    expect(parseSpotCurrencyBalance([{ details: [
      { ccy: "USDT", availBal: "50.5", frozenBal: "0", eq: "50.5" },
      { ccy: "BTC", availBal: "0", frozenBal: "0", eq: "0" },
    ] }], "USDT")).toEqual({ currency: "USDT", available: 50.5, frozen: 0, equity: 50.5 });
    expect(parseSpotCurrencyBalance([{ details: [] }], "BTC")).toEqual({ currency: "BTC", available: 0, frozen: 0, equity: 0 });
    expect(parseSpotCurrencyBalanceExact([{ details: [
      { ccy: "BTC", availBal: "0.99000001", frozenBal: "0", eq: "0.99000001" },
    ] }], "BTC").available).toBe("0.99000001");
  });

  it("fails closed on malformed or duplicate currency rows", () => {
    expect(() => parseSpotCurrencyBalance([{ details: [{ ccy: "BTC", availBal: "0", frozenBal: "0" }] }], "BTC"))
      .toThrow("eq is missing or invalid");
    expect(() => parseSpotCurrencyBalance([{ details: [
      { ccy: "BTC", availBal: "0", frozenBal: "0", eq: "0" },
      { ccy: "BTC", availBal: "0", frozenBal: "0", eq: "0" },
    ] }], "BTC")).toThrow("duplicate balance rows");
  });
});
