/** Pick the facilitator for the resource server: public x402.org (default), local official impl, or a custom URL. */
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { FACILITATOR_MODE, FACILITATOR_URL } from "../config.js";
import { createLocalFacilitator, inProcessFacilitatorClient } from "../facilitator/local.js";

export async function resolveFacilitator(): Promise<{ client: FacilitatorClient; label: string }> {
  if (FACILITATOR_MODE === "local") {
    const { facilitator, feePayer } = await createLocalFacilitator();
    return { client: inProcessFacilitatorClient(facilitator), label: `local official facilitator (@x402/core + @x402/svm, feePayer ${feePayer})` };
  }
  return { client: new HTTPFacilitatorClient({ url: FACILITATOR_URL }), label: FACILITATOR_URL };
}
