/** The agent's devnet wallet: builds, signs and broadcasts SPL TransferChecked + Memo payments. */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { MEMO_PROGRAM_ID } from "../server/verify.js";
import type { PaymentRequirements } from "../x402/types.js";

export class AgentWallet {
  constructor(readonly connection: Connection, readonly keypair: Keypair) {}

  get address() {
    return this.keypair.publicKey.toBase58();
  }

  async tokenBalance(mint: string): Promise<bigint> {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), this.keypair.publicKey);
    try {
      return (await getAccount(this.connection, ata, "confirmed")).amount;
    } catch {
      return 0n;
    }
  }

  /** Pay exactly `req.amount` of `req.asset` to `req.payTo`'s ATA, tagging the tx with the memo reference. */
  async pay(req: PaymentRequirements): Promise<string> {
    const mint = new PublicKey(req.asset);
    const owner = this.keypair.publicKey;
    const source = getAssociatedTokenAddressSync(mint, owner);
    const destination = getAssociatedTokenAddressSync(mint, new PublicKey(req.payTo));

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      createTransferCheckedInstruction(source, mint, destination, owner, BigInt(req.amount), req.extra.decimals),
      new TransactionInstruction({
        programId: new PublicKey(MEMO_PROGRAM_ID),
        keys: [{ pubkey: owner, isSigner: true, isWritable: false }],
        data: Buffer.from(req.extra.memo, "utf8"),
      }),
    );
    return sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: "confirmed" });
  }
}
