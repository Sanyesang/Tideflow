export type Direction = "long" | "short" | "flat";

export type MomentumSignal = {
  direction: Direction;
  moveBps: number | null;
  samples: number;
};

export type TickMomentumOptions = {
  lookbackTicks: number;
  entryThresholdBps: number;
  allowShort: boolean;
};

/** Small deterministic baseline. It is not a trained AI model or a profit claim. */
export class TickMomentumStrategy {
  private readonly prices: number[] = [];

  constructor(private readonly options: TickMomentumOptions) {
    if (!Number.isInteger(options.lookbackTicks) || options.lookbackTicks < 1) throw new Error("lookbackTicks must be a positive integer.");
    if (!Number.isFinite(options.entryThresholdBps) || options.entryThresholdBps <= 0) throw new Error("entryThresholdBps must be positive.");
  }

  update(price: number): MomentumSignal {
    if (!Number.isFinite(price) || price <= 0) throw new Error("Tick price must be positive and finite.");
    this.prices.push(price);
    if (this.prices.length > this.options.lookbackTicks + 1) this.prices.shift();
    if (this.prices.length <= this.options.lookbackTicks) {
      return { direction: "flat", moveBps: null, samples: this.prices.length };
    }

    const first = this.prices[0]!;
    const last = this.prices.at(-1)!;
    const moveBps = ((last - first) / first) * 10_000;
    if (moveBps >= this.options.entryThresholdBps) return { direction: "long", moveBps, samples: this.prices.length };
    if (this.options.allowShort && moveBps <= -this.options.entryThresholdBps) return { direction: "short", moveBps, samples: this.prices.length };
    return { direction: "flat", moveBps, samples: this.prices.length };
  }
}
