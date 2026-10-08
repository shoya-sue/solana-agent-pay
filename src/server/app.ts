/**
 * Paid API server using the official x402 Express middleware.
 *
 *   GET /catalog                      free — lists paid endpoints and prices
 *   GET /api/weather?city=Tokyo       0.02 dUSDC
 *   GET /api/air-quality?city=Tokyo   0.01 dUSDC
 *   GET /api/premium/forecast-report  0.50 dUSDC (deliberately above the agent's per-call cap)
 *
 * Unpaid requests get HTTP 402 with a standard x402 v2 `PAYMENT-REQUIRED` header (scheme `exact`,
 * Solana devnet, asset = our test mint, `extra.feePayer` = the facilitator's fee payer). A paid retry
 * carries `PAYMENT-SIGNATURE` with the client's partially-signed transaction; the facilitator verifies
 * it, the handler runs, then the facilitator co-signs and broadcasts (settles) before the response is sent.
 */
import express, { type Express } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/http";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { NETWORK_DEVNET, TOKEN_DECIMALS, TOKEN_SYMBOL } from "../config.js";
import { toAtomic } from "../lib/amount.js";
import { getAirQuality, getPremiumReport, getWeather, UnknownCityError } from "./data.js";
import { ReplayGuard } from "./replay.js";
import { attachSettlementReconciler, type SignatureCheck } from "./reconcile.js";

export interface PaidRoute {
  path: string;
  price: string; // human units of the token
  description: string;
  params: Record<string, string>;
  handler: (q: URLSearchParams) => Promise<unknown>;
}

export const ROUTES: PaidRoute[] = [
  {
    path: "/api/weather",
    price: "0.02",
    description: "Current weather + today's forecast for a city (Open-Meteo)",
    params: { city: "City name, e.g. Tokyo" },
    handler: (q) => getWeather(q.get("city") ?? "Tokyo"),
  },
  {
    path: "/api/air-quality",
    price: "0.01",
    description: "Current air quality (PM2.5, PM10, AQI) for a city",
    params: { city: "City name, e.g. Osaka" },
    handler: (q) => getAirQuality(q.get("city") ?? "Tokyo"),
  },
  {
    path: "/api/premium/forecast-report",
    price: "0.50",
    description: "Premium 48h hourly forecast report",
    params: { city: "City name" },
    handler: (q) => getPremiumReport(q.get("city") ?? "Tokyo"),
  },
];

export interface ServerOptions {
  payTo: string;
  mint: string;
  facilitator: FacilitatorClient;
  facilitatorLabel?: string;
  replayGuard?: ReplayGuard;
  /** On-chain signature check used to reconcile `settlement_pending` (injectable for tests). */
  checkSignature?: SignatureCheck;
  reconcileDelayMs?: number;
  routes?: PaidRoute[];
  log?: (msg: string) => void;
}

export function buildRoutesConfig(routes: PaidRoute[], payTo: string, mint: string): RoutesConfig {
  const cfg: RoutesConfig = {};
  for (const r of routes) {
    cfg[`GET ${r.path}`] = {
      accepts: {
        scheme: "exact",
        network: NETWORK_DEVNET,
        payTo,
        price: { amount: toAtomic(r.price, TOKEN_DECIMALS).toString(), asset: mint },
        maxTimeoutSeconds: 120,
      },
      description: `${r.description} — ${r.price} ${TOKEN_SYMBOL}`,
      mimeType: "application/json",
    };
  }
  return cfg;
}

export function createResourceServer(opts: ServerOptions): x402ResourceServer {
  const log = opts.log ?? (() => {});
  const rs = new x402ResourceServer(opts.facilitator).register(NETWORK_DEVNET, new ExactSvmScheme());
  const guard = opts.replayGuard ?? new ReplayGuard();
  // Reconciler first: a recovered settlement short-circuits the remaining failure hooks.
  attachSettlementReconciler(rs, {
    facilitator: opts.facilitator,
    checkSignature: opts.checkSignature,
    delayMs: opts.reconcileDelayMs,
    log,
    onRecovered: (payload, result) => {
      guard.markSettled(payload);
      log(`facilitator settle: recovered after pending, tx=${result.transaction}`);
    },
  });
  guard.attach(rs);
  rs.onAfterVerify(async ({ result }) => {
    if (result.isValid) log(`facilitator verify: ok (payer ${result.payer})`);
  })
    .onVerifyFailure(async ({ error }) => log(`facilitator verify: rejected — ${error.message.slice(0, 160)}`))
    .onAfterSettle(async ({ result }) => {
      log(result.success ? `facilitator settle: ok tx=${result.transaction}` : `facilitator settle: failed ${result.errorReason}`);
    });
  return rs;
}

export function createApp(opts: ServerOptions): Express {
  const routes = opts.routes ?? ROUTES;
  const log = opts.log ?? (() => {});
  const app = express();
  app.disable("x-powered-by");

  // Request log (status is known once the response finishes)
  app.use((req, res, next) => {
    res.on("finish", () => {
      if (req.path.startsWith("/api/")) {
        const paid = req.headers["payment-signature"] ? "with PAYMENT-SIGNATURE" : "no payment";
        log(`${res.statusCode} ${req.originalUrl} (${paid})`);
      }
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get(["/", "/catalog"], (_req, res) => {
    res.json({
      name: "solana-agent-pay demo API",
      protocol: "x402 v2 — scheme exact on Solana devnet, settled by a facilitator",
      network: NETWORK_DEVNET,
      facilitator: opts.facilitatorLabel ?? "custom",
      asset: { mint: opts.mint, symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS },
      payTo: opts.payTo,
      endpoints: routes.map((r) => ({ path: r.path, price: `${r.price} ${TOKEN_SYMBOL}`, description: r.description, params: r.params })),
    });
  });

  app.use(paymentMiddleware(buildRoutesConfig(routes, opts.payTo, opts.mint), createResourceServer(opts)));

  for (const r of routes) {
    app.get(r.path, async (req, res) => {
      try {
        const q = new URLSearchParams(req.query as Record<string, string>);
        res.json({ data: await r.handler(q) });
      } catch (e) {
        // Non-2xx responses are not settled by the middleware, so the client is not charged.
        res.status(e instanceof UnknownCityError ? 404 : 502).json({ error: (e as Error).message });
      }
    });
  }
  return app;
}
