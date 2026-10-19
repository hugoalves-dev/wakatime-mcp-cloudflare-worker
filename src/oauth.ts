// ABOUTME: Single-user WakaTime OAuth flow and durable token storage.
// ABOUTME: OAuth credentials are kept in Worker secrets and a dedicated KV namespace.
import type { Env } from "./wakatime.js";

const TOKEN_KEY = "oauth:token";
const STATE_PREFIX = "oauth:state:";
const STATE_TTL_SECONDS = 600;
const REFRESH_SKEW_MS = 60_000;
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;

interface TokenRecord {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

function configuration(env: Env) {
  if (!env.WAKATIME_OAUTH_CLIENT_ID?.trim()
    || !env.WAKATIME_OAUTH_CLIENT_SECRET?.trim()
    || !env.WAKATIME_OAUTH_REDIRECT_URI?.trim()
    || !env.WAKATIME_OAUTH_STORE) {
    throw new Error("WakaTime OAuth is not configured.");
  }
  return {
    clientId: env.WAKATIME_OAUTH_CLIENT_ID,
    clientSecret: env.WAKATIME_OAUTH_CLIENT_SECRET,
    redirectUri: env.WAKATIME_OAUTH_REDIRECT_URI,
    store: env.WAKATIME_OAUTH_STORE,
  };
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAuthorizationUrl(env: Env): Promise<string> {
  const config = configuration(env);
  const state = randomState();
  await config.store.put(`${STATE_PREFIX}${state}`, "1", { expirationTtl: STATE_TTL_SECONDS });

  const url = new URL("https://wakatime.com/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "read_summaries");
  url.searchParams.set("state", state);
  return url.toString();
}

function callbackResponse(status: number, success: boolean): Response {
  const message = success
    ? "WakaTime authorization completed. You can close this window."
    : "WakaTime authorization could not be completed. Restart setup and try again.";
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>WakaTime authorization</title></head><body><p>${message}</p></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
    await reader.cancel();
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenRecord(value: unknown, previousRefreshToken?: string): TokenRecord | undefined {
  if (!isObject(value)) return undefined;
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token ?? previousRefreshToken;
  if (typeof accessToken !== "string" || !accessToken.trim()
    || typeof refreshToken !== "string" || !refreshToken.trim()) return undefined;

  let expiresAt: number | null = null;
  if (value.expires_in !== undefined) {
    const seconds = value.expires_in;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
    expiresAt = Date.now() + seconds * 1000;
  }
  return { access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt };
}

async function exchangeToken(
  env: Env,
  data: Record<string, string>,
  previousRefreshToken?: string,
): Promise<TokenRecord> {
  const config = configuration(env);
  let response: Response;
  try {
    response = await fetch("https://wakatime.com/oauth/token", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        ...data,
      }),
    });
  } catch {
    throw new Error("WakaTime OAuth request failed.");
  }
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error("WakaTime OAuth request failed.");
  const record = tokenRecord(body, previousRefreshToken);
  if (!record) throw new Error("WakaTime OAuth returned an invalid token response.");
  return record;
}

export async function completeAuthorization(request: Request, env: Env): Promise<Response> {
  let config: ReturnType<typeof configuration>;
  try { config = configuration(env); } catch { return callbackResponse(500, false); }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state.length > 256) return callbackResponse(400, false);

  const stateKey = `${STATE_PREFIX}${state}`;
  let storedState: string | null;
  try { storedState = await config.store.get(stateKey); } catch { return callbackResponse(500, false); }
  if (storedState !== "1") return callbackResponse(400, false);
  try { await config.store.delete(stateKey); } catch { return callbackResponse(500, false); }

  try {
    const record = await exchangeToken(env, { grant_type: "authorization_code", code });
    await config.store.put(TOKEN_KEY, JSON.stringify(record));
    return callbackResponse(200, true);
  } catch {
    return callbackResponse(500, false);
  }
}

async function readTokenRecord(env: Env): Promise<TokenRecord> {
  const config = configuration(env);
  let raw: string | null;
  try { raw = await config.store.get(TOKEN_KEY); } catch { throw new Error("WakaTime OAuth credentials could not be read."); }
  if (!raw) throw new Error("WakaTime OAuth is not authorized. Complete the OAuth setup flow.");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("WakaTime OAuth credentials are invalid. Reauthorize WakaTime."); }
  if (!isObject(parsed)
    || typeof parsed.access_token !== "string" || !parsed.access_token.trim()
    || typeof parsed.refresh_token !== "string" || !parsed.refresh_token.trim()
    || (parsed.expires_at !== null && (typeof parsed.expires_at !== "number" || !Number.isFinite(parsed.expires_at)))) {
    throw new Error("WakaTime OAuth credentials are invalid. Reauthorize WakaTime.");
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: parsed.expires_at,
  };
}

export async function refreshAccessToken(env: Env, rejectedToken?: string): Promise<string> {
  const config = configuration(env);
  const current = await readTokenRecord(env);
  if (rejectedToken && current.access_token !== rejectedToken) return current.access_token;
  const record = await exchangeToken(env, {
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  }, current.refresh_token);
  try {
    await config.store.put(TOKEN_KEY, JSON.stringify(record));
  } catch {
    throw new Error("WakaTime OAuth credentials could not be saved. Reauthorize WakaTime.");
  }
  return record.access_token;
}

export async function getAccessToken(env: Env): Promise<string> {
  const record = await readTokenRecord(env);
  if (record.expires_at !== null && record.expires_at <= Date.now() + REFRESH_SKEW_MS) {
    return refreshAccessToken(env, record.access_token);
  }
  return record.access_token;
}
