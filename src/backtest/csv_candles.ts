export type Candle = {
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const requiredHeaders = ["timestamp", "open", "high", "low", "close", "volume"] as const;

function parseTimestamp(value: string, lineNumber: number): number {
  const trimmed = value.trim();
  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(`Invalid timestamp on CSV line ${lineNumber}. Use epoch milliseconds or ISO-8601.`);
  }
  return numeric;
}

function parseNumber(value: string, field: string, lineNumber: number, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`Invalid ${field} on CSV line ${lineNumber}.`);
  }
  return parsed;
}

/** Parses plain six-column OHLCV CSV without silently sorting or repairing data. */
export function parseCandleCsv(csv: string): Candle[] {
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) throw new Error("CSV must contain a header and at least one candle.");
  const headers = lines[0]!.split(",").map((header) => header.trim().toLowerCase());
  if (requiredHeaders.some((header) => !headers.includes(header)) || headers.length !== requiredHeaders.length) {
    throw new Error(`CSV header must contain exactly: ${requiredHeaders.join(",")}.`);
  }
  const index = Object.fromEntries(headers.map((header, position) => [header, position])) as Record<(typeof requiredHeaders)[number], number>;

  const candles = lines.slice(1).map((line, offset) => {
    const lineNumber = offset + 2;
    const columns = line.split(",");
    if (columns.length !== headers.length) throw new Error(`Wrong column count on CSV line ${lineNumber}.`);
    const candle: Candle = {
      timestampMs: parseTimestamp(columns[index.timestamp]!, lineNumber),
      open: parseNumber(columns[index.open]!, "open", lineNumber),
      high: parseNumber(columns[index.high]!, "high", lineNumber),
      low: parseNumber(columns[index.low]!, "low", lineNumber),
      close: parseNumber(columns[index.close]!, "close", lineNumber),
      volume: parseNumber(columns[index.volume]!, "volume", lineNumber, true),
    };
    if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close)) {
      throw new Error(`OHLC values are inconsistent on CSV line ${lineNumber}.`);
    }
    return candle;
  });

  for (let i = 1; i < candles.length; i += 1) {
    if (candles[i]!.timestampMs <= candles[i - 1]!.timestampMs) {
      throw new Error(`Candles must be strictly chronological; problem at CSV line ${i + 2}.`);
    }
  }
  return candles;
}
