import {
  OkxExecutionClient,
  OkxUnknownOrderOutcomeError,
  type OkxPlaceOrder,
  type PreparedOkxOrder,
} from "../adapters/okx_execution.js";
import { TradeJournal } from "../persistence/trade_journal.js";

function recordField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null || !(field in value)) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

export class OkxOrderCoordinator {
  constructor(
    private readonly client: OkxExecutionClient,
    private readonly journal: TradeJournal,
  ) {}

  /** Journal the durable intent before the one permitted network submission. */
  async submit(order: OkxPlaceOrder): Promise<{ prepared: PreparedOkxOrder; result: unknown }> {
    return this.submitPrepared(this.client.prepareOrder(order));
  }

  /** Same durable boundary for callers that must retain the ID if a write fails. */
  async submitPrepared(prepared: PreparedOkxOrder): Promise<{ prepared: PreparedOkxOrder; result: unknown }> {
    await this.journal.append({
      kind: "order_intent",
      at: new Date().toISOString(),
      environment: this.client.configuredEnvironment,
      clientOrderId: prepared.clientOrderId,
      instId: prepared.order.instId,
      side: prepared.order.side,
      ordType: prepared.order.ordType,
      size: prepared.order.sz,
    });

    let result: unknown;
    try {
      result = await this.client.submitPreparedOrder(prepared);
    } catch (error) {
      if (error instanceof OkxUnknownOrderOutcomeError) {
        await this.journal.append({
          kind: "order_outcome",
          at: new Date().toISOString(),
          clientOrderId: prepared.clientOrderId,
          outcome: "unknown",
        });
      } else {
        await this.journal.append({
          kind: "order_outcome",
          at: new Date().toISOString(),
          clientOrderId: prepared.clientOrderId,
          outcome: "rejected",
        });
      }
      throw error;
    }

    // If this durable write fails, the earlier intent remains unresolved on
    // disk and startup will block until the order is reconciled.
    const acknowledgedOrderId = recordField(result, "ordId");
    await this.journal.append({
      kind: "order_outcome",
      at: new Date().toISOString(),
      clientOrderId: prepared.clientOrderId,
      outcome: "accepted",
      ...(acknowledgedOrderId ? { orderId: acknowledgedOrderId } : {}),
    });
    return { prepared, result };
  }

  /** Query an existing order after an uncertain submission; never resubmits. */
  async reconcile(clientOrderId: string, instId: string): Promise<unknown> {
    const order = await this.client.getOrder({ clOrdId: clientOrderId, instId });
    const returnedClientOrderId = recordField(order, "clOrdId");
    const returnedInstId = recordField(order, "instId");
    const state = recordField(order, "state");
    const orderId = recordField(order, "ordId");
    const filledSize = recordField(order, "accFillSz");
    const recognizedStates = ["live", "partially_filled", "filled", "canceled", "mmp_canceled"] as const;
    if (returnedClientOrderId !== clientOrderId || returnedInstId !== instId || !orderId
      || !filledSize || !/^(?:0|\d+(?:\.\d+)?)$/.test(filledSize)
      || !state || !recognizedStates.includes(state as (typeof recognizedStates)[number])
      || (state === "filled" && Number(filledSize) <= 0)) {
      await this.journal.append({
        kind: "order_reconciliation",
        at: new Date().toISOString(),
        clientOrderId,
        exchangeState: "not_found",
      });
      throw new Error("Order lookup did not establish a complete, matching exchange state and cumulative fill size; keep trading stopped and investigate.");
    }
    await this.journal.append({
      kind: "order_reconciliation",
      at: new Date().toISOString(),
      clientOrderId,
      exchangeState: state as (typeof recognizedStates)[number],
      ...(orderId ? { orderId } : {}),
      ...(filledSize ? { filledSize } : {}),
    });
    return order;
  }

  /** Only permits startup after a flat exchange snapshot and a clean local ledger. */
  async assertSafeStartup(instType: string, instId: string): Promise<void> {
    await this.client.reconcileFlatStartup(instType, instId);
    await this.journal.assertNoUnresolvedOrders();
    await this.journal.append({
      kind: "account_reconciliation",
      at: new Date().toISOString(),
      instId,
      outcome: "flat",
    });
  }

  /** Spot-specific flat check: existing base assets or open orders block startup. */
  async assertSafeSpotStartup(instId: string, baseCcy: string, quoteCcy: string): Promise<{
    quoteAvailable: number;
    quoteEquity: number;
  }> {
    const snapshot = await this.client.reconcileFlatSpotStartup(instId, baseCcy, quoteCcy);
    await this.journal.assertNoUnresolvedOrders();
    await this.journal.append({
      kind: "account_reconciliation",
      at: new Date().toISOString(),
      instId,
      outcome: "flat",
    });
    return { quoteAvailable: snapshot.quoteBalance.available, quoteEquity: snapshot.quoteBalance.equity };
  }
}
