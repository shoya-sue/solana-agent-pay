import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { x402HTTPClient, x402Client } from "@x402/core/client";
import { createApp, type PaidRoute } from "../src/server/app.js";
import { ReplayGuard } from "../src/server/replay.js";
import { NETWORK_DEVNET } from "../src/config.js";

// HTTP-level test of the official x402 middleware wiring (402 → PAYMENT-SIGNATURE → verify → handler → settle)
// with a fake facilitator, so no network access is needed. The fake "transaction" is JSON describing the
// transfer; the fake facilitator checks it against the requirements like the real one checks the Solana tx.
const PAY_TO = "Egc4sm4qc3BGCX9VMu9Gvp17PtLzno1jchSiBWc2bPeA";
const MINT = "78RhEquiV9HyW32YNBpd48gz3bDwqNj5v5o3UZ8JHeSq";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const PAYER = "3FEmjYNBFa5ncR8nUE7UUwx4G6x98MWS3TYAzNxT7w5U";

const calls = { verify: 0, settle: 0, handler: 0 };
const settledTx = new Set<string>();
// settlement_pending simulation: the next N settle calls answer "pending" (the tx still lands on "chain")
let pendingSettles = 0;
const landed = new Set<string>();
let txSeq = 0;

const fakeTx = (o: { amount: string; payTo: string; asset?: string }) =>
  Buffer.from(JSON.stringify({ ...o, asset: o.asset ?? MINT, nonce: ++txSeq })).toString("base64");

function checkTx(p: PaymentPayload, r: PaymentRequirements): VerifyResponse {
  const tx = JSON.parse(Buffer.from(String(p.payload.transaction), "base64").toString());
  if (tx.amount !== r.amount) return { isValid: false, invalidReason: "invalid_exact_svm_payload_amount_mismatch", payer: PAYER };
  if (tx.payTo !== r.payTo) return { isValid: false, invalidReason: "invalid_exact_svm_payload_recipient_mismatch", payer: PAYER };
  if (settledTx.has(String(p.payload.transaction))) return { isValid: false, invalidReason: "duplicate_transaction", payer: PAYER };
  return { isValid: true, payer: PAYER };
}

const fakeFacilitator: FacilitatorClient = {
  async verify(p, r) {
    calls.verify++;
    return checkTx(p, r);
  },
  async settle(p, r): Promise<SettleResponse> {
    calls.settle++;
    const v = checkTx(p, r);
    if (!v.isValid) return { success: false, errorReason: v.invalidReason, transaction: "", network: r.network, payer: PAYER } as SettleResponse;
    if (pendingSettles > 0) {
      pendingSettles--;
      const sig = `pending-${String(p.payload.transaction).slice(-12)}`;
      if (pendingSettles === 0) landed.add(sig); // lands after the facilitator gave up waiting
      return { success: false, errorReason: "settlement_pending", transaction: sig, network: r.network, payer: PAYER } as SettleResponse;
    }
    settledTx.add(String(p.payload.transaction));
    return { success: true, transaction: `sig${txSeq}`, network: r.network, payer: PAYER };
  },
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} };
  },
} as FacilitatorClient;

const routes: PaidRoute[] = [
  { path: "/api/weather", price: "0.02", description: "weather", params: {}, handler: async (q) => (calls.handler++, { city: q.get("city"), temp: 21 }) },
  { path: "/api/air-quality", price: "0.01", description: "aq", params: {}, handler: async () => (calls.handler++, { aqi: 30 }) },
];

const http = new x402HTTPClient(new x402Client());
let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({
    payTo: PAY_TO,
    mint: MINT,
    facilitator: fakeFacilitator,
    replayGuard: new ReplayGuard(),
    routes,
    reconcileDelayMs: 5,
    checkSignature: async (sig) => (landed.has(sig) ? "confirmed" : "unknown"),
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => Object.assign(calls, { verify: 0, settle: 0, handler: 0 }));

async function quote(path: string) {
  const res = await fetch(base + path);
  expect(res.status).toBe(402);
  const pr = http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json().catch(() => undefined));
  return { pr, req: pr.accepts[0] };
}

const payload = (accepted: PaymentRequirements, transaction: string, resource?: PaymentPayload["resource"]): PaymentPayload => ({
  x402Version: 2,
  resource,
  accepted,
  payload: { transaction },
});

const pay = (path: string, p: PaymentPayload) => fetch(base + path, { headers: http.encodePaymentSignatureHeader(p) });

