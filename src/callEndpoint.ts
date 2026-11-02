/**
 * call_endpoint — a real HTTP request to a deployed endpoint, the way its callers make it.
 *
 * The one check that is not a shortcut. test_block and execute_workspace both reach the sandbox
 * through the Management API, so they exercise the code and skip everything between a browser and
 * it: whether the block was ever deployed, whether the path resolves, whether the verb is allowed,
 * whether the caller needs a key. A page whose fetches 404 because nothing was published looks,
 * from inside those tools, exactly like a page that works — which is how a build gets reported as
 * finished while every request it makes fails.
 *
 * The caller names a domain and a path, never a URL. That is deliberate and it is not only about
 * ergonomics: the address is read from the domain's own baseUrl, so this can only reach hosts qu4zr
 * serves, and it is the same string a deploy reported and a canonical tag names. Testing a different
 * spelling of the URL than the one users are given is a way to pass while they fail.
 *
 * Plain functions over a minimal client + an injectable fetch, so the whole thing is unit-testable
 * without a network — see callEndpoint.test.ts.
 */

import { fail, ok, type ToolResult } from "./helpers.js";

export interface DomainClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CallEndpointOptions {
  domainId: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
  apiKey?: string;
  timeoutMs?: number;
}

interface DomainRow {
  id: number;
  slug: string;
  baseUrl: string;
}

/** Enough body to see what came back, not enough to spend a context window on one page. */
const MAX_BODY_CHARS = 4000;

const DEFAULT_TIMEOUT_MS = 30_000;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/**
 * Headers the caller must not set. Authorization has its own argument, so a key cannot arrive by
 * two routes with two meanings; the rest belong to the connection.
 */
const RESERVED_HEADERS = new Set(["authorization", "host", "content-length", "connection", "transfer-encoding"]);

/**
 * What a status code means HERE, where the commonest cause is not the one a general HTTP client
 * would guess. Only the codes with a qu4zr-specific cause get a note — for the rest, a guess would
 * be worse than silence.
 */
export function noteForStatus(status: number): string | undefined {
  if (status === 404) {
    // Deliberately no longer asserts "this is a routing answer, not your code". A block may return
    // 404 on purpose — a lookup that found nothing — and telling an agent that its own answer came
    // from routing sends it to redeploy an endpoint that is already deployed.
    return (
      "Most often nothing is deployed at this path: setting endpointPath on a block publishes " +
      "nothing — deploy_endpoint does. Check list_endpoints, then deploy. If the path IS deployed, " +
      "then this 404 came from the block itself."
    );
  }
  if (status === 401 || status === 403) {
    return (
      "This endpoint is not anonymous, so callers need a key. Deploy it with isAnonymous:true if it " +
      "is meant to be public, or mint one with create_domain_api_key and pass it as apiKey."
    );
  }
  if (status === 405) {
    return "The path resolved but this verb is not in the endpoint's allowedVerbs — update_endpoint can widen them.";
  }
  if (status === 500) {
    return "The block behind this path threw. get_logs shows what it threw; test_block runs it in isolation with the same input.";
  }
  return undefined;
}

/**
 * The address, from the domain's own baseUrl. Refuses "." and ".." rather than normalising them:
 * an HTTP client resolves those away before the request leaves, so the call would silently land on
 * an address nobody deployed (the same call files.ts makes about file names).
 */
export function buildUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const clean = (path ?? "").trim().replace(/^\/+/, "");
  if (clean.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error('A path may not contain "." or ".." segments.');
  }

  let url = `${baseUrl.replace(/\/+$/, "")}/${clean}`;

  if (query && Object.keys(query).length > 0) {
    const search = new URLSearchParams(query).toString();
    url += (url.includes("?") ? "&" : "?") + search;
  }

  return url;
}

export async function callEndpoint(
  client: DomainClient,
  opts: CallEndpointOptions,
  fetchImpl: FetchLike = fetch,
): Promise<ToolResult> {
  const method = (opts.method ?? "GET").trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return fail(new Error(`'${method}' is not an HTTP method this can send. Use one of: ${[...ALLOWED_METHODS].join(", ")}.`));
  }

  let domains: DomainRow[];
  try {
    domains = await client.request<DomainRow[]>("GET", "/api/v1/domains");
  } catch (err) {
    return fail(err);
  }

  const domain = domains.find((d) => d.id === opts.domainId);
  if (!domain) {
    return fail(
      new Error(
        `No domain with id ${opts.domainId}. Call list_domains — the id has to be one of yours, ` +
          `because the URL is built from that domain and never from a string you supply.`,
      ),
    );
  }

  let url: string;
  try {
    url = buildUrl(domain.baseUrl, opts.path, opts.query);
  } catch (err) {
    return fail(err);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey.trim()}`;

  const sendsBody = opts.body !== undefined && method !== "GET" && method !== "HEAD";
  if (sendsBody && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: sendsBody ? opts.body : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    const text = await res.text();
    const truncated = text.length > MAX_BODY_CHARS;

    return ok({
      url,
      method,
      status: res.status,
      contentType: res.headers.get("content-type") ?? undefined,
      durationMs: Date.now() - started,
      body: truncated ? text.slice(0, MAX_BODY_CHARS) : text,
      ...(truncated ? { bodyTruncated: true } : {}),
      ...(noteForStatus(res.status) ? { note: noteForStatus(res.status) } : {}),
    });
  } catch (err) {
    // A timeout is a finding about the endpoint, not a failure of this tool: a block that hangs for
    // 30 seconds is exactly the kind of thing the caller is here to discover.
    if (err instanceof Error && err.name === "AbortError") {
      return ok({
        url,
        method,
        error: `No response within ${Math.round(timeoutMs / 1000)} seconds. The block behind this path is hanging — check what it waits on.`,
      });
    }
    return fail(err);
  } finally {
    clearTimeout(timer);
  }
}
