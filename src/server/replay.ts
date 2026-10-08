/**
 * Server-side replay guard (defense in depth on top of the facilitator).
 *
 * Every x402 payment payload carries a signed transaction. We key on a hash of it:
 * a payload that is being verified, or has already settled, is rejected before it reaches the
 * facilitator or the handler. Settled keys are persisted so the guard survives restarts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { x402ResourceServer } from "@x402/core/server";

export class ReplayGuard {
  private settled = new Set<string>();
  private inflight = new Set<string>();

  constructor(private file?: string) {
    if (file && fs.existsSync(file)) {
      for (const k of JSON.parse(fs.readFileSync(file, "utf8")) as string[]) this.settled.add(k);
    }
  }

  static keyOf(payload: { payload?: Record<string, unknown> }): string {
    return crypto.createHash("sha256").update(JSON.stringify(payload.payload ?? {})).digest("hex");
  }

  /** Attach to an official x402ResourceServer via its lifecycle hooks. */
  attach(server: x402ResourceServer): x402ResourceServer {
    return server
      .onBeforeVerify(async ({ paymentPayload }) => {
        const k = ReplayGuard.keyOf(paymentPayload as never);
        if (this.settled.has(k)) return { abort: true, reason: "replayed_payment", message: "This payment has already been used." };
        if (this.inflight.has(k)) return { abort: true, reason: "concurrent_payment", message: "This payment is already being processed." };
        this.inflight.add(k);
      })
      .onVerifyFailure(async ({ paymentPayload }) => {
        this.inflight.delete(ReplayGuard.keyOf(paymentPayload as never));
      })
      .onVerifiedPaymentCanceled(async ({ paymentPayload }) => {
        this.inflight.delete(ReplayGuard.keyOf(paymentPayload as never));
      })
      .onSettleFailure(async ({ paymentPayload }) => {
        this.inflight.delete(ReplayGuard.keyOf(paymentPayload as never));
      })
      .onAfterSettle(async ({ paymentPayload, result }) => {
        const k = ReplayGuard.keyOf(paymentPayload as never);
        this.inflight.delete(k);
        if (result.success) {
          this.settled.add(k);
          this.persist();
        }
      });
  }

  /** Used when a settlement is recovered by reconciliation (afterSettle hooks do not run in that case). */
  markSettled(payload: unknown) {
    const k = ReplayGuard.keyOf(payload as never);
    this.inflight.delete(k);
    this.settled.add(k);
    this.persist();
  }

  private persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify([...this.settled]));
  }
}
