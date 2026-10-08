import { Connection } from "@solana/web3.js";
import { RPC_URL, TOKEN_DECIMALS } from "../config.js";
import { toAtomic } from "../lib/amount.js";
import { c, log } from "../lib/log.js";
import { loadKeypair, type DevnetState } from "../solana/wallets.js";
import { SpendGuard } from "./policy.js";
import { AgentWallet } from "./wallet.js";
import { X402Client } from "./x402client.js";

export const DEFAULT_PER_CALL_CAP = process.env.AGENT_PER_CALL_CAP ?? "0.10";
export const DEFAULT_TOTAL_BUDGET = process.env.AGENT_TOTAL_BUDGET ?? "0.30";

/** Wire up wallet + guard + x402 client with console logging of every payment event. */
export function createAgentClient(state: DevnetState, serverUrl: string) {
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new AgentWallet(connection, loadKeypair("agent"));
  const allowed = (process.env.ALLOWED_RECIPIENTS ?? state.server).split(",").map((s) => s.trim()).filter(Boolean);
  const guard = new SpendGuard({
    perCallCap: toAtomic(DEFAULT_PER_CALL_CAP, TOKEN_DECIMALS),
    totalBudget: toAtomic(DEFAULT_TOTAL_BUDGET, TOKEN_DECIMALS),
    allowedRecipients: allowed,
    allowedAssets: [state.mint],
  });
  const client = new X402Client(serverUrl, wallet, guard, {
    onPaymentRequired: (q) =>
      log(c.yellow(`   💳 402 Payment Required: ${q.required.resource.url} → ${Number(q.requirement.amount) / 10 ** TOKEN_DECIMALS} ${q.requirement.extra.symbol} (memo ${q.requirement.extra.memo})`)),
    onPolicyDenied: (_q, code, reason) => log(c.red(`   🛑 wallet refused to pay [${code}]: ${reason}`)),
    onPaid: (e) => log(c.green(`   💸 PAID ${e.amount} ${e.symbol} for ${e.resource}\n      tx: ${e.explorer}`)),
    onRetry: (_q, status) => log((status === 200 ? c.green : c.red)(`   🔁 retried with PAYMENT-SIGNATURE → HTTP ${status}`)),
  });
  return { connection, wallet, guard, client };
}
