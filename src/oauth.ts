// ABOUTME: WakaTime OAuth entrypoints coordinated by a strongly consistent Durable Object.
// ABOUTME: OAuth secrets and rotated tokens never leave server-side storage or requests.
import type { Env } from "./wakatime.js";

const STATE_TTL_SECONDS = 600;

function coordinator(env: Env): DurableObjectStub {
  if (!env.WAKATIME_OAUTH_CLIENT_ID?.trim() || !env.WAKATIME_OAUTH_CLIENT_SECRET?.trim()
    || !env.WAKATIME_OAUTH_REDIRECT_URI?.trim() || !env.WAKATIME_OAUTH_COORDINATOR) {
    throw new Error("WakaTime OAuth is not configured.");
  }
  return env.WAKATIME_OAUTH_COORDINATOR.get(env.WAKATIME_OAUTH_COORDINATOR.idFromName("wakatime-oauth"));
}

async function rpc(env: Env, path: string, data: Record<string, unknown>): Promise<Response> {
  return coordinator(env).fetch(`https://oauth-coordinator${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAuthorizationUrl(env: Env): Promise<string> {
  const state = randomState();
  const response = await rpc(env, "/start", { state, ttl: STATE_TTL_SECONDS });
  if (!response.ok) throw new Error("OAuth setup is unavailable.");
  const url = new URL("https://wakatime.com/oauth/authorize");
  url.searchParams.set("client_id", env.WAKATIME_OAUTH_CLIENT_ID!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", env.WAKATIME_OAUTH_REDIRECT_URI!);
  url.searchParams.set("scope", "read_summaries");
  url.searchParams.set("state", state);
  return url.toString();
}

function callbackResponse(status: number, success: boolean): Response {
  const message = success
    ? "WakaTime authorization completed. You can close this window."
    : "WakaTime authorization could not be completed. Restart setup and try again.";
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>WakaTime authorization</title></head><body><p>${message}</p></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function completeAuthorization(request: Request, env: Env): Promise<Response> {
  let stub: DurableObjectStub;
  try { stub = coordinator(env); } catch { return callbackResponse(500, false); }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state.length > 256) return callbackResponse(400, false);
  try {
    const response = await stub.fetch("https://oauth-coordinator/callback", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, state }),
    });
    return callbackResponse(response.ok ? 200 : response.status === 400 ? 400 : 500, response.ok);
  } catch { return callbackResponse(500, false); }
}

async function tokenRequest(env: Env, path: string, body: Record<string, unknown> = {}): Promise<string> {
  const response = await rpc(env, path, body);
  if (!response.ok) throw new Error("WakaTime OAuth credentials are unavailable. Reauthorize WakaTime.");
  const value = await response.json() as { token?: unknown };
  if (typeof value.token !== "string" || !value.token) throw new Error("WakaTime OAuth credentials are invalid. Reauthorize WakaTime.");
  return value.token;
}

export async function getAccessToken(env: Env): Promise<string> {
  return tokenRequest(env, "/token");
}

export async function refreshAccessToken(env: Env, rejectedToken?: string): Promise<string> {
  return tokenRequest(env, "/refresh", { rejected: rejectedToken });
}

export async function getRefreshToken(_env: Env): Promise<string> {
  const response = await rpc(_env, "/secrets", {});
  if (!response.ok) throw new Error("WakaTime OAuth credentials are unavailable.");
  const value = await response.json() as { refresh?: unknown };
  if (typeof value.refresh !== "string") throw new Error("WakaTime OAuth credentials are invalid.");
  return value.refresh;
}
