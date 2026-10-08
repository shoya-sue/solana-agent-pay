/**
 * Helpers that build *malicious* x402 payment payloads for the safety demo and tests.
 * They use a bare official client (no spend controls) so the payloads are well-formed and correctly
 * signed — the point is to show the server / facilitator still reject them.
 */
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { KeyPairSigner } from "@solana/kit";
import { NETWORK_DEVNET, RPC_URL } from "../config.js";

export function bareClient(signer: KeyPairSigner): x402Client {
  return x402Client.fromConfig({ schemes: [{ network: NETWORK_DEVNET, client: new ExactSvmScheme(signer, { rpcUrl: RPC_URL }) }], spendControls: false });
}

/**
 * Sign a transaction for `actual` but claim the server's original requirement in `accepted`
 * (e.g. pay 0.019999 while claiming 0.02, or pay a different wallet while claiming the server's payTo).
 */
export async function mismatchedPayload(
  client: x402Client,
  required: PaymentRequired,
  change: Partial<PaymentRequirements>,
): Promise<PaymentPayload> {
  const claimed = structuredClone(required.accepts[0]);
  const actual = { ...claimed, ...change };
  const payload = await client.createPaymentPayload({ ...required, accepts: [actual] });
  payload.accepted = claimed;
  return payload;
}
