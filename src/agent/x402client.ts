/**
 * The agent's x402 client: the official @x402/core x402Client + @x402/svm ExactSvmScheme do the
 * protocol work (parse 402, build + partially sign the Solana transaction, encode PAYMENT-SIGNATURE,
 * read PAYMENT-RESPONSE). This wrapper splits the flow in two so Claude can look at the quote first
 * and our SpendGuard can veto before anything is signed:
 *
 *   get(url)            → 200 data | 402 quote (nothing signed)
 *   payAndRetry(quote)  → SpendGuard → official client signs → retry → facilitator settles → 200
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { KeyPairSigner } from "@solana/kit";
import { NETWORK_DEVNET, RPC_URL, TOKEN_DECIMALS, TOKEN_SYMBOL, explorerTx } from "../config.js";
import { fromAtomic } from "../lib/amount.js";
import type { SpendGuard } from "./policy.js";

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
  receivedAt: number;
  required: PaymentRequired;
  requirement: PaymentRequirements;
}

export type GetResult = { status: 402; quote: Quote } | { status: number; body: unknown };

export interface X402Events {
  onPaymentRequired?: (q: Quote) => void;
  onPolicyDenied?: (q: Quote, code: string, reason: string) => void;
  onSigned?: (q: Quote) => void;
  onPaid?: (entry: LedgerEntry) => void;
  onRejected?: (q: Quote, status: number, reason: string) => void;
}

/** Build the official x402 client for the agent's wallet, with official spend controls as a second layer. */
export function createOfficialClient(signer: KeyPairSigner, guard: SpendGuard): x402Client {
  const p = guard.policy;
  return x402Client.fromConfig({
    schemes: [{ network: NETWORK_DEVNET, client: new ExactSvmScheme(signer, { rpcUrl: RPC_URL }) }],
    spendControls: {
      allowedAssets: p.allowedAssets.map((asset) => ({ network: NETWORK_DEVNET, asset, maxAmountPerPayment: p.perCallCap.toString() })),
    },
    policies: [(_v, reqs) => reqs.filter((r) => p.allowedRecipients.includes(r.payTo))],
  });
}

export class X402Client {
  readonly ledger: LedgerEntry[] = [];
  /** Payment payloads that were accepted, kept only so the demo can try to replay one. */
  readonly settledPayloads: { url: string; payload: PaymentPayload }[] = [];
  readonly http: x402HTTPClient;
  private quotes = new Map<string, Quote>();
  private seq = 0;

  constructor(
    private baseUrl: string,
    readonly core: x402Client,
    readonly guard: SpendGuard,
    private events: X402Events = {},
  ) {
    this.http = new x402HTTPClient(core);
  }

  displayAmount(req: PaymentRequirements) {
    return `${fromAtomic(req.amount, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`;
  }

  async get(pathAndQuery: string): Promise<GetResult> {
    const url = new URL(pathAndQuery, this.baseUrl).toString();
    const res = await fetch(url);
    if (res.status === 402) {
      const body = await res.json().catch(() => undefined);
      const required = this.http.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      const quote: Quote = { quoteId: `q${++this.seq}`, url, receivedAt: Date.now(), required, requirement: required.accepts[0] };
      this.quotes.set(quote.quoteId, quote);
      this.events.onPaymentRequired?.(quote);
      return { status: 402, quote };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  getQuote(id: string) {
    return this.quotes.get(id);
  }

  async payAndRetry(quoteId: string): Promise<
    | { ok: true; body: unknown; payment: LedgerEntry; settlement: SettleResponse }
    | { ok: false; code: string; reason: string }
  > {
    const quote = this.quotes.get(quoteId);
    if (!quote) return { ok: false, code: "unknown_quote", reason: `No quote with id ${quoteId}.` };
    this.quotes.delete(quoteId); // a quote can be acted on once

    const req = quote.requirement;
    const age = (Date.now() - quote.receivedAt) / 1000;
    const decision = this.guard.reserve(req, age);
    if (!decision.allowed) {
      this.events.onPolicyDenied?.(quote, decision.code, decision.reason);
      return { ok: false, code: decision.code, reason: decision.reason };
    }
    const amount = BigInt(req.amount);

    let payload: PaymentPayload;
    try {
      // Official client: selects the requirement (spend controls + payTo policy), builds a TransferChecked
      // transaction with the facilitator as fee payer, and partially signs it with the agent's key.
      payload = await this.http.createPaymentPayload({ ...quote.required, accepts: [req] });
    } catch (e) {
      this.guard.release(amount);
      return { ok: false, code: "payment_creation_failed", reason: (e as Error).message.slice(0, 300) };
    }
    this.events.onSigned?.(quote);

    const res = await fetch(quote.url, { headers: this.http.encodePaymentSignatureHeader(payload) });
    if (res.status !== 200) {
      const reason = this.rejectionReason(res);
      if (/pending/i.test(reason)) {
        // Uncertain: the transfer may still land. Keep the amount reserved (counts against the budget)
        // instead of assuming it is free to retry.
        this.events.onRejected?.(quote, res.status, reason);
        return { ok: false, code: "settlement_uncertain", reason: `${reason}: the payment may still settle; the amount stays reserved. Do not re-buy immediately.` };
      }
      // Rejected at verify (or settle failed outright): the facilitator never broadcast, no funds moved.
      this.guard.release(amount);
      this.events.onRejected?.(quote, res.status, reason);
      return { ok: false, code: `server_rejected_${res.status}`, reason };
    }
    const settlement = this.http.getPaymentSettleResponse((n) => res.headers.get(n));
    this.guard.commit(amount);
    const entry: LedgerEntry = {
      resource: pathOf(quote.required.resource?.url ?? quote.url, this.baseUrl),
      amount: fromAtomic(req.amount, TOKEN_DECIMALS),
      symbol: TOKEN_SYMBOL,
      signature: settlement.transaction,
      explorer: explorerTx(settlement.transaction),
      at: new Date().toISOString(),
    };
    this.ledger.push(entry);
    this.settledPayloads.push({ url: quote.url, payload });
    this.events.onPaid?.(entry);
    return { ok: true, body: await res.json(), payment: entry, settlement };
  }

  /** Extract the error from a 402 / failure response (x402 puts it in PAYMENT-REQUIRED or PAYMENT-RESPONSE). */
  rejectionReason(res: Response): string {
    try {
      const pr = this.http.getPaymentRequiredResponse((n) => res.headers.get(n));
      if (pr.error) return pr.error;
    } catch {
      /* not a 402 with header */
    }
    try {
      const s = this.http.getPaymentSettleResponse((n) => res.headers.get(n));
      return s.errorReason ?? "settlement_failed";
    } catch {
      return `HTTP ${res.status}`;
    }
  }
}

function pathOf(url: string, base: string) {
  const u = new URL(url, base);
  return u.pathname + u.search;
}
