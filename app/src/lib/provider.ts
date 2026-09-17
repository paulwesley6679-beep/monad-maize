// ---------------------------------------------------------------------------
// ResilientRpcProvider — JsonRpcProvider with a per-request timeout and
// endpoint rotation/retry.
//
// The public Monad testnet RPC (testnet-rpc.monad.xyz) is genuinely flaky:
// requests sometimes hang for many seconds or die at the TCP level, which the
// browser surfaces as "Failed to fetch" with no HTTP status/body at all.
// ethers' default JsonRpcProvider has a 5-minute timeout and no retry, so a
// single hiccup is fatal for a poll cycle. This provider retries each request
// across the configured endpoints with a sane timeout and only throws after
// every attempt has failed — the same retry-with-fallback strategy the CLI
// verification scripts used to get reliable reads/broadcasts.
//
// Failed attempts are logged with the actual URL, HTTP status and error body
// so the underlying transport problem stays visible in the console.
// ---------------------------------------------------------------------------

import {
  FetchRequest,
  FetchResponse,
  JsonRpcProvider,
  type JsonRpcPayload,
  type JsonRpcResult,
} from "ethers";

export interface RpcAttemptFailure {
  url: string;
  /** HTTP status when the server responded; undefined for network-level fails. */
  status?: number;
  /** HTTP error body (truncated) when one exists. */
  body?: string;
  /** Message for thrown errors (timeouts, DNS/TCP failures). */
  error?: string;
}

export interface ResilientProviderOptions {
  /** Per-request timeout in ms. Default 12_000 (was: 300_000 in plain ethers). */
  timeoutMs?: number;
  /** Total attempts across all endpoints. Default 3, always ≥1. */
  maxAttempts?: number;
}

const RESULT_OK_BOUND = 500;

export class ResilientRpcProvider extends JsonRpcProvider {
  readonly urls: string[];
  readonly timeoutMs: number;
  readonly maxAttempts: number;

  /**
   * @param urls RPC endpoints in preference order, e.g. [primary, fallback].
   */
  constructor(urls: string[], options?: ResilientProviderOptions) {
    const clean = urls.map((u) => u.trim()).filter((u) => u.length > 0);
    super(clean[0]);
    this.urls = clean;
    this.timeoutMs = options?.timeoutMs ?? 12_000;
    this.maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
    console.info(
      `[rpc] provider endpoints: ${this.urls.join(" → ")} ` +
        `(timeout ${this.timeoutMs}ms, up to ${this.maxAttempts} attempts per request)`
    );
  }

  override async _send(
    payload: JsonRpcPayload | Array<JsonRpcPayload>
  ): Promise<Array<JsonRpcResult>> {
    const failures: RpcAttemptFailure[] = [];
    const attempts = this.maxAttempts;

    for (let i = 0; i < attempts; i++) {
      const url = this.urls[i % this.urls.length];
      const request = new FetchRequest(url);
      request.method = "POST";
      request.body = JSON.stringify(payload);
      request.setHeader("content-type", "application/json");
      request.setHeader("accept", "application/json");
      request.timeout = this.timeoutMs;

      // --- Network-level failure (DNS/TCP refused, dead connection, timeout) ---
      let response: FetchResponse;
      try {
        response = await request.send();
      } catch (e) {
        const err = e as { reason?: string; message?: string; code?: string };
        const note = err?.reason ?? err?.message ?? String(err);
        failures.push({ url, error: note });
        console.warn(`[rpc] attempt ${i + 1}/${attempts} failed ${url}: ${note}`);
        continue;
      }

      // --- HTTP-level failure worth retrying (rate-limit / server error) ---
      if (response.statusCode >= RESULT_OK_BOUND || response.statusCode === 429) {
        const body = safeBody(response);
        failures.push({ url, status: response.statusCode, body });
        console.warn(
          `[rpc] attempt ${i + 1}/${attempts} HTTP ${response.statusCode} from ${url}` +
            (body ? `: ${body}` : "")
        );
        continue;
      }

      // --- Any other non-2xx: not retryable, fail fast with the server's info ---
      try {
        response.assertOk();
      } catch (e) {
        const note = String((e as { message?: string })?.message ?? e);
        failures.push({ url, status: response.statusCode, error: note });
        console.warn(`[rpc] attempt ${i + 1}/${attempts} HTTP ${response.statusCode} from ${url}: ${note}`);
        continue;
      }

      // --- Response parsing ---
      let parsed: unknown;
      try {
        parsed = response.bodyJson;
      } catch {
        failures.push({ url, status: response.statusCode, error: "could not parse JSON body" });
        console.warn(`[rpc] attempt ${i + 1}/${attempts} bad JSON body from ${url}`);
        continue;
      }
      return Array.isArray(parsed) ? (parsed as JsonRpcResult[]) : [parsed as JsonRpcResult];
    }

    const summary = failures
      .map((f) => `${f.url} · status=${f.status ?? "-"} · ${f.body ?? f.error ?? "unknown"}`.slice(0, 300))
      .join("\n");
    const error = new Error(`RPC unreachable after ${attempts} attempt(s):\n${summary}`) as Error & {
      code?: string;
      reason?: string;
    };
    error.code = "NETWORK_ERROR";
    error.reason = "network";
    console.error(`[rpc] all ${attempts} attempts failed`, error.message);
    throw error;
  }
}

function safeBody(response: FetchResponse): string {
  try {
    const t = response.bodyText;
    return t && t.length > 0 ? t.slice(0, 300) : "";
  } catch {
    return "";
  }
}