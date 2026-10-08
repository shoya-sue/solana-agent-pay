import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { SpendGuard } from "../src/agent/policy.js";
import { NETWORK_DEVNET } from "../src/config.js";

const RECIPIENT = "Recipient1111111111111111111111111111111111";
const MINT = "Mint111111111111111111111111111111111111111";

const req = (amount: string, o: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: NETWORK_DEVNET,
  amount,
  asset: MINT,
  payTo: RECIPIENT,
  maxTimeoutSeconds: 120,
  extra: { feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" },
  ...o,
});

const guard = () => new SpendGuard({ perCallCap: 100_000n, totalBudget: 250_000n, allowedRecipients: [RECIPIENT], allowedAssets: [MINT] });
const code = (d: ReturnType<SpendGuard["evaluate"]>) => (d.allowed ? "allowed" : d.code);

describe("SpendGuard (on official x402 PaymentRequirements)", () => {
  it("allows a payment within all limits", () => {
    expect(code(guard().evaluate(req("20000")))).toBe("allowed");
  });
  it("refuses above the per-call cap", () => {
    expect(code(guard().evaluate(req("500000")))).toBe("per_call_cap_exceeded");
  });
  it("refuses once the total budget would be exceeded", () => {
    const g = guard();
    for (let i = 0; i < 2; i++) {
      expect(g.reserve(req("100000")).allowed).toBe(true);
      g.commit(100_000n);
    }
    expect(code(g.evaluate(req("60000")))).toBe("total_budget_exceeded");
    expect(code(g.evaluate(req("50000")))).toBe("allowed");
  });
  it("counts reserved (in-flight) payments against the budget", () => {
    const g = guard();
    g.reserve(req("100000"));
    g.reserve(req("100000"));
    expect(code(g.evaluate(req("60000")))).toBe("total_budget_exceeded");
    g.release(100_000n);
    expect(code(g.evaluate(req("60000")))).toBe("allowed");
  });
  it("refuses non-allowlisted recipients, other mints, mainnet, other schemes and stale quotes", () => {
    const g = guard();
    expect(code(g.evaluate(req("1000", { payTo: "Evi1111111111111111111111111111111111111111" })))).toBe("recipient_not_allowlisted");
    expect(code(g.evaluate(req("1000", { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })))).toBe("asset_not_allowed");
    expect(code(g.evaluate(req("1000", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })))).toBe("network_not_allowed");
    expect(code(g.evaluate(req("1000", { scheme: "upto" })))).toBe("unsupported_scheme");
    expect(code(g.evaluate(req("1000"), 121))).toBe("quote_expired");
    expect(code(g.evaluate(req("0")))).toBe("invalid_amount");
    expect(code(g.evaluate(req("abc")))).toBe("invalid_amount");
  });
});
