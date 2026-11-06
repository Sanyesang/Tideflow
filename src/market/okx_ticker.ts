export type OkxTicker = {
  instId: string;
  last: number;
  bid: number;
  ask: number;
  exchangeTimestampMs: number;
  receivedAtMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Converts the documented OKX `tickers` WebSocket payload to validated ticks. */
export function parseOkxTickerMessage(message: unknown, receivedAtMs = Date.now()): OkxTicker[] {
  if (!isRecord(message) || !isRecord(message.arg) || message.arg.channel !== "tickers" || !Array.isArray(message.data)) return [];
  const tickers: OkxTicker[] = [];
  for (const row of message.data) {
    if (!isRecord(row) || typeof row.instId !== "string") continue;
    const last = positiveNumber(row.last);
    const bid = positiveNumber(row.bidPx);
    const ask = positiveNumber(row.askPx);
    const exchangeTimestampMs = Number(row.ts);
    if (!last || !bid || !ask || ask < bid || !Number.isSafeInteger(exchangeTimestampMs) || exchangeTimestampMs <= 0) continue;
    tickers.push({ instId: row.instId, last, bid, ask, exchangeTimestampMs, receivedAtMs });
  }
  return tickers;
}
