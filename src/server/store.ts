/**
 * Quote (nonce/reference) + consumed-signature store for replay protection.
 *
 * - Every 402 issues a fresh one-time `memo` reference bound to (resource, amount, asset, payTo, expiry).
 * - A reference can be consumed once; a transaction signature can be used once.
 * - `begin()` takes an in-process lock so two concurrent requests cannot race the same signature/reference.
 *
 * The file-backed implementation survives restarts (demo-grade; use Redis/Postgres with unique
 * constraints in production).
 */
import fs from "node:fs";
import path from "node:path";

export interface Quote {
  memo: string;
  resource: string;
  amount: string;
  asset: string;
  payTo: string;
  network: string;
  expiresAt: number; // unix seconds
  createdAt: number;
  consumedBy?: string; // tx signature
  payer?: string;
}

export interface PaymentStore {
  saveQuote(q: Quote): void;
  getQuote(memo: string): Quote | undefined;
  isSignatureUsed(sig: string): boolean;
  /** Acquire an in-flight lock for (sig, memo). Returns false if either is already in flight. */
  begin(sig: string, memo: string): boolean;
  end(sig: string, memo: string): void;
  /** Atomically mark the reference consumed and the signature used. */
  consume(memo: string, sig: string, payer: string): void;
}

interface Snapshot {
  quotes: Record<string, Quote>;
  usedSignatures: Record<string, { memo: string; at: number }>;
}

export class MemoryPaymentStore implements PaymentStore {
  protected data: Snapshot = { quotes: {}, usedSignatures: {} };
  private inflight = new Set<string>();

  saveQuote(q: Quote) {
    this.data.quotes[q.memo] = q;
    this.prune();
    this.persist();
  }
  getQuote(memo: string) {
    return this.data.quotes[memo];
  }
  isSignatureUsed(sig: string) {
    return sig in this.data.usedSignatures;
  }
  begin(sig: string, memo: string) {
    if (this.inflight.has(`s:${sig}`) || this.inflight.has(`m:${memo}`)) return false;
    this.inflight.add(`s:${sig}`);
    this.inflight.add(`m:${memo}`);
    return true;
  }
  end(sig: string, memo: string) {
    this.inflight.delete(`s:${sig}`);
    this.inflight.delete(`m:${memo}`);
  }
  consume(memo: string, sig: string, payer: string) {
    const q = this.data.quotes[memo];
    if (!q) throw new Error("unknown reference");
    if (q.consumedBy || this.isSignatureUsed(sig)) throw new Error("already consumed");
    q.consumedBy = sig;
    q.payer = payer;
    this.data.usedSignatures[sig] = { memo, at: Math.floor(Date.now() / 1000) };
    this.persist();
  }
  /** Drop unpaid quotes that expired more than an hour ago (consumed ones are kept for audit). */
  private prune() {
    const cutoff = Math.floor(Date.now() / 1000) - 3600;
    for (const [k, q] of Object.entries(this.data.quotes)) {
      if (!q.consumedBy && q.expiresAt < cutoff) delete this.data.quotes[k];
    }
  }
  protected persist() {}
}

export class FilePaymentStore extends MemoryPaymentStore {
  constructor(private file: string) {
    super();
    if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  }
  protected persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
