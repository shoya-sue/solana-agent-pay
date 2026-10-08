/**
 * On-chain payment verification for the x402-style "client-broadcast" Solana flow.
 *
 * A payment is accepted only if ALL of the following hold:
 *  1. Payload is x402 v2, scheme `exact`, network = Solana devnet.
 *  2. The memo reference was issued by this server, for this resource, and the quoted terms match.
 *  3. The signature has never been used and the reference has never been consumed (replay protection).
 *  4. The transaction is found at `confirmed` commitment and did not fail.
 *  5. It contains exactly one top-level SPL Token `TransferChecked` into the recipient's ATA,
 *     for the quoted mint and EXACT amount, and the recipient's token balance increased by that amount.
 *  6. It contains an SPL Memo instruction equal to the reference.
 *  7. It landed (blockTime) before the quote expired.
 */
import {
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NETWORK_DEVNET } from "../config.js";
import type { PaymentPayload } from "../x402/types.js";
import type { PaymentStore, Quote } from "./store.js";

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type VerifyErrorCode =
  | "invalid_payload"
  | "network_mismatch"
  | "unknown_reference"
  | "terms_mismatch"
  | "resource_mismatch"
  | "expired"
  | "replayed_signature"
  | "reference_already_used"
  | "concurrent_attempt"
  | "tx_not_found"
  | "tx_failed"
  | "missing_transfer"
  | "multiple_transfers"
  | "wrong_recipient"
  | "wrong_mint"
  | "wrong_amount"
  | "missing_memo"
  | "memo_mismatch"
  | "payer_mismatch";

export type VerifyResult =
  | { ok: true; signature: string; payer: string; amount: string; quote: Quote }
  | { ok: false; code: VerifyErrorCode; message: string };

export type FetchTx = (signature: string) => Promise<ParsedTransactionWithMeta | null>;

export interface VerifyDeps {
  store: PaymentStore;
  fetchTx: FetchTx;
  now?: () => number; // unix seconds
  network?: string;
}

const fail = (code: VerifyErrorCode, message: string): VerifyResult => ({ ok: false, code, message });

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

