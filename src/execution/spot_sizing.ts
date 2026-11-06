import type { OkxSpotInstrument } from "../adapters/okx_instruments.js";

type DecimalParts = { integer: bigint; decimals: number };

function parsePositiveDecimal(value: string, field: string): DecimalParts {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) throw new Error(`${field} must be a positive decimal string.`);
  const [whole, fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), decimals: fraction.length };
}

function power10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function formatDecimal(integer: bigint, decimals: number): string {
  const negative = integer < 0n;
  const absolute = negative ? -integer : integer;
  if (decimals === 0) return `${negative ? "-" : ""}${absolute}`;
  const digits = absolute.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Converts a quote-currency budget into base quantity and rounds down exactly
 * to the exchange lot size using integer arithmetic.
 */
export function quantizeSpotBuySize(quoteBudget: string, askPrice: string, instrument: OkxSpotInstrument): string {
  const budget = parsePositiveDecimal(quoteBudget, "quoteBudget");
  const price = parsePositiveDecimal(askPrice, "askPrice");
  const lot = parsePositiveDecimal(instrument.lotSz, "lotSz");
  const minimum = parsePositiveDecimal(instrument.minSz, "minSz");

  // floor((budget / price) / lotSz), keeping each decimal scale exact.
  const numerator = budget.integer * power10(price.decimals + lot.decimals);
  const denominator = price.integer * power10(budget.decimals) * lot.integer;
  const lotCount = numerator / denominator;
  const quantityInteger = lotCount * lot.integer;
  const minScale = Math.max(lot.decimals, minimum.decimals);
  if (quantityInteger * power10(minScale - lot.decimals) < minimum.integer * power10(minScale - minimum.decimals)) {
    throw new Error("Requested quote budget produces a base size below the exchange minimum.");
  }
  return formatDecimal(quantityInteger, lot.decimals);
}

/** Rounds an available base-currency balance down to a valid sell lot. */
export function quantizeSpotSellSize(baseAvailable: string, instrument: OkxSpotInstrument): string {
  const available = parsePositiveDecimal(baseAvailable, "baseAvailable");
  const lot = parsePositiveDecimal(instrument.lotSz, "lotSz");
  const minimum = parsePositiveDecimal(instrument.minSz, "minSz");
  const numerator = available.integer * power10(lot.decimals);
  const denominator = power10(available.decimals) * lot.integer;
  const lotCount = numerator / denominator;
  const quantityInteger = lotCount * lot.integer;
  const minScale = Math.max(lot.decimals, minimum.decimals);
  if (quantityInteger * power10(minScale - lot.decimals) < minimum.integer * power10(minScale - minimum.decimals)) {
    throw new Error("Available base balance is below the exchange minimum sell size.");
  }
  return formatDecimal(quantityInteger, lot.decimals);
}
