import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { createServer } from "../src/server/app.js";
import { MemoryPaymentStore } from "../src/server/store.js";
import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_RESPONSE, HEADER_PAYMENT_SIGNATURE, decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired } from "../src/x402/types.js";
import { makeTx, mint, payTo, payer, randomSig } from "./fixtures.js";

// HTTP-level test of the 402 → pay → retry flow with a fake chain (no network access needed).
const nowSec = () => Math.floor(Date.now() / 1000);
const txs = new Map<string, ParsedTransactionWithMeta>();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer({
    payTo: payTo.toBase58(),
    mint: mint.toBase58(),
    store: new MemoryPaymentStore(),
    fetchTx: async (s) => txs.get(s) ?? null,
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function quote(path: string) {
  const res = await fetch(base + path);
  expect(res.status).toBe(402);
  const pr = decodeHeader<PaymentRequired>(res.headers.get(HEADER_PAYMENT_REQUIRED)!);
  return { res, pr, req: pr.accepts[0] };
}

const proof = (req: PaymentRequired["accepts"][0], sig: string): PaymentPayload => ({
  x402Version: 2,
  accepted: req,
  payload: { transaction: sig, payer: payer.toBase58() },
});

describe("paid API server (x402 HTTP transport)", () => {
  it("returns 402 with a PAYMENT-REQUIRED header describing the payment", async () => {
    const { pr, req } = await quote("/api/air-quality?city=Osaka");
    expect(pr.x402Version).toBe(2);
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(req.amount).toBe("10000");
    expect(req.payTo).toBe(payTo.toBase58());
    expect(req.asset).toBe(mint.toBase58());
    expect(req.extra.memo).toMatch(/^x402-/);
    expect(req.extra.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("rejects a malformed PAYMENT-SIGNATURE header with 400", async () => {
    const res = await fetch(base + "/api/weather?city=Tokyo", { headers: { [HEADER_PAYMENT_SIGNATURE]: "%%%not-base64-json" } });
    expect(res.status).toBe(400);
  });

  it("serves the paid response after a valid payment and rejects its replay", async () => {
    const path = "/api/weather?city=Tokyo";
    const { req } = await quote(path);
    const sig = randomSig();
    const tx = makeTx(sig, req.extra.memo, { amount: req.amount, blockTime: nowSec() });
    txs.set(sig, tx);
    const ok = await fetch(base + path, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(proof(req, sig)) } });
    expect([200, 502]).toContain(ok.status); // 502 only if Open-Meteo is unreachable from the test box
    const settle = ok.status === 200 ? decodeHeader<{ success: boolean }>(ok.headers.get(HEADER_PAYMENT_RESPONSE)!) : null;
    if (settle) expect(settle.success).toBe(true);

    const { req: req2 } = await quote(path);
    const replay = await fetch(base + path, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(proof(req2, sig)) } });
    expect(replay.status).toBe(402);
    const body = (await replay.json()) as PaymentRequired;
    expect(body.error).toMatch(/^replayed_signature/);
    expect(decodeHeader<{ success: boolean; errorReason: string }>(replay.headers.get(HEADER_PAYMENT_RESPONSE)!).errorReason).toBe("replayed_signature");
  });

  it("rejects payment with the wrong amount", async () => {
    const path = "/api/air-quality?city=Tokyo";
    const { req } = await quote(path);
    const sig = randomSig();
    txs.set(sig, makeTx(sig, req.extra.memo, { amount: "1", balanceDelta: "1", blockTime: nowSec() }));
    const res = await fetch(base + path, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(proof(req, sig)) } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as PaymentRequired).error).toMatch(/^wrong_amount/);
  });
});
