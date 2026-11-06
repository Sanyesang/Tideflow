/**
 * Minimal signed OKX REST adapter.
 *
 * No endpoint is guessed and no request is made during import or construction.
 * Credentials are supplied in memory by the caller and are never persisted or
 * written to logs. Live order-changing calls require an explicit opt-in.
 */

import { createHmac, randomBytes } from "node:crypto";
import { parseSpotCurrencyBalance, type SpotCurrencyBalance } from "../execution/spot_balance.js";

export type OkxEnvironment = "demo" | "live";
export type OkxSide = "buy" | "sell";
export type OkxOrderType = "market" | "limit" | "post_only" | "fok" | "ioc";
export type OkxTradeMode = "cash" | "cross" | "isolated";

export type OkxCredentials = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
};

export type OkxExecutionOptions = {
  environment: OkxEnvironment;
  /** Explicit region-appropriate HTTPS REST origin, without a path or query. */
  restBaseUrl: string;
  credentials: OkxCredentials;
  /** Required to permit order placement/cancellation on a live account. */
  allowLiveTrading?: boolean;
};

export type OkxPlaceOrder = {
  instId: string;
  tdMode: OkxTradeMode;
  side: OkxSide;
  ordType: OkxOrderType;
  /** Decimal string to avoid floating-point quantity rounding. */
  sz: string;
  /** Required for limit-style order types. */
  px?: string;
  clOrdId?: string;
  reduceOnly?: boolean;
  /** Only valid for cash market orders; pins size units to base or quote currency. */
  tgtCcy?: "base_ccy" | "quote_ccy";
  /** Only valid for cash market orders; reject instead of exchange size amendment. */
  banAmend?: boolean;
  /** Maximum allowed spot market-order slippage as a fraction (for example 0.005 = 0.5%). */
  slippagePct?: string;
};

export type PreparedOkxOrder = {
  clientOrderId: string;
  order: Omit<OkxPlaceOrder, "clOrdId"> & { clOrdId: string };
};

export class OkxUnknownOrderOutcomeError extends Error {
  readonly operation: "place" | "cancel";
  readonly instId: string;
  readonly clientOrderId: string | undefined;
  readonly orderId: string | undefined;

  constructor(context: { operation: "place" | "cancel"; instId: string; clientOrderId?: string; orderId?: string }, detail: string) {
    super(`OKX ${context.operation} outcome is unknown (${detail}); do not retry before querying and reconciling the order.`);
    this.name = "OkxUnknownOrderOutcomeError";
    this.operation = context.operation;
    this.instId = context.instId;
    this.clientOrderId = context.clientOrderId;
    this.orderId = context.orderId;
  }
}

type OkxEnvelope<T> = {
  code: string;
  msg: string;
  data: T[];
};

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function validatePositiveDecimal(value: string, field: string): string {
  const normalized = nonEmpty(value, field);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || !/[1-9]/.test(normalized)) {
    throw new Error(`${field} must be a positive decimal string.`);
  }
  return normalized;
}

function sign(secretKey: string, timestamp: string, method: string, requestPath: string, body: string): string {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
  return createHmac("sha256", secretKey).update(prehash, "utf8").digest("base64");
}

function validateOrder(order: OkxPlaceOrder): OkxPlaceOrder {
  const instId = nonEmpty(order.instId, "instId");
  const sz = validatePositiveDecimal(order.sz, "sz");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("side must be buy or sell.");
  if (!["cash", "cross", "isolated"].includes(order.tdMode)) throw new Error("Unsupported tdMode.");
  if (!["market", "limit", "post_only", "fok", "ioc"].includes(order.ordType)) {
    throw new Error("Unsupported ordType.");
  }

  const limitStyle = order.ordType !== "market";
  const px = order.px === undefined ? undefined : validatePositiveDecimal(order.px, "px");
  if (limitStyle && !px) throw new Error("px is required for limit-style orders.");
  if (order.tgtCcy !== undefined && (order.tdMode !== "cash" || order.ordType !== "market")) {
    throw new Error("tgtCcy is only supported for cash market orders.");
  }
  if (order.banAmend !== undefined && (typeof order.banAmend !== "boolean" || order.tdMode !== "cash" || order.ordType !== "market")) {
    throw new Error("banAmend is only supported as a boolean for cash market orders.");
  }
  if (order.slippagePct !== undefined) {
    if (order.tdMode !== "cash" || order.ordType !== "market") throw new Error("slippagePct is only supported for cash market orders.");
    if (!/^(?:0|0\.\d{1,4})$/.test(order.slippagePct) || Number(order.slippagePct) > 0.05) {
      throw new Error("slippagePct must be a decimal fraction from 0 to 0.05 with at most four decimal places.");
    }
  }
  if (order.clOrdId !== undefined && !/^[A-Za-z0-9]{1,32}$/.test(order.clOrdId)) {
    throw new Error("clOrdId must contain 1-32 ASCII letters or digits.");
  }

  return { ...order, instId, sz, ...(px === undefined ? {} : { px }) };
}

