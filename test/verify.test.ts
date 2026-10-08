import { describe, expect, it } from "vitest";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { verifyPayment, type VerifyResult } from "../src/server/verify.js";
import { MemoryPaymentStore } from "../src/server/store.js";
import { AMOUNT, NOW, RESOURCE, attacker, makePayload, makeQuote, makeTx, otherMint, randomSig } from "./fixtures.js";

function setup(txOpts: Parameters<typeof makeTx>[2] = {}) {
  const store = new MemoryPaymentStore();
  const quote = makeQuote(store);
  const sig = randomSig();
  const txs = new Map<string, ParsedTransactionWithMeta>([[sig, makeTx(sig, quote.memo, txOpts)]]);
  const deps = { store, fetchTx: async (s: string) => txs.get(s) ?? null, now: () => NOW + 10 };
  return { store, quote, sig, txs, deps };
}

const code = (r: VerifyResult) => (r.ok ? "ok" : r.code);

describe("verifyPayment", () => {
  it("accepts a valid payment and consumes the reference + signature", async () => {
    const { store, quote, sig, deps } = setup();
    const r = await verifyPayment(makePayload(quote, sig), RESOURCE, deps);
    expect(r.ok).toBe(true);
    expect(store.isSignatureUsed(sig)).toBe(true);
    expect(store.getQuote(quote.memo)?.consumedBy).toBe(sig);
  });

  it("rejects the wrong amount (underpay)", async () => {
    const { quote, sig, deps } = setup({ amount: "19999", balanceDelta: "19999" });
    expect(code(await verifyPayment(makePayload(quote, sig), RESOURCE, deps))).toBe("wrong_amount");
  });

  it("rejects the wrong amount (overpay — exact scheme requires equality)", async () => {
    const { quote, sig, deps } = setup({ amount: "20001", balanceDelta: "20001" });
    expect(code(await verifyPayment(makePayload(quote, sig), RESOURCE, deps))).toBe("wrong_amount");
  });

  it("rejects when the recipient balance delta does not match the transfer", async () => {
    const { quote, sig, deps } = setup({ balanceDelta: "1" });
    expect(code(await verifyPayment(makePayload(quote, sig), RESOURCE, deps))).toBe("wrong_amount");
  });

  it("rejects the wrong recipient", async () => {
    const { quote, sig, deps } = setup({ recipientOwner: attacker });
    expect(code(await verifyPayment(makePayload(quote, sig), RESOURCE, deps))).toBe("wrong_recipient");
  });

  it("rejects the wrong mint", async () => {
    // same recipient owner, but the ATA of another mint → destination differs
    const { quote, sig, deps } = setup({ mint: otherMint });
    expect(["wrong_recipient", "wrong_mint"]).toContain(code(await verifyPayment(makePayload(quote, sig), RESOURCE, deps)));
  });

  it("rejects a replayed signature against a fresh quote", async () => {
    const { store, quote, sig, deps } = setup();
    expect((await verifyPayment(makePayload(quote, sig), RESOURCE, deps)).ok).toBe(true);
    const quote2 = makeQuote(store);
    expect(code(await verifyPayment(makePayload(quote2, sig), RESOURCE, deps))).toBe("replayed_signature");
  });

  it("rejects resubmitting the exact same proof", async () => {
    const { quote, sig, deps } = setup();
    const payload = makePayload(quote, sig);
    expect((await verifyPayment(payload, RESOURCE, deps)).ok).toBe(true);
    expect(code(await verifyPayment(payload, RESOURCE, deps))).toBe("replayed_signature");
  });

  it("rejects reusing a consumed reference with a different transaction", async () => {
    const { quote, sig, txs, deps } = setup();
    expect((await verifyPayment(makePayload(quote, sig), RESOURCE, deps)).ok).toBe(true);
    const sig2 = randomSig();
    txs.set(sig2, makeTx(sig2, quote.memo));
    expect(code(await verifyPayment(makePayload(quote, sig2), RESOURCE, deps))).toBe("reference_already_used");
  });

  it("rejects a missing or mismatched memo reference", async () => {
    const a = setup({ memo: null });
    expect(code(await verifyPayment(makePayload(a.quote, a.sig), RESOURCE, a.deps))).toBe("missing_memo");
    const b = setup({ memo: "x402-someoneelse" });
    expect(code(await verifyPayment(makePayload(b.quote, b.sig), RESOURCE, b.deps))).toBe("memo_mismatch");
  });

  it("rejects references not issued by the server, or for another resource", async () => {
    const { quote, sig, deps } = setup();
    const forged = makePayload({ ...quote, memo: "x402-forged" }, sig);
    expect(code(await verifyPayment(forged, RESOURCE, deps))).toBe("unknown_reference");
    expect(code(await verifyPayment(makePayload(quote, sig), "/api/air-quality?city=Tokyo", deps))).toBe("resource_mismatch");
  });

  it("rejects tampered terms, mainnet network, failed / missing / late transactions", async () => {
    const t = setup();
    expect(code(await verifyPayment(makePayload(t.quote, t.sig, { amount: "1" }), RESOURCE, t.deps))).toBe("terms_mismatch");
    expect(code(await verifyPayment(makePayload(t.quote, t.sig, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), RESOURCE, t.deps))).toBe("network_mismatch");
    const f = setup({ err: { InstructionError: [0, "Custom"] } });
    expect(code(await verifyPayment(makePayload(f.quote, f.sig), RESOURCE, f.deps))).toBe("tx_failed");
    const n = setup();
    expect(code(await verifyPayment(makePayload(n.quote, randomSig()), RESOURCE, n.deps))).toBe("tx_not_found");
    const late = setup({ blockTime: NOW + 999 });
    expect(code(await verifyPayment(makePayload(late.quote, late.sig), RESOURCE, late.deps))).toBe("expired");
    const exp = setup();
    expect(code(await verifyPayment(makePayload(exp.quote, exp.sig), RESOURCE, { ...exp.deps, now: () => NOW + 1000 }))).toBe("expired");
    const multi = setup({ transfers: 2, balanceDelta: String(BigInt(AMOUNT) * 2n) });
    expect(code(await verifyPayment(makePayload(multi.quote, multi.sig), RESOURCE, multi.deps))).toBe("multiple_transfers");
  });

  it("does not consume anything when verification fails", async () => {
    const { store, quote, sig, deps } = setup({ amount: "1", balanceDelta: "1" });
    await verifyPayment(makePayload(quote, sig), RESOURCE, deps);
    expect(store.isSignatureUsed(sig)).toBe(false);
    expect(store.getQuote(quote.memo)?.consumedBy).toBeUndefined();
  });
});
