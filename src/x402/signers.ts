/** Load throwaway devnet keypairs as @solana/kit signers (used by the official @x402/svm package). */
import fs from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { WALLET_DIR } from "../config.js";
import type { WalletName } from "../solana/wallets.js";

export async function loadKitSigner(name: WalletName): Promise<KeyPairSigner> {
  const p = path.join(WALLET_DIR, `${name}.keypair.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}. Run \`npm run setup\` first.`);
  const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}