export class OkxExecutionClient {
  private readonly environment: OkxEnvironment;
  private readonly restBaseUrl: string;
  private readonly credentials: OkxCredentials;
  private readonly allowLiveTrading: boolean;
  private readonly attemptedClientOrderIds = new Set<string>();

  constructor(options: OkxExecutionOptions) {
    if (options.environment !== "demo" && options.environment !== "live") {
      throw new Error("environment must be explicitly set to demo or live.");
    }

    const baseUrl = new URL(options.restBaseUrl);
    if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || !["", "/"].includes(baseUrl.pathname)) {
      throw new Error("restBaseUrl must be an explicit HTTPS origin without credentials, path, query, or fragment.");
    }

    this.environment = options.environment;
    this.restBaseUrl = baseUrl.origin;
    this.credentials = {
      apiKey: nonEmpty(options.credentials.apiKey, "apiKey"),
      secretKey: nonEmpty(options.credentials.secretKey, "secretKey"),
      passphrase: nonEmpty(options.credentials.passphrase, "passphrase"),
    };
    this.allowLiveTrading = options.allowLiveTrading === true;
  }

  get configuredEnvironment(): OkxEnvironment {
    return this.environment;
  }

  async placeOrder(input: OkxPlaceOrder): Promise<unknown> {
    return this.submitPreparedOrder(this.prepareOrder(input));
  }

  /** Generates the order identity before transmission so callers can journal it first. */
  prepareOrder(input: OkxPlaceOrder): PreparedOkxOrder {
    const order = validateOrder(input);
    const clientOrderId = order.clOrdId ?? randomBytes(16).toString("hex");
    return { clientOrderId, order: { ...order, clOrdId: clientOrderId } };
  }

  /** Sends a prepared intent at most once per clientOrderId in this process. */
  async submitPreparedOrder(prepared: PreparedOkxOrder): Promise<unknown> {
    this.assertTradingAllowed();
    const order = validateOrder(prepared.order);
    if (order.clOrdId !== prepared.clientOrderId) throw new Error("Prepared order clientOrderId does not match its order payload.");
    if (this.attemptedClientOrderIds.has(prepared.clientOrderId)) {
      throw new Error("This clientOrderId has already been attempted in this process; reconcile it instead of resubmitting.");
    }
    this.attemptedClientOrderIds.add(prepared.clientOrderId);
    const body: Record<string, string> = {
      instId: order.instId,
      tdMode: order.tdMode,
      side: order.side,
      ordType: order.ordType,
      sz: order.sz,
    };
    if (order.px !== undefined) body.px = order.px;
    if (order.tgtCcy !== undefined) body.tgtCcy = order.tgtCcy;
    if (order.banAmend !== undefined) body.banAmend = String(order.banAmend);
    if (order.slippagePct !== undefined) body.slippagePct = order.slippagePct;
    body.clOrdId = prepared.clientOrderId;
    if (order.reduceOnly !== undefined) body.reduceOnly = String(order.reduceOnly);

    const acknowledgment = await this.request("POST", "/api/v5/trade/order", undefined, body, {
      operation: "place",
      instId: order.instId,
      clientOrderId: prepared.clientOrderId,
    });
    if (typeof acknowledgment === "object" && acknowledgment !== null) {
      return { ...(acknowledgment as Record<string, unknown>), clientOrderId: prepared.clientOrderId };
    }
    return { acknowledgment, clientOrderId: prepared.clientOrderId };
  }

  async cancelOrder(input: { instId: string; ordId?: string; clOrdId?: string }): Promise<unknown> {
    this.assertTradingAllowed();
    const instId = nonEmpty(input.instId, "instId");
    const ordId = input.ordId === undefined ? undefined : nonEmpty(input.ordId, "ordId");
    const clOrdId = input.clOrdId === undefined ? undefined : nonEmpty(input.clOrdId, "clOrdId");
    if (!ordId && !clOrdId) throw new Error("ordId or clOrdId is required.");
    return this.request("POST", "/api/v5/trade/cancel-order", undefined, {
      instId,
      ...(ordId ? { ordId } : {}),
      ...(clOrdId ? { clOrdId } : {}),
    }, { operation: "cancel", instId, ...(ordId ? { orderId: ordId } : {}), ...(clOrdId ? { clientOrderId: clOrdId } : {}) });
  }

  /** Read-only private query; live reads do not require the live-trading opt-in. */
  async getOrder(input: { instId: string; ordId?: string; clOrdId?: string }): Promise<unknown> {
    const instId = nonEmpty(input.instId, "instId");
    const params = new URLSearchParams({ instId });
    if (input.ordId) params.set("ordId", nonEmpty(input.ordId, "ordId"));
    if (input.clOrdId) params.set("clOrdId", nonEmpty(input.clOrdId, "clOrdId"));
    if (!input.ordId && !input.clOrdId) throw new Error("ordId or clOrdId is required.");
    return this.request("GET", "/api/v5/trade/order", params.toString());
  }

  async getAccountConfig(): Promise<unknown> {
    return this.request("GET", "/api/v5/account/config");
  }

  async getAccountBalance(ccy?: string): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (ccy) params.set("ccy", nonEmpty(ccy, "ccy"));
    return this.request("GET", "/api/v5/account/balance", params.size ? params.toString() : undefined, undefined, undefined, true) as Promise<unknown[]>;
  }

  async getPositions(filters: { instType?: string; instId?: string } = {}): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (filters.instType) params.set("instType", nonEmpty(filters.instType, "instType"));
    if (filters.instId) params.set("instId", nonEmpty(filters.instId, "instId"));
    return this.request("GET", "/api/v5/account/positions", params.size ? params.toString() : undefined, undefined, undefined, true) as Promise<unknown[]>;
  }

  /** OKX pending-order endpoint includes live and partially_filled orders. */
  async getPendingOrders(filters: { instType?: string; instId?: string } = {}): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (filters.instType) params.set("instType", nonEmpty(filters.instType, "instType"));
    if (filters.instId) params.set("instId", nonEmpty(filters.instId, "instId"));
    return this.request("GET", "/api/v5/trade/orders-pending", params.size ? params.toString() : undefined, undefined, undefined, true) as Promise<unknown[]>;
  }

  async getRecentFills(filters: { instType?: string; instId?: string; ordId?: string } = {}): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (filters.instType) params.set("instType", nonEmpty(filters.instType, "instType"));
    if (filters.instId) params.set("instId", nonEmpty(filters.instId, "instId"));
    if (filters.ordId) params.set("ordId", nonEmpty(filters.ordId, "ordId"));
    return this.request("GET", "/api/v5/trade/fills", params.size ? params.toString() : undefined, undefined, undefined, true) as Promise<unknown[]>;
  }

  /**
   * Read-only startup snapshot. It intentionally refuses to call an account
   * "clean" when existing positions or pending orders are present.
   */
  async reconcileFlatStartup(instType: string, instId: string): Promise<{
    accountConfig: unknown;
    balances: unknown[];
    positions: unknown[];
    pendingOrders: unknown[];
  }> {
    const [accountConfig, balances, positions, pendingOrders] = await Promise.all([
      this.getAccountConfig(),
      this.getAccountBalance(),
      this.getPositions({ instType, instId }),
      this.getPendingOrders({ instType, instId }),
    ]);
    const nonZeroPositions = positions.filter((entry) => {
      if (typeof entry !== "object" || entry === null || !("pos" in entry)) return true;
      const position = Number((entry as { pos: unknown }).pos);
      return !Number.isFinite(position) || position !== 0;
    });
    if (nonZeroPositions.length > 0 || pendingOrders.length > 0) {
      throw new Error("Startup reconciliation found an existing position or pending order; automation remains stopped for manual review.");
    }
    return { accountConfig, balances, positions, pendingOrders };
  }

  /**
   * Spot has no derivatives position to reconcile. Startup therefore requires
   * a zero holding of the traded base currency and no pending orders for the
   * instrument. Quote balance is returned for caller-side budget checks.
   */
  async reconcileFlatSpotStartup(instId: string, baseCcy: string, quoteCcy: string): Promise<{
    accountConfig: unknown;
    balances: unknown[];
    baseBalance: SpotCurrencyBalance;
    quoteBalance: SpotCurrencyBalance;
    pendingOrders: unknown[];
  }> {
    const [accountConfig, balances, pendingOrders] = await Promise.all([
      this.getAccountConfig(),
      this.getAccountBalance(),
      this.getPendingOrders({ instType: "SPOT", instId }),
    ]);
    const baseBalance = parseSpotCurrencyBalance(balances, baseCcy);
    const quoteBalance = parseSpotCurrencyBalance(balances, quoteCcy);
    if (baseBalance.available > 0 || baseBalance.frozen > 0 || baseBalance.equity > 0 || pendingOrders.length > 0) {
      throw new Error("Spot startup found an existing base-currency balance or pending order; automation remains stopped for manual review.");
    }
    return { accountConfig, balances, baseBalance, quoteBalance, pendingOrders };
  }

  private assertTradingAllowed(): void {
    if (this.environment === "live" && !this.allowLiveTrading) {
      throw new Error("Live order-changing calls are disabled; set allowLiveTrading: true explicitly to opt in.");
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    query?: string,
    payload?: Record<string, string>,
    uncertainContext?: { operation: "place" | "cancel"; instId: string; clientOrderId?: string; orderId?: string },
    returnAllData = false,
  ): Promise<unknown> {
    const requestPath = query ? `${path}?${query}` : path;
    const body = payload ? JSON.stringify(payload) : "";
    const timestamp = new Date().toISOString();
    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.credentials.apiKey,
      "OK-ACCESS-SIGN": sign(this.credentials.secretKey, timestamp, method, requestPath, body),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.credentials.passphrase,
    };
    if (body) headers["Content-Type"] = "application/json";
    if (this.environment === "demo") headers["x-simulated-trading"] = "1";

    let response: Response;
    try {
      response = await fetch(`${this.restBaseUrl}${requestPath}`, {
        method,
        headers,
        signal: AbortSignal.timeout(10_000),
        ...(body ? { body } : {}),
      });
    } catch {
      if (uncertainContext) throw new OkxUnknownOrderOutcomeError(uncertainContext, "transport failure");
      throw new Error("OKX REST transport failed.");
    }
    if (!response.ok) {
      if (uncertainContext && response.status >= 500) throw new OkxUnknownOrderOutcomeError(uncertainContext, `HTTP ${response.status}`);
      throw new Error(`OKX REST request failed with HTTP ${response.status}.`);
    }

    let result: OkxEnvelope<unknown>;
    try {
      result = await response.json() as OkxEnvelope<unknown>;
    } catch {
      if (uncertainContext) throw new OkxUnknownOrderOutcomeError(uncertainContext, "unparseable response");
      throw new Error("OKX REST returned an invalid JSON response.");
    }
    if (result?.code === "50004" && uncertainContext) throw new OkxUnknownOrderOutcomeError(uncertainContext, "OKX timeout 50004");
    if (!result || result.code !== "0") {
      throw new Error(`OKX REST request was rejected (code ${result?.code ?? "unknown"}).`);
    }
    if (uncertainContext) {
      const first = result.data?.[0];
      const sCode = typeof first === "object" && first !== null && "sCode" in first
        ? String((first as { sCode: unknown }).sCode)
        : undefined;
      if (sCode === undefined) {
        throw new OkxUnknownOrderOutcomeError(uncertainContext, "missing per-order sCode");
      }
      if (sCode === "50004") throw new OkxUnknownOrderOutcomeError(uncertainContext, "per-order timeout 50004");
      if (sCode !== "0") throw new Error(`OKX order operation was rejected (sCode ${sCode}).`);
    }
    return returnAllData ? result.data ?? [] : result.data?.[0] ?? result;
  }
}
