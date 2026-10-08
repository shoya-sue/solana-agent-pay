/** `npm run facilitator` — run the official x402 facilitator locally against Solana devnet. */
import { LOCAL_FACILITATOR_PORT } from "../config.js";
import { createFacilitatorApp, createLocalFacilitator } from "./local.js";

const { facilitator, feePayer } = await createLocalFacilitator();
createFacilitatorApp(facilitator).listen(LOCAL_FACILITATOR_PORT, () => {
  console.log(`[facilitator] official x402 facilitator (exact / Solana devnet) on http://localhost:${LOCAL_FACILITATOR_PORT}  feePayer=${feePayer}`);
});
