/**
 * Idempotent devnet setup: throwaway keypairs, SOL via airdrop (with backoff), a test SPL token
 * ("dUSDC", 6 decimals, minted by us — NOT Circle's devnet USDC), token accounts, and agent funding.
 */
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { DEVNET_GENESIS_HASH, NETWORK_DEVNET, RPC_URL, TOKEN_DECIMALS, TOKEN_SYMBOL, assertDevnetUrl, explorerAddress, explorerTx } from "../config.js";
import { toAtomic } from "../lib/amount.js";
import { c, log } from "../lib/log.js";
import { loadOrCreateKeypair, saveState, tryLoadState, type DevnetState } from "./wallets.js";

const MIN_FUNDER_SOL = 0.015; // mint rent + 2 ATAs + agent fee float ≈ 0.012 SOL
const AGENT_SOL = 0.006; // ~1000 payments worth of fees
const AGENT_TOKEN_TARGET = "5"; // dUSDC

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function airdropWithBackoff(connection: Connection, to: PublicKey, sol: number, attempts = 6) {
  let delay = 2000;
  for (let i = 1; i <= attempts; i++) {
    try {
      const sig = await connection.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL));
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      log(c.green(`   airdrop ${sol} SOL ok: ${explorerTx(sig)}`));
      return true;
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0].slice(0, 140);
      log(c.yellow(`   airdrop attempt ${i}/${attempts} failed (${msg}); retrying in ${delay / 1000}s`));
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
      sol = Math.max(0.1, sol / 2); // ask for less on retry
    }
  }
  return false;
}

export class FundingError extends Error {}

export async function setupDevnet(connection = new Connection(RPC_URL, "confirmed")): Promise<DevnetState> {
  assertDevnetUrl();
  const genesis = await connection.getGenesisHash();
  const isLocal = /localhost|127\.0\.0\.1/.test(RPC_URL);
  if (genesis !== DEVNET_GENESIS_HASH) {
    if (!isLocal) throw new Error(`RPC is not Solana devnet (genesis ${genesis}).`);
    log(c.yellow("   ⚠ local test validator detected (smoke-test mode, not devnet)"));
  }

  const funder = loadOrCreateKeypair("funder");
  const agent = loadOrCreateKeypair("agent");
  const server = loadOrCreateKeypair("server");
  log(`   funder (fees + mint authority): ${funder.keypair.publicKey.toBase58()}${funder.created ? c.dim(" (new)") : ""}`);
  log(`   agent  (payer)                : ${agent.keypair.publicKey.toBase58()}${agent.created ? c.dim(" (new)") : ""}`);
  log(`   server (payTo / recipient)    : ${server.keypair.publicKey.toBase58()}${server.created ? c.dim(" (new)") : ""}`);

  // 1. SOL for fees
  const funderBal = (await connection.getBalance(funder.keypair.publicKey)) / LAMPORTS_PER_SOL;
  log(`   funder balance: ${funderBal} SOL`);
  if (funderBal < MIN_FUNDER_SOL) {
    log("   requesting devnet airdrop for funder ...");
    const ok = await airdropWithBackoff(connection, funder.keypair.publicKey, 1);
    if (!ok) {
      throw new FundingError(
        `Devnet airdrop is rate-limited. Send ~0.05 devnet SOL to ${funder.keypair.publicKey.toBase58()} ` +
          `(e.g. https://faucet.solana.com) and re-run. No other step needs SOL.`,
      );
    }
  }
  const agentBal = (await connection.getBalance(agent.keypair.publicKey)) / LAMPORTS_PER_SOL;
  if (agentBal < AGENT_SOL / 2) {
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: funder.keypair.publicKey,
          toPubkey: agent.keypair.publicKey,
          lamports: Math.round(AGENT_SOL * LAMPORTS_PER_SOL),
        }),
      ),
      [funder.keypair],
      { commitment: "confirmed" },
    );
    log(`   sent ${AGENT_SOL} SOL to agent for tx fees: ${explorerTx(sig)}`);
  }

  // 2. Test SPL token (reuse if it already exists on-chain)
  let mint: PublicKey | null = null;
  const prev = tryLoadState();
  if (prev?.mint) {
    try {
      const m = await getMint(connection, new PublicKey(prev.mint));
      if (m.mintAuthority?.equals(funder.keypair.publicKey)) mint = m.address;
    } catch {
      /* not found → recreate */
    }
  }
  if (!mint) {
    mint = await createMint(connection, funder.keypair, funder.keypair.publicKey, null, TOKEN_DECIMALS);
    log(c.green(`   created test SPL token ${TOKEN_SYMBOL} (${TOKEN_DECIMALS} decimals): ${mint.toBase58()}`));
  } else {
    log(`   reusing test SPL token ${TOKEN_SYMBOL}: ${mint.toBase58()}`);
  }

  // 3. Token accounts (funder pays rent for both, so the server wallet needs no SOL)
  const agentAta = await getOrCreateAssociatedTokenAccount(connection, funder.keypair, mint, agent.keypair.publicKey);
  await getOrCreateAssociatedTokenAccount(connection, funder.keypair, mint, server.keypair.publicKey);

  // 4. Fund the agent with test tokens
  const target = toAtomic(AGENT_TOKEN_TARGET, TOKEN_DECIMALS);
  if (agentAta.amount < target / 2n) {
    const sig = await mintTo(connection, funder.keypair, mint, agentAta.address, funder.keypair, target - agentAta.amount);
    log(`   minted ${TOKEN_SYMBOL} to agent: ${explorerTx(sig)}`);
  }

  const state: DevnetState = {
    network: NETWORK_DEVNET,
    mint: mint.toBase58(),
    decimals: TOKEN_DECIMALS,
    symbol: TOKEN_SYMBOL,
    agent: agent.keypair.publicKey.toBase58(),
    server: server.keypair.publicKey.toBase58(),
    funder: funder.keypair.publicKey.toBase58(),
    mintAuthority: funder.keypair.publicKey.toBase58(),
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  saveState(state);
  log(`   mint:   ${explorerAddress(state.mint)}`);
  return state;
}
