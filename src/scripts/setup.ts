import { setupDevnet, FundingError } from "../solana/setup.js";
import { c, log, section } from "../lib/log.js";

section("Devnet setup");
try {
  const s = await setupDevnet();
  log(c.green(`\n✔ ready. mint=${s.mint} agent=${s.agent} server=${s.server}`));
} catch (e) {
  log(c.red(`✘ ${(e as Error).message}`));
  process.exit(e instanceof FundingError ? 2 : 1);
}
