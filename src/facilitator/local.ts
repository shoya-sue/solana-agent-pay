/**
 * Local x402 facilitator built from the official implementation (@x402/core x402Facilitator +
 * @x402/svm exact scheme). It verifies the client's partially-signed transaction, co-signs it as
 * fee payer (the throwaway `funder` devnet wallet) and broadcasts it. Devnet only.
 *
 * Exposed two ways:
 *  - `inProcessFacilitatorClient()` — a FacilitatorClient object for the resource server (no HTTP hop)
 *  - `createFacilitatorApp()`       — the standard HTTP endpoints (/supported, /verify, /settle)
 */
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { NETWORK_DEVNET, RPC_URL, assertDevnetUrl } from "../config.js";
import { loadKitSigner } from "../x402/signers.js";

export async function createLocalFacilitator(): Promise<{ facilitator: x402Facilitator; feePayer: string }> {
  assertDevnetUrl();
  const funder = await loadKitSigner("funder");
  const signer = toFacilitatorSvmSigner(funder, { defaultRpcUrl: RPC_URL });
  const facilitator = new x402Facilitator();
  registerExactSvmScheme(facilitator, { signer, networks: NETWORK_DEVNET });
  return { facilitator, feePayer: funder.address };
}

export function inProcessFacilitatorClient(f: x402Facilitator): FacilitatorClient {
  return {
    verify: (p: PaymentPayload, r: PaymentRequirements) => f.verify(p, r),
    settle: (p: PaymentPayload, r: PaymentRequirements) => f.settle(p, r),
    getSupported: async () => f.getSupported() as never,
  } as FacilitatorClient;
}

export function createFacilitatorApp(f: x402Facilitator) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.get("/supported", (_req, res) => {
    res.json(f.getSupported());
  });
  app.post("/verify", async (req, res) => {
    try {
      res.json(await f.verify(req.body.paymentPayload, req.body.paymentRequirements));
    } catch (e) {
      res.status(400).json({ isValid: false, invalidReason: "verify_error", invalidMessage: (e as Error).message });
    }
  });
  app.post("/settle", async (req, res) => {
    try {
      res.json(await f.settle(req.body.paymentPayload, req.body.paymentRequirements));
    } catch (e) {
      res.status(400).json({ success: false, errorReason: "settle_error", errorMessage: (e as Error).message, transaction: "", network: NETWORK_DEVNET });
    }
  });
  return app;
}
