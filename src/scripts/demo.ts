/**
 * One-command end-to-end demo on Solana devnet, using the official x402 packages:
 *   wallets + funding → paid API server (@x402/express) → Claude agent buys data (@x402/core + @x402/svm)
 *   → facilitator settles on-chain → an off-the-shelf @x402/fetch client pays too → safety checks → transcript.
 * Output is also written (without colors) to demo-output.txt.
 */
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Connection } from "@solana/web3.js";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  CLAUDE_MODEL,
  DATA_DIR,
  NETWORK_DEVNET,
  PROJECT_ROOT,
  RPC_URL,
  TOKEN_DECIMALS,
  TOKEN_SYMBOL,
  explorerAddress,
  explorerTx,
} from "../config.js";
import { fromAtomic, toAtomic } from "../lib/amount.js";
import { c, closeTee, log, section, teeTo } from "../lib/log.js";
import { setupDevnet, FundingError } from "../solana/setup.js";
import { tokenBalance } from "../solana/balances.js";
import { ROUTES, createApp } from "../server/app.js";
import { resolveFacilitator } from "../server/facilitator.js";
import { ReplayGuard } from "../server/replay.js";
import { createAgentClient, DEFAULT_PER_CALL_CAP, DEFAULT_TOTAL_BUDGET } from "../agent/factory.js";
import { PayingAgent } from "../agent/agent.js";
import { bareClient, mismatchedPayload } from "../x402/attacks.js";

const OUT = process.env.DEMO_OUTPUT ?? path.join(PROJECT_ROOT, "demo-output.txt");
const TASKS = [
  process.env.DEMO_TASK_1 ??
    "東京と大阪の今日の天気と空気の質を比べて、夕方に散歩するならどちらが向いているか教えてください。",
  process.env.DEMO_TASK_2 ??
    "東京のプレミアム48時間予報レポートを買って、明日いちばん雨の確率が低い時間帯を教えて。",
];

