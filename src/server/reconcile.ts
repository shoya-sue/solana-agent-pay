/**
 * Settlement reconciliation for uncertain outcomes.
 *
 * Under devnet load a facilitator can answer `settlement_pending`: the co-signed transaction was sent but
 * not yet confirmed. The official resource server retries once and then fails the request with 402 — even
 * though the transfer may still land, so the client could be charged without getting the response.
 * This onSettleFailure hook keeps asking (the facilitator re-submits/reconciles the *same* signed bytes, so
 * this cannot double charge) and checks the signature on-chain; once it is confirmed the request is
 * recovered and the paid response is delivered.
 */
import { Connection } from "@solana/web3.js";
import type { FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { RPC_URL } from "../config.js";

export type SignatureCheck = (signature: string) => Promise<"confirmed" | "failed" | "unknown">;

export const rpcSignatureCheck = (connection = new Connection(RPC_URL, "confirmed")): SignatureCheck => async (sig) => {
  const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
  const s = value[0];
  if (!s) return "unknown";
  if (s.err) return "failed";
  return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "unknown";
};

export interface ReconcileOptions {
  facilitator: FacilitatorClient;
  checkSignature?: SignatureCheck;
  attempts?: number;
  delayMs?: number;
  onRecovered?: (payload: unknown, result: SettleResponse) => void;
  log?: (m: string) => void;
}

const isPending = (e: unknown) => /settlement_pending|pending/i.test(String((e as { errorReason?: string })?.errorReason ?? (e as Error)?.message ?? ""));

export function attachSettlementReconciler(rs: x402ResourceServer, opts: ReconcileOptions): x402ResourceServer {
  const check = opts.checkSignature ?? rpcSignatureCheck();
  const attempts = opts.attempts ?? 8;
  const delay = opts.delayMs ?? 2500;
  return rs.onSettleFailure(async ({ error, paymentPayload, requirements }) => {
    if (!isPending(error)) return;
    let signature = (error as { transaction?: string }).transaction || "";
    opts.log?.(`settlement pending${signature ? ` (tx ${signature.slice(0, 12)}…)` : ""} — reconciling`);
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, delay));
      if (signature) {
        const st = await check(signature).catch(() => "unknown" as const);
        if (st === "failed") return;
        if (st === "confirmed") {
          const result: SettleResponse = { success: true, transaction: signature, network: requirements.network, payer: (error as { payer?: string }).payer };
          opts.onRecovered?.(paymentPayload, result);
          return { recovered: true as const, result };
        }
      }
      const again = await opts.facilitator.settle(paymentPayload as PaymentPayload, requirements as PaymentRequirements).catch((e) => e as Error);
      if (again && "success" in again) {
        if (again.success) {
          opts.onRecovered?.(paymentPayload, again);
          return { recovered: true as const, result: again };
        }
        if (again.transaction) signature = again.transaction;
        if (!isPending(again)) return;
      }
    }
    opts.log?.("settlement still pending after reconciliation window — request fails, client must reconcile");
  });
}
