import path from "node:path";
import { DATA_DIR, SERVER_PORT, assertDevnetUrl } from "../config.js";
import { loadState } from "../solana/wallets.js";
import { createApp } from "./app.js";
import { resolveFacilitator } from "./facilitator.js";
import { ReplayGuard } from "./replay.js";

assertDevnetUrl();
const state = loadState();
const { client, label } = await resolveFacilitator();
const app = createApp({
  payTo: state.server,
  mint: state.mint,
  facilitator: client,
  facilitatorLabel: label,
  replayGuard: new ReplayGuard(path.join(DATA_DIR, "settled-payments.json")),
  log: (m) => console.log(`[server] ${m}`),
});
app.listen(SERVER_PORT, () => {
  console.log(`[server] paid API on http://localhost:${SERVER_PORT}  payTo=${state.server} mint=${state.mint}  facilitator=${label}`);
});
