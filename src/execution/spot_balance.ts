export type SpotCurrencyBalance = {
  currency: string;
  available: number;
  frozen: number;
  equity: number;
};

export type ExactSpotCurrencyBalance = {
  currency: string;
  available: string;
  frozen: string;
  equity: string;
};

function parseNonNegativeAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`Spot account balance ${field} is missing or invalid; automation must remain stopped.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Spot account balance ${field} is outside the supported numeric range; automation must remain stopped.`);
  }
  return value;
}

/**
 * Extracts one currency from the OKX account-balance envelope. A malformed or
 * ambiguous response is a hard stop; absent currency rows mean zero balance.
 */
export function parseSpotCurrencyBalance(responseData: unknown[], currency: string): SpotCurrencyBalance {
  const exact = parseSpotCurrencyBalanceExact(responseData, currency);
  return {
    currency,
    available: Number(exact.available),
    frozen: Number(exact.frozen),
    equity: Number(exact.equity),
  };
}

/** Preserves the exchange's decimal strings for order sizing and audit records. */
export function parseSpotCurrencyBalanceExact(responseData: unknown[], currency: string): ExactSpotCurrencyBalance {
  if (responseData.length !== 1) {
    throw new Error("OKX spot balance response must contain exactly one account record; automation must remain stopped.");
  }
  const account = responseData[0];
  if (typeof account !== "object" || account === null || !("details" in account) || !Array.isArray(account.details)) {
    throw new Error("OKX spot balance response has no valid details array; automation must remain stopped.");
  }
  const rows = account.details.filter((item) => typeof item === "object" && item !== null && "ccy" in item && item.ccy === currency);
  if (rows.length > 1) throw new Error(`OKX returned duplicate balance rows for ${currency}; automation must remain stopped.`);
  const row = rows[0];
  if (!row) return { currency, available: "0", frozen: "0", equity: "0" };
  const value = row as Record<string, unknown>;
  return {
    currency,
    available: parseNonNegativeAmount(value.availBal, "availBal"),
    frozen: parseNonNegativeAmount(value.frozenBal, "frozenBal"),
    equity: parseNonNegativeAmount(value.eq, "eq"),
  };
}
