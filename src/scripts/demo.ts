/**
 * One-command end-to-end demo on Solana devnet:
 *   wallets + funding → paid API server → Claude agent buys data via x402 → safety checks → transcript.
 * Output is also written (without colors) to demo-output.txt.
 */
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CLAUDE_MODEL, DATA_DIR, PROJECT_ROOT, RPC_URL, TOKEN_DECIMALS, TOKEN_SYMBOL, explorerAddress } from "../config.js";
import { fromAtomic } from "../lib/amount.js";
import { c, closeTee, log, section, teeTo } from "../lib/log.js";
import { setupDevnet, FundingError } from "../solana/setup.js";
import { createServer } from "../server/app.js";
import { FilePaymentStore } from "../server/store.js";
import { createAgentClient, DEFAULT_PER_CALL_CAP, DEFAULT_TOTAL_BUDGET } from "../agent/factory.js";
import { PayingAgent } from "../agent/agent.js";
import { HEADER_PAYMENT_REQUIRED, decodeHeader, type PaymentPayload, type PaymentRequired } from "../x402/types.js";

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
  log(c.bold("solana-agent-pay — an AI agent that pays for API calls by itself (Solana devnet, x402-style)"));
  log(c.dim(`run at ${new Date().toISOString()} · model ${CLAUDE_MODEL} · rpc ${RPC_URL}`));

  // 1. Wallets & funding
  section("1. Devnet wallets & funding");
  const state = await setupDevnet();

  // 2. Server
  section("2. Paid API server");
  const connection = new Connection(RPC_URL, "confirmed");
  const store = new FilePaymentStore(path.join(DATA_DIR, "payments.json"));
  const server = createServer({ payTo: state.server, mint: state.mint, store, connection, log: (m) => log(c.dim(`   [server] ${m}`)) });
  await new Promise<void>((r) => server.listen(Number(process.env.PORT ?? 0), r));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  log(`   listening on ${baseUrl}`);

  // Raw protocol view: what an unpaid request looks like
  const raw = await fetch(`${baseUrl}/api/weather?city=Tokyo`);
  const pr = decodeHeader<PaymentRequired>(raw.headers.get(HEADER_PAYMENT_REQUIRED)!);
  log(`   unpaid GET /api/weather?city=Tokyo → HTTP ${raw.status}, ${HEADER_PAYMENT_REQUIRED} (decoded):`);
  for (const line of JSON.stringify(pr, null, 2).split("\n")) log(c.dim(`     ${line}`));

  const { client, guard, wallet } = createAgentClient(state, baseUrl);
  const serverBalance = async () => {
    const ata = getAssociatedTokenAddressSync(new PublicKey(state.mint), new PublicKey(state.server));
    return (await getAccount(connection, ata, "confirmed")).amount;
  };
  const agentBefore = await wallet.tokenBalance(state.mint);
  const serverBefore = await serverBalance();
  log(`   agent ${TOKEN_SYMBOL} balance: ${fromAtomic(agentBefore, TOKEN_DECIMALS)} · server: ${fromAtomic(serverBefore, TOKEN_DECIMALS)}`);
  log(`   agent policy: per-call cap ${DEFAULT_PER_CALL_CAP} ${TOKEN_SYMBOL}, total budget ${DEFAULT_TOTAL_BUDGET} ${TOKEN_SYMBOL}, allowlist [${guard.policy.allowedRecipients.join(", ")}]`);

  // 3. Agent scenarios
  const agent = new PayingAgent(client);
  section("3. Scenario A — a task that needs paid data");
  await agent.run(TASKS[0]);
  section("4. Scenario B — a purchase above the per-call cap");
  await agent.run(TASKS[1]);

  // 5. Deterministic safety checks (no LLM involved)
  section("5. Safety checks");
  // a) wallet guard refuses over-cap price even if asked directly
  const premium = await client.get("/api/premium/forecast-report?city=Tokyo");
  if (premium.status === 402 && "quote" in premium) {
    const r = await client.payAndRetry(premium.quote.quoteId);
    log(r.ok ? c.red("   ✘ over-cap payment went through (unexpected)") : c.green(`   ✔ over-cap payment refused by wallet guard: ${r.code}`));
  }
  // b) recipient allowlist: a malicious 402 asking to pay someone else
  const weatherQuote = await client.get("/api/weather?city=Kyoto");
  if (weatherQuote.status === 402 && "quote" in weatherQuote) {
    const evil = { ...weatherQuote.quote.requirement, payTo: "Evi1111111111111111111111111111111111111111" };
    const d = guard.evaluate(evil);
    log(d.allowed ? c.red("   ✘ non-allowlisted recipient accepted (unexpected)") : c.green(`   ✔ tampered 402 (payTo changed) refused: ${d.code}`));
  }
  // c) server replay protection: resend a used signature
  const first = client.ledger[0];
  if (first) {
    const fresh = await client.get(first.resource);
    if (fresh.status === 402 && "quote" in fresh) {
      const proof: PaymentPayload = {
        x402Version: 2,
        accepted: fresh.quote.requirement,
        payload: { transaction: first.signature, payer: wallet.address },
      };
      const res = await client.retryWithProof(fresh.quote.url, proof);
      const body = (await res.json()) as { error?: string };
      log(res.status === 402 ? c.green(`   ✔ replayed signature rejected by server: HTTP ${res.status} (${body.error?.split(":")[0]})`) : c.red(`   ✘ replay accepted: HTTP ${res.status}`));
    }
  }

  // 6. Summary
  section("6. Summary");
  const agentAfter = await wallet.tokenBalance(state.mint);
  const serverAfter = await serverBalance();
  log(`   payments made by the agent: ${client.ledger.length}, total ${fromAtomic(guard.spentAtomic, TOKEN_DECIMALS)} ${TOKEN_SYMBOL} (budget ${DEFAULT_TOTAL_BUDGET})`);
  for (const e of client.ledger) {
    log(`   • ${e.amount} ${e.symbol}  ${e.resource}`);
    log(`     ${e.explorer}`);
  }
  log(`   agent ${TOKEN_SYMBOL}: ${fromAtomic(agentBefore, TOKEN_DECIMALS)} → ${fromAtomic(agentAfter, TOKEN_DECIMALS)}`);
  log(`   server ${TOKEN_SYMBOL}: ${fromAtomic(serverBefore, TOKEN_DECIMALS)} → ${fromAtomic(serverAfter, TOKEN_DECIMALS)}`);
  log(`   token mint (test SPL token, not Circle USDC): ${explorerAddress(state.mint)}`);
  log(`   agent wallet: ${explorerAddress(state.agent)}`);
  log(c.dim(`   Claude usage (${agent.usage.model}): ${agent.usage.inputTokens} in / ${agent.usage.outputTokens} out tokens ≈ $${agent.usage.estimatedUsd.toFixed(4)}`));

  // usage log for cost tracking (git-ignored)
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, "anthropic-usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...agent.usage }) + "\n");

  server.close();
  const ok = client.ledger.length > 0 && serverAfter - serverBefore === guard.spentAtomic;
  log(ok ? c.green(c.bold("\n✔ demo completed: on-chain received amount matches the agent's ledger")) : c.red("\n✘ demo finished with mismatches"));
  await closeTee();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  log(c.red(`✘ ${(e as Error).message}`));
  await closeTee();
  process.exit(e instanceof FundingError ? 2 : 1);
});
