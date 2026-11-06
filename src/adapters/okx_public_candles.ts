import type { Candle } from "../backtest/csv_candles.js";

export const OKX_CANDLE_BARS = [
  "1s", "1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H",
  "1D", "2D", "3D", "1W", "1M", "3M", "6Hutc", "12Hutc", "1Dutc", "2Dutc", "3Dutc", "1Wutc", "1Mutc", "3Mutc",
] as const;

export type OkxCandleBar = typeof OKX_CANDLE_BARS[number];

export type OkxPublicCandleOptions = {
  /** Region-appropriate HTTPS REST origin supplied by the operator. */
  restBaseUrl: string;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type OkxCandleEnvelope = { code?: unknown; msg?: unknown; data?: unknown };

function validateOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("restBaseUrl must be an explicit HTTPS origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function parseCandleRow(row: unknown): Candle | undefined {
  if (!Array.isArray(row) || row.length < 9 || row[8] !== "1") return undefined;
  const values = row.slice(0, 6).map((value) => Number(value));
  const [timestampMs, open, high, low, close, volume] = values;
  if (![timestampMs, open, high, low, close, volume].every(Number.isFinite)
    || !Number.isSafeInteger(timestampMs) || timestampMs! <= 0
    || open! <= 0 || high! <= 0 || low! <= 0 || close! <= 0 || volume! < 0
    || high! < Math.max(open!, close!, low!) || low! > Math.min(open!, close!)) {
    throw new Error("OKX returned an invalid confirmed candle; refusing to export partial or malformed market data.");
  }
  return { timestampMs: timestampMs!, open: open!, high: high!, low: low!, close: close!, volume: volume! };
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Fetches confirmed public history only. Sequential pagination stays below the documented 20 requests / 2s limit. */
export class OkxPublicCandleClient {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: OkxPublicCandleOptions) {
    this.origin = validateOrigin(options.restBaseUrl);
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getHistory(input: { instId: string; bar: OkxCandleBar; limit: number }): Promise<Candle[]> {
    const instId = input.instId.trim();
    if (!instId || !/^[A-Z0-9]+(?:-[A-Z0-9]+){1,2}$/.test(instId)) throw new Error("instId must be a valid uppercase OKX instrument ID.");
    if (!(OKX_CANDLE_BARS as readonly string[]).includes(input.bar)) throw new Error("Unsupported OKX candle bar.");
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50_000) throw new Error("limit must be an integer from 1 to 50,000.");

    const candlesByTimestamp = new Map<number, Candle>();
    let cursor: number | undefined;
    let previousRequestAt = 0;
    const maxPages = Math.ceil(input.limit / 300) + 2;
    for (let page = 0; page < maxPages && candlesByTimestamp.size < input.limit; page += 1) {
      const elapsed = Date.now() - previousRequestAt;
      if (previousRequestAt > 0 && elapsed < 150) await this.sleep(150 - elapsed);
      previousRequestAt = Date.now();

      const params = new URLSearchParams({ instId, bar: input.bar, limit: "300" });
      if (cursor !== undefined) params.set("after", String(cursor));
      const response = await this.fetcher(`${this.origin}/api/v5/market/history-candles?${params.toString()}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`OKX public candle request failed with HTTP ${response.status}.`);
      let envelope: OkxCandleEnvelope;
      try {
        envelope = await response.json() as OkxCandleEnvelope;
      } catch {
        throw new Error("OKX public candle endpoint returned invalid JSON.");
      }
      if (envelope.code !== "0" || !Array.isArray(envelope.data)) {
        throw new Error(`OKX public candle request was rejected (code ${String(envelope.code ?? "unknown")}).`);
      }
      if (envelope.data.length === 0) break;

      const pageCandles = envelope.data.map(parseCandleRow).filter((candle): candle is Candle => candle !== undefined);
      if (pageCandles.length === 0) break;
      const oldestTimestamp = Math.min(...pageCandles.map((candle) => candle.timestampMs));
      if (cursor !== undefined && oldestTimestamp >= cursor) {
        throw new Error("OKX candle pagination did not move backward; refusing to return a silently truncated dataset.");
      }
      for (const candle of pageCandles) candlesByTimestamp.set(candle.timestampMs, candle);
      cursor = oldestTimestamp;
    }

    const candles = [...candlesByTimestamp.values()].sort((a, b) => a.timestampMs - b.timestampMs).slice(-input.limit);
    if (candles.length === 0) throw new Error("OKX returned no confirmed candles for the requested dataset.");
    for (let index = 1; index < candles.length; index += 1) {
      if (candles[index]!.timestampMs <= candles[index - 1]!.timestampMs) throw new Error("OKX candles are not strictly chronological after pagination.");
    }
    return candles;
  }
}

export function candlesToCsv(candles: Candle[]): string {
  if (candles.length === 0) throw new Error("Cannot export an empty candle dataset.");
  return `timestamp,open,high,low,close,volume\n${candles.map((candle) =>
    [candle.timestampMs, candle.open, candle.high, candle.low, candle.close, candle.volume].join(","),
  ).join("\n")}\n`;
}
