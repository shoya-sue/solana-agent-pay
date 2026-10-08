import { TOKEN_DECIMALS } from "../config.js";
import { toAtomic } from "../lib/amount.js";
import { c, log } from "../lib/log.js";
import type { DevnetState } from "../solana/wallets.js";
import { loadKitSigner } from "../x402/signers.js";
import { SpendGuard } from "./policy.js";
import { X402Client, createOfficialClient } from "./x402client.js";

export const DEFAULT_PER_CALL_CAP = process.env.AGENT_PER_CALL_CAP ?? "0.10";
export const DEFAULT_TOTAL_BUDGET = process.env.AGENT_TOTAL_BUDGET ?? "0.30";

/** Wire up the agent's signer + SpendGuard + official x402 client, logging every payment event. */
export async function createAgentClient(state: DevnetState, serverUrl: string) {
  const signer = await loadKitSigner("agent");
  const allowed = (process.env.ALLOWED_RECIPIENTS ?? state.server).split(",").map((s) => s.trim()).filter(Boolean);
  const guard = new SpendGuard({
    perCallCap: toAtomic(DEFAULT_PER_CALL_CAP, TOKEN_DECIMALS),
    totalBudget: toAtomic(DEFAULT_TOTAL_BUDGET, TOKEN_DECIMALS),
    allowedRecipients: allowed,
    allowedAssets: [state.mint],
  });
  const core = createOfficialClient(signer, guard);
  const client = new X402Client(serverUrl, core, guard, {
    onPaymentRequired: (q) =>
      log(c.yellow(`   💳 402 Payment Required: ${new URL(q.url).pathname}${new URL(q.url).search} → ${client.displayAmount(q.requirement)} (feePayer ${String(q.requirement.extra?.feePayer ?? "?").slice(0, 8)}…)`)),
    onPolicyDenied: (_q, code, reason) => log(c.red(`   🛑 wallet refused to pay [${code}]: ${reason}`)),
    onSigned: () => log(c.dim(`   ✍️  official @x402/svm client built + partially signed the transfer → retry with PAYMENT-SIGNATURE`)),
    onPaid: (e) => log(c.green(`   💸 PAID ${e.amount} ${e.symbol} for ${e.resource} (settled by facilitator)\n      tx: ${e.explorer}`)),
    onRejected: (_q, status, reason) => log(c.red(`   ✘ payment rejected → HTTP ${status} (${reason})`)),
  });
  return { signer, guard, client };
}
