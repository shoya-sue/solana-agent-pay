/**
 * Central configuration. Everything here is devnet-only by design.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, "..");

// Load .env if present (Node >= 20.12). Existing env vars win.
try {
  process.loadEnvFile(path.join(PROJECT_ROOT, ".env"));
} catch {
  /* no .env — fine */
}

/** Solana devnet RPC. Override with SOLANA_RPC_URL (must still be a devnet endpoint). */
export const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/** CAIP-2 identifier for Solana devnet, as used by x402 v2. */
export const NETWORK_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
/** Solana devnet genesis hash (the CAIP-2 reference above is its truncated form). */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/** Where throwaway devnet keypairs and the generated mint address live (git-ignored). */
export const WALLET_DIR = process.env.WALLET_DIR ?? path.join(PROJECT_ROOT, ".wallets");
/** Server-side runtime state (issued nonces, consumed signatures) (git-ignored). */
export const DATA_DIR = process.env.DATA_DIR ?? path.join(PROJECT_ROOT, "data");

/** Test token: 6 decimals, like USDC. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "dUSDC";

export const SERVER_PORT = Number(process.env.PORT ?? 4021);

/**
 * x402 facilitator that verifies + settles payments (co-signs as fee payer and broadcasts).
 *  - default: the public x402.org facilitator (supports `exact` on Solana devnet, no signup)
 *  - FACILITATOR=local: run the official @x402/core + @x402/svm facilitator in-process, with the
 *    project's throwaway `funder` devnet wallet as fee payer
 *  - FACILITATOR_URL=...: any other x402 v2 facilitator
 */
export const PUBLIC_FACILITATOR_URL = "https://x402.org/facilitator";
export const FACILITATOR_MODE = (process.env.FACILITATOR ?? "public").toLowerCase();
export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? PUBLIC_FACILITATOR_URL;
export const LOCAL_FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT ?? 4022);

/** Claude model for the agent's reasoning (picked from GET /v1/models; Sonnet-class for cost). */
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";

const IS_LOCAL = /localhost|127\.0\.0\.1/.test(RPC_URL);
const clusterParam = IS_LOCAL ? `cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : "cluster=devnet";
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?${clusterParam}`;
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?${clusterParam}`;

/** Hard guard: refuse to run against anything that is not devnet. */
export function assertDevnetUrl(url: string = RPC_URL): void {
  const u = url.toLowerCase();
  if (u.includes("mainnet") || !(u.includes("devnet") || u.includes("localhost") || u.includes("127.0.0.1"))) {
    throw new Error(`Refusing to use non-devnet RPC endpoint: ${url}. This demo is devnet-only.`);
  }
}
