/**
 * Paid API server (x402-style). Pure node:http, no framework.
 *
 *   GET /catalog                      free — lists paid endpoints and prices
 *   GET /api/weather?city=Tokyo       0.02 dUSDC
 *   GET /api/air-quality?city=Tokyo   0.01 dUSDC
 *   GET /api/premium/forecast-report  0.50 dUSDC (deliberately above the agent's per-call cap)
 */
import http from "node:http";
import crypto from "node:crypto";
import bs58 from "bs58";
import { Connection } from "@solana/web3.js";
import { NETWORK_DEVNET, TOKEN_DECIMALS, TOKEN_SYMBOL } from "../config.js";
import { fromAtomic, toAtomic } from "../lib/amount.js";
import {
  X402_VERSION,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  TRANSFER_METHOD_CLIENT_BROADCAST,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "../x402/types.js";
import type { PaymentStore } from "./store.js";
import { verifyPayment, type FetchTx } from "./verify.js";
import { getAirQuality, getPremiumReport, getWeather, UnknownCityError } from "./data.js";

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
  store: PaymentStore;
  connection?: Connection;
  fetchTx?: FetchTx;
  quoteTtlSeconds?: number;
  log?: (msg: string) => void;
}

/** Canonical resource id the quote is bound to: path + sorted query. */
export function canonicalResource(url: URL): string {
  const q = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(q).toString();
  return qs ? `${url.pathname}?${qs}` : url.pathname;
}

/** Fetch a parsed tx at `confirmed`, retrying briefly for RPC propagation lag. */
export function rpcFetchTx(connection: Connection): FetchTx {
  return async (sig) => {
    for (let i = 0; i < 8; i++) {
      const tx = await connection.getParsedTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx) return tx;
      await new Promise((r) => setTimeout(r, 750 * (i + 1)));
    }
    return null;
  };
}

export function createServer(opts: ServerOptions): http.Server {
  const ttl = opts.quoteTtlSeconds ?? 120;
  const log = opts.log ?? (() => {});
  const fetchTx = opts.fetchTx ?? rpcFetchTx(opts.connection!);

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body, null, 2));
  };

  const issue402 = (res: http.ServerResponse, route: PaidRoute, url: URL, error: string) => {
    const resource = canonicalResource(url);
    const memo = `x402-${bs58.encode(crypto.randomBytes(16))}`;
    const now = Math.floor(Date.now() / 1000);
    const amount = toAtomic(route.price, TOKEN_DECIMALS).toString();
    opts.store.saveQuote({
      memo, resource, amount, asset: opts.mint, payTo: opts.payTo, network: NETWORK_DEVNET,
      expiresAt: now + ttl, createdAt: now,
    });
    const req: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK_DEVNET,
      amount,
      asset: opts.mint,
      payTo: opts.payTo,
      maxTimeoutSeconds: ttl,
      extra: {
        paymentFlow: "upfront",
        assetTransferMethod: TRANSFER_METHOD_CLIENT_BROADCAST,
        memo,
        expiresAt: now + ttl,
        decimals: TOKEN_DECIMALS,
        symbol: TOKEN_SYMBOL,
      },
    };
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      error,
      resource: { url: resource, description: `${route.description} — ${route.price} ${TOKEN_SYMBOL}`, mimeType: "application/json" },
      accepts: [req],
    };
    send(res, 402, body, { [HEADER_PAYMENT_REQUIRED]: encodeHeader(body) });
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

      if (url.pathname === "/health") return send(res, 200, { ok: true });
      if (url.pathname === "/" || url.pathname === "/catalog") {
        return send(res, 200, {
          name: "solana-agent-pay demo API",
          protocol: "x402 v2 (Solana devnet, client-broadcast SPL transfer + memo reference)",
          network: NETWORK_DEVNET,
          asset: { mint: opts.mint, symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS },
          payTo: opts.payTo,
          endpoints: ROUTES.map((r) => ({ path: r.path, price: `${r.price} ${TOKEN_SYMBOL}`, description: r.description, params: r.params })),
        });
      }

      const route = ROUTES.find((r) => r.path === url.pathname);
      if (!route) return send(res, 404, { error: "not_found" });

      const header = req.headers[HEADER_PAYMENT_SIGNATURE.toLowerCase()];
      if (!header || Array.isArray(header)) {
        log(`402 ${canonicalResource(url)} (no payment)`);
        return issue402(res, route, url, `${HEADER_PAYMENT_SIGNATURE} header is required`);
      }

      let payload: PaymentPayload;
      try {
        payload = decodeHeader<PaymentPayload>(header);
      } catch {
        return send(res, 400, { error: "invalid_payment_header", message: `${HEADER_PAYMENT_SIGNATURE} must be base64-encoded JSON.` });
      }

      const resource = canonicalResource(url);
      const result = await verifyPayment(payload, resource, { store: opts.store, fetchTx });
      if (!result.ok) {
        log(`402 ${resource} payment rejected: ${result.code}`);
        const settle: SettlementResponse = {
          success: false, errorReason: result.code, transaction: payload.payload?.transaction ?? "", network: NETWORK_DEVNET,
        };
        res.setHeader(HEADER_PAYMENT_RESPONSE, encodeHeader(settle));
        return issue402(res, route, url, `${result.code}: ${result.message}`);
      }

      log(`200 ${resource} paid ${fromAtomic(result.amount, TOKEN_DECIMALS)} ${TOKEN_SYMBOL} tx=${result.signature}`);
      let data: unknown;
      try {
        data = await route.handler(url.searchParams);
      } catch (e) {
        // Payment is already consumed; in production you would refund or issue a credit here.
        const status = e instanceof UnknownCityError ? 404 : 502;
        return send(res, status, { error: (e as Error).message, note: "Payment was accepted; contact support for a refund/credit." });
      }
      const settle: SettlementResponse = { success: true, payer: result.payer, transaction: result.signature, network: NETWORK_DEVNET };
      return send(res, 200, { data, payment: settle }, { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settle) });
    } catch (e) {
      log(`500 ${(e as Error).message}`);
      return send(res, 500, { error: "internal_error" });
    }
  });
}
