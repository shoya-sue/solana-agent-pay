import path from "node:path";
import { Connection } from "@solana/web3.js";
import { DATA_DIR, RPC_URL, SERVER_PORT, assertDevnetUrl } from "../config.js";
import { loadState } from "../solana/wallets.js";
import { createServer } from "./app.js";
import { FilePaymentStore } from "./store.js";

assertDevnetUrl();
const state = loadState();
const server = createServer({
  payTo: state.server,
  mint: state.mint,
  store: new FilePaymentStore(path.join(DATA_DIR, "payments.json")),
  connection: new Connection(RPC_URL, "confirmed"),
  log: (m) => console.log(`[server] ${m}`),
});
server.listen(SERVER_PORT, () => {
  console.log(`[server] paid API listening on http://localhost:${SERVER_PORT}  (payTo=${state.server}, mint=${state.mint})`);
});
