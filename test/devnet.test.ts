/**
 * Optional live test against Solana devnet (real transactions, test token only), using the official
 * x402 packages and a real facilitator — both the public x402.org facilitator and the official facilitator
 * implementation run locally (fee payer = our throwaway funder wallet).
 * Run with: npm run test:devnet   (requires `npm run setup` to have funded the wallets)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Connection } from "@solana/web3.js";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import type { KeyPairSigner } from "@solana/kit";
import { NETWORK_DEVNET, PUBLIC_FACILITATOR_URL, RPC_URL, explorerTx } from "../src/config.js";
import { createApp, type PaidRoute } from "../src/server/app.js";
import { ReplayGuard } from "../src/server/replay.js";
import { createFacilitatorApp, createLocalFacilitator, inProcessFacilitatorClient } from "../src/facilitator/local.js";
import { SpendGuard } from "../src/agent/policy.js";
import { X402Client, createOfficialClient } from "../src/agent/x402client.js";
import { tokenBalance } from "../src/solana/balances.js";
import { loadState, type DevnetState } from "../src/solana/wallets.js";
import { loadKitSigner } from "../src/x402/signers.js";
import { bareClient, mismatchedPayload } from "../src/x402/attacks.js";

const enabled = process.env.DEVNET_TESTS === "1";
const modes = (process.env.DEVNET_FACILITATORS ?? "public,local,local-http").split(",");

const routes: PaidRoute[] = [
  { path: "/api/weather", price: "0.02", description: "weather (test)", params: {}, handler: async (q) => ({ city: q.get("city"), test: true }) },
  { path: "/api/air-quality", price: "0.01", description: "air quality (test)", params: {}, handler: async () => ({ aqi: 1, test: true }) },
];

async function waitForTx(connection: Connection, sig: string) {
  for (let i = 0; i < 20; i++) {
    const tx = await connection.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`tx ${sig} not found`);
}

describe.skipIf(!enabled).each(modes)("devnet: official x402 exact flow via %s facilitator", (mode) => {
  const connection = new Connection(RPC_URL, "confirmed");
  let state: DevnetState;
  let signer: KeyPairSigner;
  let facilitator: FacilitatorClient;
  let feePayer: string;
  let server: Server;
  let facServer: Server | undefined;
  let base: string;
  let agent: X402Client;
  let http: x402HTTPClient;

  beforeAll(async () => {
    // The public devnet RPC rate-limits (429); give it a breather between facilitator modes.
    if (modes.indexOf(mode) > 0) await new Promise((r) => setTimeout(r, Number(process.env.DEVNET_PAUSE_MS ?? 15_000)));
    state = loadState();
    signer = await loadKitSigner("agent");
    if (mode === "local") {
      const local = await createLocalFacilitator();
      facilitator = inProcessFacilitatorClient(local.facilitator);
    } else if (mode === "local-http") {
      // `npm run facilitator` equivalent, reached through the official HTTPFacilitatorClient
      const local = await createLocalFacilitator();
      facServer = createFacilitatorApp(local.facilitator).listen(0);
      await new Promise<void>((r) => facServer!.once("listening", () => r()));
      facilitator = new HTTPFacilitatorClient({ url: `http://localhost:${(facServer.address() as AddressInfo).port}` });
    } else {
      facilitator = new HTTPFacilitatorClient({ url: PUBLIC_FACILITATOR_URL });
    }
    const kind = (await facilitator.getSupported()).kinds.find((k) => k.network === NETWORK_DEVNET && k.scheme === "exact");
    feePayer = String(kind?.extra?.feePayer);
    const app = createApp({ payTo: state.server, mint: state.mint, facilitator, replayGuard: new ReplayGuard(), routes });
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", () => r()));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const guard = new SpendGuard({ perCallCap: 100_000n, totalBudget: 1_000_000n, allowedRecipients: [state.server], allowedAssets: [state.mint] });
    agent = new X402Client(base, createOfficialClient(signer, guard), guard);
    http = agent.http;
  }, 60_000);
  afterAll(() => {
    server?.close();
    facServer?.close();
  });

  let paid: { url: string; payload: Parameters<typeof http.encodePaymentSignatureHeader>[0] };

  it("valid payment: verify → handler → facilitator co-signs + broadcasts; funds land on-chain", async () => {
    const before = await tokenBalance(connection, state.mint, state.server);
    const q = await agent.get("/api/weather?city=Tokyo");
    expect(q.status).toBe(402);
    if (!("quote" in q)) throw new Error("no quote");
    expect(q.quote.requirement.extra?.feePayer).toBe(feePayer);
    const r = await agent.payAndRetry(q.quote.quoteId);
    if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
    expect(r.body).toEqual({ data: { city: "Tokyo", test: true } });
    expect(r.settlement.success).toBe(true);
    console.log(`[${mode}] settled: ${explorerTx(r.settlement.transaction)}`);
    const tx = await waitForTx(connection, r.settlement.transaction);
    expect(tx.meta?.err).toBeNull();
    expect(tx.transaction.message.accountKeys[0].pubkey.toBase58()).toBe(feePayer); // facilitator paid the fee
    expect(tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.toBase58() === state.agent)).toBe(true);
    const after = await tokenBalance(connection, state.mint, state.server);
    expect(after - before).toBe(20_000n);
    paid = agent.settledPayloads[0];
  }, 120_000);

  it("replay: the same PAYMENT-SIGNATURE is rejected by the server, and the facilitator will not settle it again", async () => {
    const res = await fetch(paid.url, { headers: http.encodePaymentSignatureHeader(paid.payload) });
    expect(res.status).toBe(402);
    const v = await facilitator.verify(paid.payload, paid.payload.accepted).catch(() => ({ isValid: false }));
    if (v.isValid) {
      const s = await facilitator.settle(paid.payload, paid.payload.accepted).catch(() => ({ success: false }));
      expect(s.success).toBe(false);
    }
  }, 120_000);

  it("wrong amount and wrong recipient are rejected by facilitator verify; no funds move", async () => {
    const before = await tokenBalance(connection, state.mint, state.server);
    const attacker = bareClient(signer);
    for (const change of [{ amount: "19999" }, { payTo: state.funder }]) {
      const res0 = await fetch(`${base}/api/weather?city=Osaka`);
      const pr = http.getPaymentRequiredResponse((n) => res0.headers.get(n));
      const bad = await mismatchedPayload(attacker, pr, change);
      const res = await fetch(`${base}/api/weather?city=Osaka`, { headers: http.encodePaymentSignatureHeader(bad) });
      expect(res.status).toBe(402);
      expect(http.getPaymentRequiredResponse((n) => res.headers.get(n)).error).toBeTruthy();
    }
    await new Promise((r) => setTimeout(r, 2000));
    expect(await tokenBalance(connection, state.mint, state.server)).toBe(before);
  }, 120_000);

  it("interop: an off-the-shelf @x402/fetch client pays our server", async () => {
    // Stock client config; our test mint is not a default asset, so it has to be allow-listed in spendControls.
    const core = x402Client.fromConfig({
      schemes: [{ network: NETWORK_DEVNET, client: new ExactSvmScheme(signer, { rpcUrl: RPC_URL }) }],
      spendControls: { allowedAssets: [{ network: NETWORK_DEVNET, asset: state.mint, maxAmountPerPayment: "50000" }] },
    });
    const res = await wrapFetchWithPayment(fetch, core)(`${base}/api/air-quality?city=Kyoto`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { aqi: 1, test: true } });
    const s = new x402HTTPClient(core).getPaymentSettleResponse((n) => res.headers.get(n));
    expect(s.success).toBe(true);
    console.log(`[${mode}] interop settled: ${explorerTx(s.transaction)}`);
  }, 120_000);
});
