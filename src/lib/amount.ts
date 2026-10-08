/** Helpers for converting between human token amounts and atomic units without floating point. */
export function toAtomic(human: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(human)) throw new Error(`Invalid amount: ${human}`);
  const [whole, frac = ""] = human.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimals in ${human} (max ${decimals})`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function fromAtomic(atomic: bigint | string, decimals: number): string {
  const a = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
