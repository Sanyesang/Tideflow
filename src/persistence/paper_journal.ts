import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PaperSessionReport } from "../runtime/paper_runtime.js";
import type { PaperTrade } from "../paper/paper_broker.js";

export type PaperJournalEvent =
  | { kind: "paper_trade"; sessionId: string; at: string; trade: PaperTrade }
  | { kind: "paper_session_report"; sessionId: string; at: string; report: PaperSessionReport };

export interface PaperJournalStorage {
  appendLine(line: string): void;
}

/** Local append-only JSONL store; no credentials or exchange order payloads belong here. */
export class FilePaperJournalStorage implements PaperJournalStorage {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  appendLine(line: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${line}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

export class PaperJournal {
  constructor(private readonly storage: PaperJournalStorage) {}

  append(event: PaperJournalEvent): void {
    if (!event.sessionId.trim() || !Number.isFinite(Date.parse(event.at))) {
      throw new Error("Refusing to append a paper journal event without a valid session ID and timestamp.");
    }
    if (event.kind === "paper_trade") {
      const trade = event.trade;
      if (![trade.entryAtMs, trade.exitAtMs, trade.entryPrice, trade.exitPrice, trade.quantity, trade.grossPnlUsd, trade.feesUsd, trade.netPnlUsd]
        .every(Number.isFinite) || trade.entryPrice <= 0 || trade.exitPrice <= 0 || trade.quantity <= 0 || trade.feesUsd < 0) {
        throw new Error("Refusing to append an invalid paper trade.");
      }
    } else if (event.kind === "paper_session_report") {
      const report = event.report;
      if (!report.instrumentId.trim() || !Number.isFinite(report.initialBalanceUsd) || report.initialBalanceUsd <= 0
        || ![report.cashBalanceUsd, report.realizedCashChangeUsd, report.unrealizedGrossPnlUsd, report.endingEquityUsd,
          report.totalFeesUsd, report.closedTradeNetPnlUsd, report.winRatePct].every(Number.isFinite)
        || report.closedTradeCount < 0 || report.wins < 0 || report.wins > report.closedTradeCount) {
        throw new Error("Refusing to append an invalid paper session report.");
      }
    } else {
      throw new Error("Refusing to append an unknown paper journal event.");
    }
    this.storage.appendLine(JSON.stringify(event));
  }
}
