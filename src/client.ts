/**
 * Thin client for the qu4zr Management API. Exchanges the OAuth2 client_credentials
 * for a short-lived JWT (cached + auto-refreshed) and makes authenticated calls.
 *
 * Failures are translated on the way out. A bare `fetch` rejection reads `TypeError: fetch failed`
 * with the real reason buried in `cause`, and the most common real reason — a corporate TLS proxy
 * the machine does not trust — is invisible. The one workaround that surfaces in a search for that
 * message is NODE_TLS_REJECT_UNAUTHORIZED=0, which turns off certificate verification for the whole
 * process, including the request that carries the client secret. So the message says what happened
 * and names NODE_EXTRA_CA_CERTS instead.
 */

export interface ClientConfig {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
  /**
   * Hosted mode: the bearer token of the request being served (see remote.ts). When set, the client
   * never runs client_credentials — every call acts as the person whose AI client sent the request.
   */
  bearer?: () => string | undefined;
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export type Qu4zrErrorKind = "auth" | "network" | "http";

export class Qu4zrError extends Error {
  constructor(
    message: string,
    readonly kind: Qu4zrErrorKind,
    readonly hint?: string,
  ) {
    super(hint ? `${message}\n${hint}` : message);
    this.name = "Qu4zrError";
  }
}

/** What the assistant is allowed to do, read back off the token the server actually issued. */
export interface Identity {
  scopes: string[];
  clientId?: string;
  expiresAtMs: number;
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

/** Turns a fetch rejection into something a person can act on. */
function networkError(err: unknown, url: string): Qu4zrError {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";

  if (TLS_CODES.has(code)) {
    return new Qu4zrError(
      `Cannot verify the TLS certificate of ${url} (${code}).`,
      "network",
      "This is usually an antivirus, corporate proxy or VPN re-signing traffic with a root your\n" +
        "Node install does not trust. On Windows, reinstall with `qu4zr-mcp install <client> --windows`\n" +
        "so supported Node versions use the Windows certificate store. Otherwise point Node at the root:\n" +
        "  NODE_EXTRA_CA_CERTS=/path/to/corporate-root.pem\n" +
        "Do NOT set NODE_TLS_REJECT_UNAUTHORIZED=0 — your client secret goes over this connection.",
    );
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new Qu4zrError(`Cannot resolve ${url}.`, "network", "Check QU4ZR_BASE_URL and your DNS.");
  }

  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
    return new Qu4zrError(
      `Cannot reach ${url} (${code}).`,
      "network",
      "A firewall or proxy is in the way, or QU4ZR_BASE_URL points somewhere that is not listening.",
    );
  }

  return new Qu4zrError(
    `Request to ${url} failed: ${cause?.message ?? (err as Error).message}`,
    "network",
  );
}

/** Reads the `scope` / `client_id` claims out of the issued JWT. Best-effort by design. */
function readClaims(token: string): Pick<Identity, "scopes" | "clientId"> {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
      scope?: string | string[];
      client_id?: string;
    };
    const raw = payload.scope ?? [];
    return {
      scopes: Array.isArray(raw) ? raw : raw.split(/\s+/).filter(Boolean),
      clientId: payload.client_id,
    };
  } catch {
    return { scopes: [] };
  }
}

export class Qu4zrClient {
  private token?: CachedToken;

  constructor(private readonly cfg: ClientConfig) {}

  private async getToken(): Promise<string> {
    if (this.cfg.bearer) {
      const bearer = this.cfg.bearer();
      if (!bearer) throw new Qu4zrError("No signed-in user for this request.", "auth");
      return bearer;
    }

    // Reuse the cached token until ~30s before expiry.
    if (this.token && Date.now() < this.token.expiresAtMs - 30_000) {
      return this.token.value;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cfg.clientId ?? "",
      client_secret: this.cfg.clientSecret ?? "",
      scope: this.cfg.scopes.join(" "),
    });

    const url = `${this.cfg.baseUrl}/api/v1/oauth/token`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      throw networkError(err, url);
    }

    const text = await res.text();
    if (!res.ok) {
      throw authError(res.status, text);
    }

    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.token = {
      value: json.access_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 1800) * 1000,
    };
    return this.token.value;
  }

  /**
   * Proves the credentials work, before anything else does. Called at startup and by `doctor`:
   * without it the server prints "ready" on a wrong secret and the failure surfaces mid-task, as
   * a token error inside a tool call, which reads like the tool is broken.
   */
  async verify(): Promise<Identity> {
    const token = await this.getToken();
    const claims = readClaims(token);
    return { ...claims, expiresAtMs: this.token!.expiresAtMs };
  }

  /** Authenticated JSON call. Throws a readable Error on non-2xx. */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const url = `${this.cfg.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw networkError(err, url);
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const message =
        (data && typeof data === "object" && (data as any).message) ||
        (data && typeof data === "object" && (data as any).error) ||
        (data && typeof data === "object" && (data as any).detail) ||
        text ||
        res.statusText;
      throw new Qu4zrError(`${method} ${path} → ${res.status}: ${message}`, "http");
    }

    return data as T;
  }
}

/** The token endpoint's own vocabulary, mapped to the thing the user has to go and change. */
function authError(status: number, text: string): Qu4zrError {
  let code = "";
  let description = "";
  try {
    const body = JSON.parse(text) as { error?: string; error_description?: string };
    code = body.error ?? "";
    description = body.error_description ?? "";
  } catch {
    /* the body is not always JSON */
  }

  const hints: Record<string, string> = {
    invalid_client:
      "The client id or secret is wrong, or the client was disabled, deleted or has expired.\n" +
      "Check it under Account → API Access, or rotate the secret and update your MCP config.",
    invalid_scope:
      "This API client was not granted one of the scopes being requested. Either tick the missing\n" +
      "scope on the client, or set QU4ZR_SCOPES to only the ones it has.",
    unauthorized_client: "This client is not allowed the client_credentials grant.",
  };

  const detail = [code, description].filter(Boolean).join(": ") || text || `HTTP ${status}`;
  return new Qu4zrError(`Authentication failed (${status}): ${detail}`, "auth", hints[code]);
}
