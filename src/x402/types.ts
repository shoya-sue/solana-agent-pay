/**
 * x402 v2 wire types (subset) + the extensions this demo uses.
 *
 * Aligned with the x402 v2 spec (https://github.com/x402-foundation/x402):
 *  - 402 response carries a base64 `PaymentRequired` in the `PAYMENT-REQUIRED` header (and as JSON body)
 *  - the client retries with a base64 `PaymentPayload` in the `PAYMENT-SIGNATURE` header
 *  - the server answers with a base64 `SettlementResponse` in the `PAYMENT-RESPONSE` header
 *
 * Difference from the official Solana `exact` scheme (documented in README):
 *  the official scheme sends a *partially-signed transaction* that a facilitator co-signs (fee payer)
 *  and settles. This demo uses a "client-broadcast" transfer method: the agent signs, pays the fee and
 *  broadcasts the SPL `TransferChecked` itself, then proves payment by sending the confirmed
 *  transaction signature. The server verifies the transaction on-chain before serving
 *  (settle-before-handler, i.e. the x402 `upfront` payment flow).
 */

export const X402_VERSION = 2 as const;

export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/** Non-standard value for `extra.assetTransferMethod` used by this demo. */
export const TRANSFER_METHOD_CLIENT_BROADCAST = "client-broadcast" as const;

export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface SolanaExactExtra {
  /** x402 payment flow: settle (here: verify confirmed on-chain transfer) before the handler runs. */
  paymentFlow: "upfront";
  /** Demo-specific: client signs + broadcasts the transfer itself, then proves it with the signature. */
  assetTransferMethod: typeof TRANSFER_METHOD_CLIENT_BROADCAST;
  /** One-time reference the client MUST put in an SPL Memo instruction (same key the official SVM scheme uses). */
  memo: string;
  /** Unix seconds after which this quote is no longer accepted. */
  expiresAt: number;
  /** Token metadata for display / sanity checks. */
  decimals: number;
  symbol: string;
}

export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2 network id, e.g. solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 (devnet). */
  network: string;
  /** Atomic units (string, like the spec). */
  amount: string;
  /** SPL token mint. */
  asset: string;
  /** Recipient wallet (owner). Tokens go to its associated token account. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: SolanaExactExtra;
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
}

export interface ClientBroadcastPayload {
  /** Base58 signature of the confirmed transaction containing the TransferChecked + Memo. */
  transaction: string;
  /** Payer wallet (owner of the source token account). */
  payer: string;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: ClientBroadcastPayload;
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}
