import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** SPL token balance (atomic units) of `owner`'s associated token account; 0 if it does not exist. */
export async function tokenBalance(connection: Connection, mint: string, owner: string): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner));
    return (await getAccount(connection, ata, "confirmed")).amount;
  } catch {
    return 0n;
  }
}
