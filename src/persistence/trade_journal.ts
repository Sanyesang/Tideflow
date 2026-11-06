import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type OrderJournalEvent =
  | {
      kind: "order_intent";
      at: string;
      environment: "demo" | "live";
      clientOrderId: string;
      instId: string;
      side: "buy" | "sell";
      ordType: string;
      size: string;
    }
  | {
      kind: "order_outcome";
      at: string;
      clientOrderId: string;
      outcome: "accepted" | "rejected" | "unknown";
      orderId?: string;
      apiCode?: string;
    }
  | {
      kind: "order_reconciliation";
      at: string;
      clientOrderId: string;
      exchangeState: "live" | "partially_filled" | "filled" | "canceled" | "mmp_canceled" | "not_found";
      orderId?: string;
      filledSize?: string;
    }
  | {
      kind: "account_reconciliation";
      at: string;
      instId: string;
      outcome: "flat" | "exposure_found";
    }
  | {
      kind: "spot_position_open";
      at: string;
      instId: string;
      clientOrderId: string;
      orderId: string;
      baseSize: string;
      entryPrice: string;
      entryCostQuote: string;
      quoteCcy: string;
    }
  | {
      kind: "spot_trade_closed";
      at: string;
      instId: string;
      entryClientOrderId: string;
      exitClientOrderId: string;
      baseSize: string;
      entryPrice: string;
      exitPrice: string;
      realizedPnlQuote: string;
      quoteCcy: string;
    };

export interface JournalStorage {
  appendLine(line: string): Promise<void>;
  readText(): Promise<string>;
}

export class FileJournalStorage implements JournalStorage {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async appendLine(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file = await open(this.path, "a", 0o600);
    try {
      await file.writeFile(`${line}\n`, { encoding: "utf8" });
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async readText(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }
}

function isOrderJournalEvent(value: unknown): value is OrderJournalEvent {
  if (typeof value !== "object" || value === null || !("kind" in value) || !("at" in value)) return false;
  const candidate = value as { kind: unknown; at: unknown };
  if (typeof candidate.at !== "string" || !Number.isFinite(Date.parse(candidate.at))) return false;
  if (candidate.kind === "order_intent") {
    const event = value as Partial<Extract<OrderJournalEvent, { kind: "order_intent" }>>;
    return typeof event.clientOrderId === "string" && typeof event.instId === "string"
      && (event.environment === "demo" || event.environment === "live")
      && (event.side === "buy" || event.side === "sell") && typeof event.size === "string";
  }
  if (candidate.kind === "order_outcome") {
    const event = value as Partial<Extract<OrderJournalEvent, { kind: "order_outcome" }>>;
    return typeof event.clientOrderId === "string" && ["accepted", "rejected", "unknown"].includes(String(event.outcome));
  }
  if (candidate.kind === "order_reconciliation") {
    const event = value as Partial<Extract<OrderJournalEvent, { kind: "order_reconciliation" }>>;
    return typeof event.clientOrderId === "string"
      && ["live", "partially_filled", "filled", "canceled", "mmp_canceled", "not_found"].includes(String(event.exchangeState));
  }
  if (candidate.kind === "account_reconciliation") {
    const event = value as Partial<Extract<OrderJournalEvent, { kind: "account_reconciliation" }>>;
    return typeof event.instId === "string" && ["flat", "exposure_found"].includes(String(event.outcome));
  }
  if (candidate.kind === "spot_position_open") {
    const event = value as Partial<Extract<OrderJournalEvent, { kind: "spot_position_open" }>>;
    return typeof event.instId === "string" && typeof event.clientOrderId === "string" && typeof event.orderId === "string"
      && typeof event.quoteCcy === "string"
      && [event.baseSize, event.entryPrice, event.entryCostQuote].every((field) => typeof field === "string" && /^\d+(?:\.\d+)?$/.test(field) && Number(field) > 0);
  }
  if (candidate.kind === "spot_trade_closed") {
    const event = value as Partial<Extract<OrderJournalEvent, { kind: "spot_trade_closed" }>>;
    return typeof event.instId === "string" && typeof event.entryClientOrderId === "string" && typeof event.exitClientOrderId === "string"
      && typeof event.quoteCcy === "string"
      && [event.baseSize, event.entryPrice, event.exitPrice].every((field) => typeof field === "string" && /^\d+(?:\.\d+)?$/.test(field) && Number(field) > 0)
      && typeof event.realizedPnlQuote === "string" && /^-?\d+(?:\.\d+)?$/.test(event.realizedPnlQuote) && Number.isFinite(Number(event.realizedPnlQuote));
  }
  return false;
}

export class TradeJournal {
  constructor(private readonly storage: JournalStorage) {}

  async append(event: OrderJournalEvent): Promise<void> {
    if (!isOrderJournalEvent(event)) throw new Error("Refusing to append an invalid journal event.");
    await this.storage.appendLine(JSON.stringify(event));
  }

  async readEvents(): Promise<OrderJournalEvent[]> {
    const text = await this.storage.readText();
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    return lines.map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Journal is corrupt at line ${index + 1}; automated trading must remain stopped.`);
      }
      if (!isOrderJournalEvent(value)) throw new Error(`Journal event is invalid at line ${index + 1}; automated trading must remain stopped.`);
      return value;
    });
  }

  async getUnresolvedOrderIntents(): Promise<Array<Extract<OrderJournalEvent, { kind: "order_intent" }>>> {
    const events = await this.readEvents();
    const intents = new Map<string, Extract<OrderJournalEvent, { kind: "order_intent" }>>();
    const resolved = new Set<string>();
    for (const event of events) {
      if (event.kind === "order_intent") {
        if (intents.has(event.clientOrderId)) throw new Error("Journal contains a duplicate clientOrderId; automated trading must remain stopped.");
        intents.set(event.clientOrderId, event);
      }
      if ((event.kind === "order_outcome" || event.kind === "order_reconciliation") && !intents.has(event.clientOrderId)) {
        throw new Error("Journal contains an order event without a preceding intent; automated trading must remain stopped.");
      }
      if (event.kind === "order_outcome" && event.outcome === "rejected") resolved.add(event.clientOrderId);
      if (event.kind === "order_reconciliation"
        && ["filled", "canceled", "mmp_canceled"].includes(event.exchangeState)) resolved.add(event.clientOrderId);
      if (event.kind === "order_reconciliation" && ["live", "partially_filled", "not_found"].includes(event.exchangeState)) {
        resolved.delete(event.clientOrderId);
      }
    }
    return [...intents.entries()].filter(([clientOrderId]) => !resolved.has(clientOrderId)).map(([, intent]) => intent);
  }

  async assertNoUnresolvedOrders(): Promise<void> {
    const unresolved = await this.getUnresolvedOrderIntents();
    if (unresolved.length > 0) {
      throw new Error(`${unresolved.length} order intent(s) remain unresolved in the journal; reconcile manually before trading.`);
    }
  }
}
