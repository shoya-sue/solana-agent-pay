/**
 * x402 HTTP client for the agent: GET → (402 → policy check → pay on devnet → retry with proof) → data.
 * Every payment is recorded in a ledger with a Solana Explorer (devnet) link.
 */
import { explorerTx, TOKEN_DECIMALS, TOKEN_SYMBOL } from "../config.js";
import { fromAtomic } from "../lib/amount.js";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "../x402/types.js";
import type { SpendGuard } from "./policy.js";
import type { AgentWallet } from "./wallet.js";

export interface LedgerEntry {
  resource: string;
  amount: string; // human
  symbol: string;
  signature: string;
  explorer: string;
  at: string;
}

export interface Quote {
  quoteId: string;
  url: string;
  required: PaymentRequired;
  requirement: PaymentRequirements;
}

export type GetResult =
  | { status: 200; body: unknown }
  | { status: 402; quote: Quote }
  | { status: number; body: unknown };

export interface X402Events {
  onPaymentRequired?: (q: Quote) => void;
  onPolicyDenied?: (q: Quote, code: string, reason: string) => void;
  onPaid?: (entry: LedgerEntry) => void;
  onRetry?: (q: Quote, status: number) => void;
}

export class X402Client {
  readonly ledger: LedgerEntry[] = [];
  private quotes = new Map<string, Quote>();
  private seq = 0;

  constructor(
    private baseUrl: string,
    private wallet: AgentWallet,
    readonly guard: SpendGuard,
    private events: X402Events = {},
  ) {}

  async get(pathAndQuery: string, headers: Record<string, string> = {}): Promise<GetResult> {
    const url = new URL(pathAndQuery, this.baseUrl).toString();
    const res = await fetch(url, { headers });
    if (res.status === 402) {
      const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
      const required = header ? decodeHeader<PaymentRequired>(header) : ((await res.json()) as PaymentRequired);
      const requirement = required.accepts[0];
      const quote: Quote = { quoteId: `q${++this.seq}`, url, required, requirement };
      this.quotes.set(quote.quoteId, quote);
      this.events.onPaymentRequired?.(quote);
      return { status: 402, quote };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  getQuote(id: string) {
    return this.quotes.get(id);
  }

  /** Enforce policy, pay on-chain, retry with PAYMENT-SIGNATURE. Never pays outside the policy. */
  async payAndRetry(quoteId: string): Promise<
    | { ok: true; body: unknown; payment: LedgerEntry; settlement?: SettlementResponse }
    | { ok: false; code: string; reason: string; signature?: string }
  > {
    const quote = this.quotes.get(quoteId);
    if (!quote) return { ok: false, code: "unknown_quote", reason: `No quote with id ${quoteId}.` };
    this.quotes.delete(quoteId); // a quote can be acted on once

    const req = quote.requirement;
    const decision = this.guard.reserve(req);
    if (!decision.allowed) {
      this.events.onPolicyDenied?.(quote, decision.code, decision.reason);
      return { ok: false, code: decision.code, reason: decision.reason };
    }

    let signature: string;
    try {
      signature = await this.wallet.pay(req);
    } catch (e) {
      this.guard.release(BigInt(req.amount));
      return { ok: false, code: "payment_failed", reason: (e as Error).message.slice(0, 300) };
    }
    // Money has moved on-chain: count it against the budget regardless of what the server says.
    this.guard.commit(BigInt(req.amount));
    const entry: LedgerEntry = {
      resource: quote.required.resource.url,
      amount: fromAtomic(req.amount, req.extra.decimals ?? TOKEN_DECIMALS),
      symbol: req.extra.symbol ?? TOKEN_SYMBOL,
      signature,
      explorer: explorerTx(signature),
      at: new Date().toISOString(),
    };
    this.ledger.push(entry);
    this.events.onPaid?.(entry);

    const proof: PaymentPayload = {
      x402Version: X402_VERSION,
      resource: quote.required.resource,
      accepted: req,
      payload: { transaction: signature, payer: this.wallet.address },
    };
    const res = await this.retryWithProof(quote.url, proof);
    this.events.onRetry?.(quote, res.status);
    if (res.status === 200) {
      const h = res.headers.get(HEADER_PAYMENT_RESPONSE);
      return { ok: true, body: await res.json(), payment: entry, settlement: h ? decodeHeader(h) : undefined };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, code: `server_rejected_${res.status}`, reason: body.error ?? "unknown", signature };
  }

  retryWithProof(url: string, proof: PaymentPayload) {
    return fetch(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(proof) } });
  }
}
