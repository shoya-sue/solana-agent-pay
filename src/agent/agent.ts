/**
 * Claude tool-use agent that buys API calls on its own.
 *
 * Claude sees prices and its remaining budget and decides whether a call is worth paying for;
 * the SpendGuard (code, not the model) has the final say on every payment.
 */
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, TOKEN_DECIMALS, TOKEN_SYMBOL } from "../config.js";
import { fromAtomic } from "../lib/amount.js";
import { c, log } from "../lib/log.js";
import type { X402Client } from "./x402client.js";

/** USD per million tokens (input, output). Claude Sonnet 5.5 list price. */
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 1, out: 5 },
  "claude-opus-5-5": { in: 4, out: 20 },
};

export interface AgentUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

const tools: Anthropic.Tool[] = [
  {
    name: "list_paid_apis",
    description: "List the available paid API endpoints with their prices (free to call).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "request_api",
    description:
      "HTTP GET a paid API endpoint. If payment is required (HTTP 402) you get a quote with a quote_id, the price, " +
      "your per-call cap and remaining budget. Nothing is paid by this tool.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Endpoint path, e.g. /api/weather" },
        query: { type: "object", additionalProperties: { type: "string" }, description: 'Query params, e.g. {"city":"Tokyo"}' },
      },
      required: ["path"],
    },
  },
  {
    name: "pay_and_retry",
    description:
      "Pay a quote with SPL tokens on Solana devnet and retry the request with the payment proof. " +
      "Only call this if the price is worth it for the task and within your caps. The wallet will refuse payments " +
      "that violate the spending policy.",
    input_schema: {
      type: "object",
      properties: {
        quote_id: { type: "string" },
        justification: { type: "string", description: "One sentence: why this purchase is needed for the task." },
      },
      required: ["quote_id", "justification"],
    },
  },
  {
    name: "get_budget",
    description: "Show spending so far, remaining budget and the payment ledger.",
    input_schema: { type: "object", properties: {} },
  },
];

const fmt = (atomic: bigint | string) => `${fromAtomic(atomic, TOKEN_DECIMALS)} ${TOKEN_SYMBOL}`;

export class PayingAgent {
  private anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  readonly usage: AgentUsage = { model: CLAUDE_MODEL, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };

  constructor(private client: X402Client, private model = CLAUDE_MODEL, private maxTurns = 14) {
    this.usage.model = model;
  }

  private systemPrompt(): string {
    const p = this.client.guard.policy;
    return [
      "You are an autonomous research agent with a small crypto wallet on Solana devnet.",
      "Some data APIs are paywalled with HTTP 402 (x402). You can pay for them with the test stablecoin " + TOKEN_SYMBOL + ".",
      `Spending policy: per-call cap ${fmt(p.perCallCap)}, total budget ${fmt(p.totalBudget)}.`,
      "Rules: buy only what the task actually needs; never try to pay a quote above the per-call cap or your remaining budget;",
      "do not buy the same data twice; if something is too expensive, say so and continue with what you have.",
      "Answer the user in the language they used, concisely, and finish with a one-line summary of what you spent.",
    ].join("\n");
  }

  private async runTool(name: string, input: any): Promise<unknown> {
    const g = this.client.guard;
    switch (name) {
      case "list_paid_apis": {
        const r = await this.client.get("/catalog");
        return r.status === 200 ? r.body : { error: `catalog failed: ${r.status}` };
      }
      case "request_api": {
        const qs = new URLSearchParams((input.query ?? {}) as Record<string, string>).toString();
        const r = await this.client.get(qs ? `${input.path}?${qs}` : input.path);
        if (r.status === 402 && "quote" in r) {
          const q = r.quote;
          const req = q.requirement;
          const policy = g.evaluate(req);
          return {
            status: 402,
            quote_id: q.quoteId,
            resource: q.required.resource.url,
            description: q.required.resource.description,
            price: fmt(req.amount),
            pay_to: req.payTo,
            network: req.network,
            settled_by: "x402 facilitator (fee payer " + String(req.extra?.feePayer ?? "?") + ")",
            your_per_call_cap: fmt(g.policy.perCallCap),
            your_remaining_budget: fmt(g.remainingAtomic),
            policy_check: policy.allowed ? "allowed" : `would be refused: ${policy.reason}`,
          };
        }
        return { status: r.status, body: "body" in r ? r.body : null };
      }
      case "pay_and_retry": {
        log(c.dim(`   justification: ${input.justification}`));
        const r = await this.client.payAndRetry(String(input.quote_id));
        if (r.ok) {
          return {
            status: 200,
            paid: `${r.payment.amount} ${r.payment.symbol}`,
            tx: r.payment.signature,
            remaining_budget: fmt(g.remainingAtomic),
            data: (r.body as { data?: unknown })?.data ?? r.body,
          };
        }
        return { status: "refused_or_failed", code: r.code, reason: r.reason, remaining_budget: fmt(g.remainingAtomic) };
      }
      case "get_budget":
        return {
          spent: fmt(g.spentAtomic),
          remaining: fmt(g.remainingAtomic),
          per_call_cap: fmt(g.policy.perCallCap),
          payments: this.client.ledger.map((e) => ({ resource: e.resource, amount: `${e.amount} ${e.symbol}`, tx: e.signature })),
        };
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  async run(task: string): Promise<string> {
    log(`${c.bold("👤 Task:")} ${task}`);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const resp = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 2048,
        system: this.systemPrompt(),
        tools,
        messages,
      });
      this.trackUsage(resp.usage);

      for (const block of resp.content) {
        if (block.type === "text" && block.text.trim()) {
          if (resp.stop_reason === "tool_use") log(c.cyan(`🤖 ${block.text.trim()}`));
        }
      }
      if (resp.stop_reason !== "tool_use") {
        const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
        log("");
        log(c.bold("🤖 Final answer:"));
        for (const line of text.split("\n")) log(`   ${line}`);
        return text;
      }

      messages.push({ role: "assistant", content: resp.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        log(c.magenta(`🔧 ${block.name}(${JSON.stringify(block.input)})`));
        let out: unknown;
        try {
          out = await this.runTool(block.name, block.input);
        } catch (e) {
          out = { error: (e as Error).message };
        }
        log(c.dim(`   ↳ ${summarize(out)}`));
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
    }
    log(c.red("Agent stopped: max turns reached."));
    return "";
  }

  private trackUsage(u: Anthropic.Usage) {
    this.usage.inputTokens += u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    this.usage.outputTokens += u.output_tokens;
    const p = PRICING[this.model] ?? { in: 3, out: 15 };
    this.usage.estimatedUsd = (this.usage.inputTokens * p.in + this.usage.outputTokens * p.out) / 1e6;
  }
}

function summarize(out: unknown): string {
  const s = JSON.stringify(out);
  return s.length > 220 ? s.slice(0, 217) + "..." : s;
}
