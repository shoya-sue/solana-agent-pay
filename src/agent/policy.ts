/**
 * Spending policy enforced in code, independent of the LLM. Claude can *ask* to pay;
 * only this guard decides whether a payment is allowed. Works on standard x402 v2 PaymentRequirements.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { NETWORK_DEVNET } from "../config.js";

export interface SpendPolicy {
  /** Max atomic units per single API call. */
  perCallCap: bigint;
  /** Max atomic units across the whole agent session. */
  totalBudget: bigint;
  /** Recipient wallets (payTo) the agent may pay. */
  allowedRecipients: string[];
  /** Token mints the agent may pay with. */
  allowedAssets: string[];
  /** CAIP-2 networks the agent may pay on (devnet only). */
  allowedNetworks?: string[];
}

export type PolicyDecision = { allowed: true } | { allowed: false; code: string; reason: string };

export class SpendGuard {
  private spent = 0n;
  private reserved = 0n;

  constructor(readonly policy: SpendPolicy) {
    if (policy.perCallCap <= 0n || policy.totalBudget <= 0n) throw new Error("Caps must be positive");
  }

  get spentAtomic() {
    return this.spent;
  }
  get remainingAtomic() {
    return this.policy.totalBudget - this.spent - this.reserved;
  }

  /**
   * @param quoteAgeSeconds how long ago the 402 was received; quotes older than maxTimeoutSeconds are refused
   */
  evaluate(req: PaymentRequirements, quoteAgeSeconds = 0): PolicyDecision {
    const p = this.policy;
    const networks = p.allowedNetworks ?? [NETWORK_DEVNET];
    if (req.scheme !== "exact") return deny("unsupported_scheme", `Scheme ${req.scheme} is not supported.`);
    if (!networks.includes(req.network)) return deny("network_not_allowed", `Network ${req.network} is not allowed (devnet only).`);
    if (!p.allowedRecipients.includes(req.payTo)) return deny("recipient_not_allowlisted", `Recipient ${req.payTo} is not on the allowlist.`);
    if (!p.allowedAssets.includes(req.asset)) return deny("asset_not_allowed", `Token mint ${req.asset} is not allowed.`);
    let amount: bigint;
    try {
      amount = BigInt(req.amount);
    } catch {
      return deny("invalid_amount", `Invalid amount ${req.amount}.`);
    }
    if (amount <= 0n) return deny("invalid_amount", "Amount must be positive.");
    if (amount > p.perCallCap) return deny("per_call_cap_exceeded", `Price ${amount} exceeds the per-call cap ${p.perCallCap}.`);
    if (amount > this.remainingAtomic) {
      return deny("total_budget_exceeded", `Price ${amount} exceeds the remaining budget ${this.remainingAtomic}.`);
    }
    if (req.maxTimeoutSeconds && quoteAgeSeconds > req.maxTimeoutSeconds) return deny("quote_expired", "Quote is older than maxTimeoutSeconds.");
    return { allowed: true };
  }

  /** Reserve funds before signing; commit once the facilitator settled, release otherwise. */
  reserve(req: PaymentRequirements, quoteAgeSeconds = 0): PolicyDecision {
    const d = this.evaluate(req, quoteAgeSeconds);
    if (d.allowed) this.reserved += BigInt(req.amount);
    return d;
  }
  commit(amount: bigint) {
    this.reserved -= amount;
    this.spent += amount;
  }
  release(amount: bigint) {
    this.reserved -= amount;
  }
}

const deny = (code: string, reason: string): PolicyDecision => ({ allowed: false, code, reason });
