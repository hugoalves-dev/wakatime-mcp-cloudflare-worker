// ABOUTME: Worker-safe WakaTime API and timezone helpers.
// ABOUTME: All credentials arrive through explicit Cloudflare environment bindings.
import { getAccessToken, getRefreshToken, refreshAccessToken } from "./oauth.js";

export interface Env {
  MCP_AUTH_TOKEN?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  WAKATIME_OAUTH_CLIENT_ID?: string;
  WAKATIME_OAUTH_CLIENT_SECRET?: string;
  WAKATIME_OAUTH_REDIRECT_URI?: string;
  WAKATIME_OAUTH_COORDINATOR?: DurableObjectNamespace;
}

export function todayYmd(tz = "Asia/Tokyo"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("today date formatting failed");
  return `${year}-${month}-${day}`;
}

// Only this error type carries diagnostics approved for MCP clients.
export class WakaTimeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WakaTimeRequestError";
  }
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sanitizeDiagnostic(text: string, env: Env, extraSecrets: string[] = []): string {
  const secrets = [env.WAKATIME_OAUTH_CLIENT_SECRET, env.MCP_AUTH_TOKEN, ...extraSecrets]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, encodeURIComponent(value), base64(value)])
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\b(?:Basic|Bearer)\s+[^\s,;"'<>]+/gi, "[REDACTED]")
    .replace(/\b(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_ -]?key|token|secret|password|authorization|credentials)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]")
    .replace(/\bwaka_(?:key|tok|sec)_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1500);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The docs specify error/errors, but not a fixed shape for their contents.
// Collect message strings only; never serialize the full response or credentials.
function upstreamErrorDetails(body: unknown): string {
  if (!isObject(body)) return "";
  const messages: string[] = [];
  function collect(value: unknown, depth = 0): void {
    if (depth > 4 || messages.length >= 8) return;
    if (typeof value === "string" && value.trim()) messages.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (!/auth|key|token|secret|password|credential|cookie|debug|request|header/i.test(key)) {
          collect(item, depth + 1);
        }
      }
    }
  }
  collect(body.error);
  collect(body.errors);
  return messages.join("; ");
}

const statusNames: Record<number, string> = {
  200: "OK", 302: "Found", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 500: "Internal Server Error",
};

export async function wakatimeGet(
  env: Env,
  path: string,
  qs: Record<string, string | undefined>,
): Promise<string> {
  const url = new URL(`https://api.wakatime.com/api/v1/${path}`);
  for (const [key, value] of Object.entries(qs)) {
    if (value != null && value !== "") url.searchParams.set(key, value);
  }

  const context = `endpoint: ${url.pathname}; query parameters: ${[...url.searchParams.keys()].join(", ") || "none"}`;
  const failure = (detail: string, credentials: string[] = []) => new WakaTimeRequestError(
    `WakaTime API request failed: ${sanitizeDiagnostic(detail, env, credentials)} (${sanitizeDiagnostic(context, env, credentials)})`,
  );

  let accessToken: string;
  let refreshToken: string;
  try {
    accessToken = await getAccessToken(env);
    refreshToken = await getRefreshToken(env);
  } catch {
    throw failure("OAuth credentials are unavailable; authorize or reauthorize WakaTime");
  }
  const refreshSecrets = [refreshToken];

  const request = async (token: string) => fetch(url, {
    method: "GET",
    // Do not follow redirects with the API credential.
    redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  let response: Response;
  try {
    response = await request(accessToken);
  } catch {
    throw failure("network request failed; try again later", [accessToken, ...refreshSecrets]);
  }

  if (response.status === 401) {
    try { await response.body?.cancel(); } catch { /* The retry does not depend on draining the 401 body. */ }
    try {
      accessToken = await refreshAccessToken(env, accessToken);
      refreshSecrets.push(refreshToken);
      refreshToken = await getRefreshToken(env);
      refreshSecrets.push(refreshToken);
      response = await request(accessToken);
    } catch {
      throw failure("401 Unauthorized; OAuth refresh failed; reauthorize WakaTime");
    }
  }

  const status = `${response.status} ${response.statusText || statusNames[response.status] || "HTTP error"}`;
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw failure(`${status}: unable to read upstream response`, [accessToken, ...refreshSecrets]);
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }

  if (!response.ok) {
    let detail = sanitizeDiagnostic(upstreamErrorDetails(body), env, [accessToken, ...refreshSecrets]).slice(0, 1000)
      || "no usable error details from upstream";
    if (response.status === 302) detail += "; possible rate limit redirect; spread requests over a few minutes";
    if (response.status === 429) {
      detail += "; rate limited; reduce request frequency and try again later";
      const retryAfter = response.headers.get("Retry-After");
      // Retry-After is standard HTTP guidance, not guaranteed by WakaTime docs.
      if (retryAfter && /^\d+$/.test(retryAfter)) detail += `; Retry-After: ${retryAfter} seconds`;
      else if (retryAfter) {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) detail += `; Retry-After: ${new Date(date).toUTCString()}`;
      }
    }
    throw failure(`${status}: ${detail}`, [accessToken, ...refreshSecrets]);
  }
  if (!isObject(body) || !Array.isArray(body.data) || body.error || body.errors) {
    throw failure(`${status}: invalid WakaTime summaries response; expected a JSON object with a data array`, [accessToken, ...refreshSecrets]);
  }
  // Preserve all daily/aggregate fields without assuming a fixed summary schema.
  return text;
}
