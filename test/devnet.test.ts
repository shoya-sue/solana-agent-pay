/**
 * Optional live test against Solana devnet (real transactions, test token only).
 * Run with: npm run test:devnet   (requires `npm run setup` to have funded the wallets)
 */
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { NETWORK_DEVNET, RPC_URL, TOKEN_DECIMALS, TOKEN_SYMBOL, explorerTx } from "../src/config.js";
import { AgentWallet } from "../src/agent/wallet.js";
import { rpcFetchTx } from "../src/server/app.js";
import { MemoryPaymentStore, type Quote } from "../src/server/store.js";
import { verifyPayment } from "../src/server/verify.js";
import { loadKeypair, loadState } from "../src/solana/wallets.js";
import type { PaymentPayload, PaymentRequirements } from "../src/x402/types.js";

const enabled = process.env.DEVNET_TESTS === "1";

describe.skipIf(!enabled)("devnet: on-chain payment verification", () => {
  const state = enabled ? loadState() : (null as never);
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = enabled ? new AgentWallet(connection, loadKeypair("agent")) : (null as never);
  const store = new MemoryPaymentStore();
  const deps = { store, fetchTx: rpcFetchTx(connection) };
  const RES = "/api/weather?city=Tokyo";

  const newQuote = (amount = "20000"): { quote: Quote; req: PaymentRequirements } => {
    const now = Math.floor(Date.now() / 1000);
    const quote: Quote = {
      memo: `x402-${bs58.encode(crypto.randomBytes(16))}`,
      resource: RES, amount, asset: state.mint, payTo: state.server, network: NETWORK_DEVNET, expiresAt: now + 300, createdAt: now,
    };
    store.saveQuote(quote);
    const req: PaymentRequirements = {
      scheme: "exact", network: NETWORK_DEVNET, amount, asset: state.mint, payTo: state.server, maxTimeoutSeconds: 300,
      extra: { paymentFlow: "upfront", assetTransferMethod: "client-broadcast", memo: quote.memo, expiresAt: quote.expiresAt, decimals: TOKEN_DECIMALS, symbol: TOKEN_SYMBOL },
    };
    return { quote, req };
  };
  const payload = (req: PaymentRequirements, sig: string): PaymentPayload => ({
    x402Version: 2, accepted: req, payload: { transaction: sig, payer: wallet.address },
  });

  let validSig = "";

  it("valid payment is accepted", async () => {
    const { req } = newQuote();
    validSig = await wallet.pay(req);
    console.log("valid:", explorerTx(validSig));
    const r = await verifyPayment(payload(req, validSig), RES, deps);
    expect(r.ok).toBe(true);
  }, 90_000);

  it("wrong amount is rejected", async () => {
    const { req } = newQuote();
    const sig = await wallet.pay({ ...req, amount: "19999" });
    console.log("wrong amount:", explorerTx(sig));
    const r = await verifyPayment(payload(req, sig), RES, deps);
    expect(r.ok ? "ok" : r.code).toBe("wrong_amount");
  }, 90_000);

  it("wrong recipient is rejected", async () => {
    const funder = loadKeypair("funder");
    await getOrCreateAssociatedTokenAccount(connection, funder, new PublicKey(state.mint), funder.publicKey);
    const { req } = newQuote();
    const sig = await wallet.pay({ ...req, payTo: funder.publicKey.toBase58() });
    console.log("wrong recipient:", explorerTx(sig));
    const r = await verifyPayment(payload(req, sig), RES, deps);
    expect(r.ok ? "ok" : r.code).toBe("wrong_recipient");
  }, 90_000);

  it("replayed signature is rejected", async () => {
    expect(validSig).not.toBe("");
    const { req } = newQuote();
    const r = await verifyPayment(payload(req, validSig), RES, deps);
    expect(r.ok ? "ok" : r.code).toBe("replayed_signature");
  }, 30_000);
});
