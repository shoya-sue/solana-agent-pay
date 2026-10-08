/**
 * Throwaway devnet keypairs, stored in Solana-CLI JSON format under .wallets/ (git-ignored).
 */
import fs from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { WALLET_DIR } from "../config.js";

export type WalletName = "funder" | "agent" | "server" | "mint-authority";

function walletPath(name: WalletName): string {
  return path.join(WALLET_DIR, `${name}.keypair.json`);
}

export function loadOrCreateKeypair(name: WalletName): { keypair: Keypair; created: boolean } {
  fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  const p = walletPath(name);
  if (fs.existsSync(p)) {
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]);
    return { keypair: Keypair.fromSecretKey(secret), created: false };
  }
  const keypair = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, created: true };
}

export function loadKeypair(name: WalletName): Keypair {
  const p = walletPath(name);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}. Run \`npm run setup\` first.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]));
}

/** Public, non-secret state produced by setup (mint address, public keys). */
export interface DevnetState {
  network: string;
  mint: string;
  decimals: number;
  symbol: string;
  agent: string;
  server: string;
  funder: string;
  mintAuthority: string;
  createdAt: string;
}

const statePath = () => path.join(WALLET_DIR, "state.json");

export function saveState(s: DevnetState): void {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(s, null, 2));
}

export function loadState(): DevnetState {
  if (!fs.existsSync(statePath())) throw new Error("Missing .wallets/state.json. Run `npm run setup` first.");
  return JSON.parse(fs.readFileSync(statePath(), "utf8")) as DevnetState;
}

export function tryLoadState(): DevnetState | null {
  try {
    return loadState();
  } catch {
    return null;
  }
}

export const pk = (s: string) => new PublicKey(s);