describe("paid API server (official @x402/express middleware)", () => {
  it("serves the free catalog", async () => {
    const res = await fetch(base + "/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: unknown[]; network: string };
    expect(body.endpoints).toHaveLength(2);
    expect(body.network).toBe(NETWORK_DEVNET);
  });

  it("returns 402 with a standard PAYMENT-REQUIRED header (exact / devnet / feePayer from the facilitator)", async () => {
    const { pr, req } = await quote("/api/air-quality?city=Osaka");
    expect(pr.x402Version).toBe(2);
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(req.amount).toBe("10000");
    expect(req.payTo).toBe(PAY_TO);
    expect(req.asset).toBe(MINT);
    expect(req.extra?.feePayer).toBe(FEE_PAYER);
    expect(pr.resource?.url).toContain("/api/air-quality");
    expect(calls.handler).toBe(0);
  });

  it("serves the response after a valid payment, settles it, and rejects its replay", async () => {
    const path = "/api/weather?city=Tokyo";
    const { pr, req } = await quote(path);
    const p = payload(req, fakeTx({ amount: req.amount, payTo: req.payTo }), pr.resource);

    const ok = await pay(path, p);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { city: "Tokyo", temp: 21 } });
    const settle = http.getPaymentSettleResponse((n) => ok.headers.get(n));
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^sig/);
    expect(calls).toEqual({ verify: 1, settle: 1, handler: 1 });

    // Replay: the server-side guard rejects before the facilitator is even asked
    const replay = await pay(path, p);
    expect(replay.status).toBe(402);
    expect(http.getPaymentRequiredResponse((n) => replay.headers.get(n)).error).toMatch(/replayed_payment|already been used/);
    expect(calls).toEqual({ verify: 1, settle: 1, handler: 1 });
  });

  it("rejects a wrong amount (tx pays less than required) via facilitator verify; handler never runs", async () => {
    const path = "/api/weather?city=Osaka";
    const { pr, req } = await quote(path);
    const res = await pay(path, payload(req, fakeTx({ amount: "19999", payTo: req.payTo }), pr.resource));
    expect(res.status).toBe(402);
    expect(http.getPaymentRequiredResponse((n) => res.headers.get(n)).error).toMatch(/amount_mismatch/);
    expect(calls).toEqual({ verify: 1, settle: 0, handler: 0 });
  });

  it("rejects a wrong recipient via facilitator verify; handler never runs", async () => {
    const path = "/api/weather?city=Nagoya";
    const { pr, req } = await quote(path);
    const res = await pay(path, payload(req, fakeTx({ amount: req.amount, payTo: PAYER }), pr.resource));
    expect(res.status).toBe(402);
    expect(http.getPaymentRequiredResponse((n) => res.headers.get(n)).error).toMatch(/recipient_mismatch/);
    expect(calls).toEqual({ verify: 1, settle: 0, handler: 0 });
  });

  it("rejects a payload whose `accepted` terms differ from the route (amount or payTo) without calling the facilitator", async () => {
    const path = "/api/weather?city=Fukuoka";
    const { pr, req } = await quote(path);
    for (const accepted of [{ ...req, amount: "1" }, { ...req, payTo: PAYER }]) {
      const res = await pay(path, payload(accepted, fakeTx({ amount: accepted.amount, payTo: accepted.payTo }), pr.resource));
      expect(res.status).toBe(402);
    }
    expect(calls).toEqual({ verify: 0, settle: 0, handler: 0 });
  });

  it("does not let a payment for a cheap endpoint unlock an expensive one", async () => {
    const { pr, req } = await quote("/api/air-quality?city=Tokyo");
    const res = await pay("/api/weather?city=Tokyo", payload(req, fakeTx({ amount: req.amount, payTo: req.payTo }), pr.resource));
    expect(res.status).toBe(402);
    expect(calls.handler).toBe(0);
  });

  it("recovers a `settlement_pending` outcome by reconciling on-chain, then delivers the paid response once", async () => {
    const path = "/api/weather?city=Sendai";
    const { pr, req } = await quote(path);
    pendingSettles = 2; // first settle + the official server's built-in retry both say "pending"
    const p = payload(req, fakeTx({ amount: req.amount, payTo: req.payTo }), pr.resource);
    const ok = await pay(path, p);
    expect(ok.status).toBe(200);
    expect(http.getPaymentSettleResponse((n) => ok.headers.get(n))).toMatchObject({ success: true, transaction: expect.stringMatching(/^pending-/) });
    expect(calls.handler).toBe(1);
    const replay = await pay(path, p);
    expect(replay.status).toBe(402);
    expect(calls.handler).toBe(1);
  });

  it("fails with 402 (no data) if settlement stays pending through the reconciliation window", async () => {
    const path = "/api/weather?city=Kobe";
    const { pr, req } = await quote(path);
    pendingSettles = 1000;
    const res = await pay(path, payload(req, fakeTx({ amount: req.amount, payTo: req.payTo }), pr.resource));
    pendingSettles = 0;
    expect(res.status).toBe(402);
    const body = await res.text();
    expect(body).not.toContain("temp");
  });
});