async function main() {
  teeTo(OUT);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example).");
  log(c.bold("solana-agent-pay — an AI agent that pays for API calls by itself (official x402 on Solana devnet)"));
  log(c.dim(`run at ${new Date().toISOString()} · model ${CLAUDE_MODEL} · rpc ${RPC_URL}`));

  // 1. Wallets & funding
  section("1. Devnet wallets & funding");
  const state = await setupDevnet();

  // 2. Server + facilitator
  section("2. Paid API server (@x402/express) + facilitator");
  const connection = new Connection(RPC_URL, "confirmed");
  const fac = await resolveFacilitator();
  const supported = await fac.client.getSupported();
  const kind = supported.kinds.find((k) => k.network === NETWORK_DEVNET && k.scheme === "exact");
  if (!kind) throw new Error(`Facilitator ${fac.label} does not support exact on ${NETWORK_DEVNET}`);
  log(`   facilitator: ${fac.label}`);
  log(`   /supported → x402 v${kind.x402Version} · ${kind.scheme} · ${kind.network} · feePayer ${String(kind.extra?.feePayer)}`);
  const app = createApp({
    payTo: state.server,
    mint: state.mint,
    facilitator: fac.client,
    facilitatorLabel: fac.label,
    replayGuard: new ReplayGuard(path.join(DATA_DIR, "settled-payments.json")),
    log: (m) => log(c.dim(`   [server] ${m}`)),
  });
  const server = app.listen(Number(process.env.PORT ?? 0));
  await new Promise<void>((r) => server.once("listening", () => r()));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  log(`   listening on ${baseUrl}`);

  const { client, guard, signer } = await createAgentClient(state, baseUrl);
  // Raw protocol view: what an unpaid request looks like
  const raw = await fetch(`${baseUrl}/api/weather?city=Tokyo`);
  const pr = client.http.getPaymentRequiredResponse((n) => raw.headers.get(n));
  log(`   unpaid GET /api/weather?city=Tokyo → HTTP ${raw.status}, PAYMENT-REQUIRED (decoded):`);
  for (const line of JSON.stringify(pr, null, 2).split("\n")) log(c.dim(`     ${line}`));

  const agentBefore = await tokenBalance(connection, state.mint, state.agent);
  const serverBefore = await tokenBalance(connection, state.mint, state.server);
  log(`   agent ${TOKEN_SYMBOL} balance: ${fromAtomic(agentBefore, TOKEN_DECIMALS)} · server: ${fromAtomic(serverBefore, TOKEN_DECIMALS)}`);
  log(`   agent policy: per-call cap ${DEFAULT_PER_CALL_CAP} ${TOKEN_SYMBOL}, total budget ${DEFAULT_TOTAL_BUDGET} ${TOKEN_SYMBOL}, allowlist [${guard.policy.allowedRecipients.join(", ")}]`);

  // 3/4. Agent scenarios
  const agent = new PayingAgent(client);
  section("3. Scenario A — a task that needs paid data");
  await agent.run(TASKS[0]);
  section("4. Scenario B — a purchase above the per-call cap");
  await agent.run(TASKS[1]);

  // 5. Interop: a stock official client (no custom code) pays our server
  section("5. Interop — an off-the-shelf @x402/fetch client pays the server");
  const interopCore = x402Client.fromConfig({
    schemes: [{ network: NETWORK_DEVNET, client: new ExactSvmScheme(signer, { rpcUrl: RPC_URL }) }],
    spendControls: { allowedAssets: [{ network: NETWORK_DEVNET, asset: state.mint, maxAmountPerPayment: "50000" }] },
  });
  const payingFetch = wrapFetchWithPayment(fetch, interopCore);
  const interopRes = await payingFetch(`${baseUrl}/api/air-quality?city=Kyoto`);
  let interopPaid = 0n;
  const interopTxs: string[] = [];
  if (interopRes.status === 200) {
    const s = new x402HTTPClient(interopCore).getPaymentSettleResponse((n) => interopRes.headers.get(n));
    interopPaid = toAtomic(ROUTES.find((r) => r.path === "/api/air-quality")!.price, TOKEN_DECIMALS);
    interopTxs.push(s.transaction);
    const body = (await interopRes.json()) as { data: unknown };
    log(c.green(`   ✔ wrapFetchWithPayment(fetch, x402Client) → HTTP 200, PAYMENT-RESPONSE success=${s.success}`));
    log(`     data: ${JSON.stringify(body.data).slice(0, 140)}…`);
    log(`     tx: ${explorerTx(s.transaction)}`);
  } else {
    log(c.red(`   ✘ official client got HTTP ${interopRes.status}`));
  }

  // 6. Deterministic safety checks (no LLM involved)
  section("6. Safety checks");
  // a) wallet guard refuses over-cap price even if asked directly
  const premium = await client.get("/api/premium/forecast-report?city=Tokyo");
  if (premium.status === 402 && "quote" in premium) {
    const r = await client.payAndRetry(premium.quote.quoteId);
    log(r.ok ? c.red("   ✘ over-cap payment went through (unexpected)") : c.green(`   ✔ over-cap payment refused by the agent's wallet guard before signing: ${r.code}`));
  }
  // b) recipient allowlist: a malicious 402 asking to pay someone else
  const weatherQuote = await client.get("/api/weather?city=Kyoto");
  if (weatherQuote.status === 402 && "quote" in weatherQuote) {
    const evil = { ...weatherQuote.quote.requirement, payTo: "Evi1111111111111111111111111111111111111111" };
    const d = guard.evaluate(evil);
    let officialRefused = "";
    try {
      await client.core.createPaymentPayload({ ...weatherQuote.quote.required, accepts: [evil] });
    } catch (e) {
      officialRefused = (e as Error).message.split("\n")[0].slice(0, 90);
    }
    log(
      !d.allowed && officialRefused
        ? c.green(`   ✔ tampered 402 (payTo changed) refused: SpendGuard ${d.code}; official client policy → "${officialRefused}"`)
        : c.red("   ✘ non-allowlisted recipient accepted (unexpected)"),
    );
  }
  // c) replay: resend a PAYMENT-SIGNATURE that already settled
  const used = client.settledPayloads[0];
  if (used) {
    const res = await fetch(used.url, { headers: client.http.encodePaymentSignatureHeader(used.payload) });
    log(res.status === 402 ? c.green(`   ✔ replayed PAYMENT-SIGNATURE rejected by server: HTTP 402 (${client.rejectionReason(res)})`) : c.red(`   ✘ replay accepted: HTTP ${res.status}`));
    // …and the facilitator alone rejects it too (bypassing our server-side guard)
    const v = await fac.client.verify(used.payload, used.payload.accepted).catch((e: Error) => ({ isValid: false, invalidReason: e.message.slice(0, 80) }));
    let settledAgain = false;
    if (v.isValid) settledAgain = (await fac.client.settle(used.payload, used.payload.accepted).catch(() => ({ success: false }))).success;
    log(
      !settledAgain
        ? c.green(`   ✔ same payload sent straight to the facilitator: ${v.isValid ? "verify ok but settle refused" : `verify rejected (${"invalidReason" in v ? v.invalidReason : "invalid"})`} — no double charge`)
        : c.red("   ✘ facilitator settled a replayed payload"),
    );
  }
  // d) wrong amount / e) wrong recipient: signed tx disagrees with the claimed requirement
  const attacker = bareClient(signer);
  for (const [label, change] of [
    ["tx pays 0.019999 but claims 0.02", { amount: "19999" }],
    ["tx pays another wallet but claims the server's payTo", { payTo: state.funder }],
  ] as const) {
    const q = await client.get("/api/weather?city=Sapporo");
    if (q.status !== 402 || !("quote" in q)) continue;
    const bad = await mismatchedPayload(attacker, q.quote.required, change);
    const res = await fetch(q.quote.url, { headers: client.http.encodePaymentSignatureHeader(bad) });
    log(res.status === 402 ? c.green(`   ✔ ${label} → rejected by facilitator verify: HTTP 402 (${client.rejectionReason(res)})`) : c.red(`   ✘ ${label} → HTTP ${res.status}`));
  }

  // 7. Summary
  section("7. Summary");
  await new Promise((r) => setTimeout(r, 1500));
  const agentAfter = await tokenBalance(connection, state.mint, state.agent);
  const serverAfter = await tokenBalance(connection, state.mint, state.server);
  log(`   payments made by the Claude agent: ${client.ledger.length}, total ${fromAtomic(guard.spentAtomic, TOKEN_DECIMALS)} ${TOKEN_SYMBOL} (budget ${DEFAULT_TOTAL_BUDGET})`);
  for (const e of client.ledger) {
    log(`   • ${e.amount} ${e.symbol}  ${e.resource}`);
    log(`     ${e.explorer}`);
  }
  for (const t of interopTxs) {
    log(`   • ${fromAtomic(interopPaid, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}  /api/air-quality?city=Kyoto  (official @x402/fetch client)`);
    log(`     ${explorerTx(t)}`);
  }
  log(`   agent ${TOKEN_SYMBOL}: ${fromAtomic(agentBefore, TOKEN_DECIMALS)} → ${fromAtomic(agentAfter, TOKEN_DECIMALS)}`);
  log(`   server ${TOKEN_SYMBOL}: ${fromAtomic(serverBefore, TOKEN_DECIMALS)} → ${fromAtomic(serverAfter, TOKEN_DECIMALS)}`);
  log(`   network fees paid by the facilitator's fee payer ${String(kind.extra?.feePayer)} (agent pays 0 SOL)`);
  log(`   token mint (test SPL token, not Circle USDC): ${explorerAddress(state.mint)}`);
  log(`   agent wallet: ${explorerAddress(state.agent)}`);
  log(c.dim(`   Claude usage (${agent.usage.model}): ${agent.usage.inputTokens} in / ${agent.usage.outputTokens} out tokens ≈ $${agent.usage.estimatedUsd.toFixed(4)}`));

  // usage log for cost tracking (git-ignored)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, "anthropic-usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...agent.usage }) + "\n");

  server.close();
  const expected = guard.spentAtomic + interopPaid;
  const ok = client.ledger.length > 0 && interopTxs.length === 1 && serverAfter - serverBefore === expected && agentBefore - agentAfter === expected;
  log(ok ? c.green(c.bold("\n✔ demo completed: on-chain amounts match the agent's ledger + the interop payment")) : c.red("\n✘ demo finished with mismatches"));
  await closeTee();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  log(c.red(`✘ ${(e as Error).message}`));
  await closeTee();
  process.exit(e instanceof FundingError ? 2 : 1);
});
