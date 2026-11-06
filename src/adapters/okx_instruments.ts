export type OkxSpotInstrument = {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  lotSz: string;
  minSz: string;
  tickSz: string;
  state: "live";
};

type InstrumentEnvelope = { code?: unknown; data?: unknown };

function decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new Error(`OKX instrument ${field} is missing or invalid.`);
  }
  return value;
}

/** Reads public SPOT size/price filters; it never submits orders. */
export class OkxPublicInstrumentClient {
  private readonly origin: string;

  constructor(restBaseUrl: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(restBaseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      throw new Error("restBaseUrl must be an explicit HTTPS origin without credentials, path, query, or fragment.");
    }
    this.origin = url.origin;
  }

  async getSpotInstrument(instId: string): Promise<OkxSpotInstrument> {
    const normalized = instId.trim();
    if (!/^[A-Z0-9]+-[A-Z0-9]+$/.test(normalized)) throw new Error("Spot instrument ID must look like BTC-USDT.");
    const params = new URLSearchParams({ instType: "SPOT", instId: normalized });
    const response = await this.fetcher(`${this.origin}/api/v5/public/instruments?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OKX instrument request failed with HTTP ${response.status}.`);
    let envelope: InstrumentEnvelope;
    try {
      envelope = await response.json() as InstrumentEnvelope;
    } catch {
      throw new Error("OKX instrument endpoint returned invalid JSON.");
    }
    if (envelope.code !== "0" || !Array.isArray(envelope.data)) {
      throw new Error(`OKX instrument request was rejected (code ${String(envelope.code ?? "unknown")}).`);
    }
    const row = envelope.data.find((item) => typeof item === "object" && item !== null && "instId" in item && item.instId === normalized);
    if (typeof row !== "object" || row === null) throw new Error(`OKX did not return instrument metadata for ${normalized}.`);
    const value = row as Record<string, unknown>;
    if (value.instType !== "SPOT" || value.state !== "live") throw new Error(`Instrument ${normalized} is not live SPOT; trading must remain stopped.`);
    for (const field of ["baseCcy", "quoteCcy"] as const) {
      if (typeof value[field] !== "string" || !/^[A-Z0-9]+$/.test(value[field])) throw new Error(`OKX instrument ${field} is invalid.`);
    }
    return {
      instId: normalized,
      baseCcy: value.baseCcy as string,
      quoteCcy: value.quoteCcy as string,
      lotSz: decimal(value.lotSz, "lotSz"),
      minSz: decimal(value.minSz, "minSz"),
      tickSz: decimal(value.tickSz, "tickSz"),
      state: "live",
    };
  }
}
