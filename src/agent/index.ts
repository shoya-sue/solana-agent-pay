/** CLI: run the paying agent against a running server.  npm run agent -- "your task" */
import { SERVER_PORT, CLAUDE_MODEL } from "../config.js";
import { c, log, section } from "../lib/log.js";
import { loadState } from "../solana/wallets.js";
import { createAgentClient } from "./factory.js";
import { PayingAgent } from "./agent.js";

const task = process.argv.slice(2).join(" ") || "東京と大阪の今日の天気を比べて、散歩に向いているのはどちらか教えて。";
const serverUrl = process.env.SERVER_URL ?? `http://localhost:${SERVER_PORT}`;
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (see .env.example).");
  process.exit(1);
}
const { client } = await createAgentClient(loadState(), serverUrl);
section(`Agent (${CLAUDE_MODEL})`);
const agent = new PayingAgent(client);
await agent.run(task);
section("Payments");
for (const e of client.ledger) log(`${e.amount} ${e.symbol}  ${e.resource}\n   ${e.explorer}`);
log(c.dim(`Claude usage: ${agent.usage.inputTokens} in / ${agent.usage.outputTokens} out tokens ≈ $${agent.usage.estimatedUsd.toFixed(4)}`));
