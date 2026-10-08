/** Builders for fake parsed devnet transactions + quotes used by the unit tests. */
import crypto from "node:crypto";
import bs58 from "bs58";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { NETWORK_DEVNET } from "../src/config.js";
import { MEMO_PROGRAM_ID } from "../src/server/verify.js";
import { MemoryPaymentStore, type Quote } from "../src/server/store.js";
import type { PaymentPayload } from "../src/x402/types.js";

export const NOW = 1_800_000_000;
export const mint = Keypair.generate().publicKey;
export const otherMint = Keypair.generate().publicKey;
export const payTo = Keypair.generate().publicKey;
export const attacker = Keypair.generate().publicKey;
export const payer = Keypair.generate().publicKey;
export const RESOURCE = "/api/weather?city=Tokyo";
export const AMOUNT = "20000"; // 0.02 with 6 decimals

export const randomSig = () => bs58.encode(crypto.randomBytes(64));

export function makeQuote(store: MemoryPaymentStore, overrides: Partial<Quote> = {}): Quote {
  const q: Quote = {
    memo: `x402-${bs58.encode(crypto.randomBytes(16))}`,
    resource: RESOURCE,
    amount: AMOUNT,
    asset: mint.toBase58(),
    payTo: payTo.toBase58(),
    network: NETWORK_DEVNET,
    expiresAt: NOW + 120,
    createdAt: NOW,
    ...overrides,
  };
  store.saveQuote(q);
  return q;
}

export function makePayload(q: Quote, signature: string, overrides: Partial<PaymentPayload["accepted"]> = {}): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: q.network,
      amount: q.amount,
      asset: q.asset,
      payTo: q.payTo,
      maxTimeoutSeconds: 120,
      extra: { paymentFlow: "upfront", assetTransferMethod: "client-broadcast", memo: q.memo, expiresAt: q.expiresAt, decimals: 6, symbol: "dUSDC" },
      ...overrides,
    },
    payload: { transaction: signature, payer: payer.toBase58() },
  };
}

export interface TxOpts {
  amount?: string;
  recipientOwner?: PublicKey;
  mint?: PublicKey;
  memo?: string | null;
  err?: unknown;
  blockTime?: number;
  transfers?: number;
  balanceDelta?: string;
}

export function makeTx(signature: string, memo: string, o: TxOpts = {}): ParsedTransactionWithMeta {
  const m = o.mint ?? mint;
  const owner = o.recipientOwner ?? payTo;
  const dest = getAssociatedTokenAddressSync(m, owner);
  const source = getAssociatedTokenAddressSync(m, payer);
  const amount = o.amount ?? AMOUNT;
  const transfer = {
    program: "spl-token",
    programId: TOKEN_PROGRAM_ID,
    parsed: {
      type: "transferChecked",
      info: { source, destination: dest.toBase58(), mint: m.toBase58(), authority: payer.toBase58(), tokenAmount: { amount, decimals: 6 } },
    },
  };
  transfer.parsed.info.source = source.toBase58() as never;
  const instructions: unknown[] = [];
  for (let i = 0; i < (o.transfers ?? 1); i++) instructions.push(transfer);
  const memoText = o.memo === undefined ? memo : o.memo;
  if (memoText !== null) instructions.push({ program: "spl-memo", programId: new PublicKey(MEMO_PROGRAM_ID), parsed: memoText });

  const delta = BigInt(o.balanceDelta ?? amount);
  const bal = (amt: bigint) => ({ accountIndex: 2, mint: m.toBase58(), owner: owner.toBase58(), uiTokenAmount: { amount: amt.toString(), decimals: 6, uiAmount: null, uiAmountString: "" } });
  return {
    slot: 1,
    blockTime: o.blockTime ?? NOW + 5,
    meta: {
      err: (o.err ?? null) as never,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [bal(1_000_000n)],
      postTokenBalances: [bal(1_000_000n + delta)],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true, source: "transaction" },
          { pubkey: source, signer: false, writable: true, source: "transaction" },
          { pubkey: dest, signer: false, writable: true, source: "transaction" },
        ],
        instructions,
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
    version: 0,
  } as unknown as ParsedTransactionWithMeta;
}