function isParsed(ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction {
  return "parsed" in ix;
}

export async function verifyPayment(
  payload: PaymentPayload,
  requestedResource: string,
  deps: VerifyDeps,
): Promise<VerifyResult> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const network = deps.network ?? NETWORK_DEVNET;

  // 1. Shape
  if (payload?.x402Version !== 2 || payload.accepted?.scheme !== "exact" || !payload.payload) {
    return fail("invalid_payload", "Expected an x402 v2 PaymentPayload with scheme 'exact'.");
  }
  const sig = payload.payload.transaction;
  if (typeof sig !== "string" || !SIG_RE.test(sig)) {
    return fail("invalid_payload", "payload.transaction must be a base58 transaction signature.");
  }
  if (payload.accepted.network !== network) {
    return fail("network_mismatch", `Only ${network} (Solana devnet) is accepted.`);
  }

  // 2. Reference issued by us, for this resource, with unchanged terms
  const memo = payload.accepted.extra?.memo;
  const quote = memo ? deps.store.getQuote(memo) : undefined;
  if (!quote) return fail("unknown_reference", "Payment reference (memo) was not issued by this server.");
  if (quote.resource !== requestedResource) {
    return fail("resource_mismatch", `Reference was issued for ${quote.resource}, not ${requestedResource}.`);
  }
  const a = payload.accepted;
  if (a.amount !== quote.amount || a.asset !== quote.asset || a.payTo !== quote.payTo) {
    return fail("terms_mismatch", "Accepted payment terms differ from the quote issued by the server.");
  }

  // 3. Replay protection
  if (deps.store.isSignatureUsed(sig)) {
    return fail("replayed_signature", "This transaction signature has already been used to pay for a request.");
  }
  if (quote.consumedBy) {
    return fail("reference_already_used", "This payment reference has already been paid and consumed.");
  }
  if (now() > quote.expiresAt + 30 /* grace for in-flight confirmation */) {
    return fail("expired", "Payment quote expired. Request the resource again for a fresh quote.");
  }
  if (!deps.store.begin(sig, memo!)) {
    return fail("concurrent_attempt", "This signature/reference is already being verified.");
  }

  try {
    // 4. Fetch + status
    const tx = await deps.fetchTx(sig);
    if (!tx) return fail("tx_not_found", "Transaction not found at 'confirmed' commitment on devnet.");
    if (tx.meta?.err) return fail("tx_failed", `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`);
    if (tx.blockTime != null && tx.blockTime > quote.expiresAt) {
      return fail("expired", "Transaction landed after the quote expired.");
    }

    // 5. Transfer checks
    const mint = new PublicKey(quote.asset);
    const payTo = new PublicKey(quote.payTo);
    const expectedAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID).toBase58();

    const ixs = tx.transaction.message.instructions;
    const transfers = ixs.filter(
      (ix): ix is ParsedInstruction =>
        isParsed(ix) && ix.programId.equals(TOKEN_PROGRAM_ID) && ix.parsed?.type === "transferChecked",
    );
    if (transfers.length === 0) {
      return fail("missing_transfer", "No SPL Token TransferChecked instruction found.");
    }
    if (transfers.length > 1) {
      return fail("multiple_transfers", "Exactly one TransferChecked instruction is allowed per payment.");
    }
    const info = transfers[0].parsed.info as {
      source: string;
      destination: string;
      mint: string;
      authority?: string;
      multisigAuthority?: string;
      tokenAmount: { amount: string; decimals: number };
    };
    if (info.destination !== expectedAta) {
      return fail("wrong_recipient", `Tokens were sent to ${info.destination}, expected ATA ${expectedAta} of ${quote.payTo}.`);
    }
    if (info.mint !== quote.asset) {
      return fail("wrong_mint", `Wrong token mint ${info.mint}; expected ${quote.asset}.`);
    }
    if (info.tokenAmount.amount !== quote.amount) {
      return fail("wrong_amount", `Paid ${info.tokenAmount.amount} atomic units; exactly ${quote.amount} required.`);
    }
    const payer = info.authority ?? info.multisigAuthority ?? "";
    if (payload.payload.payer && payer && payload.payload.payer !== payer) {
      return fail("payer_mismatch", "payload.payer does not match the transfer authority.");
    }

    // Cross-check with balance deltas (defends against parser edge cases)
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const ataIndex = keys.indexOf(expectedAta);
    const pre = tx.meta?.preTokenBalances?.find((b) => b.accountIndex === ataIndex && b.mint === quote.asset);
    const post = tx.meta?.postTokenBalances?.find((b) => b.accountIndex === ataIndex && b.mint === quote.asset);
    const delta = BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0");
    if (delta !== BigInt(quote.amount)) {
      return fail("wrong_amount", `Recipient balance changed by ${delta}, expected ${quote.amount}.`);
    }

    // 6. Memo reference
    const memos = ixs.filter(
      (ix): ix is ParsedInstruction => isParsed(ix) && ix.programId.toBase58() === MEMO_PROGRAM_ID,
    );
    if (memos.length === 0) return fail("missing_memo", "No SPL Memo with the payment reference found.");
    if (!memos.some((m) => m.parsed === quote.memo)) {
      return fail("memo_mismatch", "Memo does not match the payment reference for this request.");
    }

    // 7. Commit (atomic: reference + signature consumed together)
    try {
      deps.store.consume(quote.memo, sig, payer);
    } catch {
      return fail("replayed_signature", "Payment was consumed concurrently.");
    }
    return { ok: true, signature: sig, payer, amount: quote.amount, quote };
  } finally {
    deps.store.end(sig, memo!);
  }
}
