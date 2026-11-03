import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAuthorization, createAuthorizationUrl, processAuthorizationCallback, getAccessToken, refreshAccessToken } from "../src/oauth.js";
import type { Env } from "../src/wakatime.js";
import { MemoryCoordinatorNamespace, setState, setToken } from "./helpers/coordinator.js";

const clientSecret = "client-secret-private";
const accessToken = "waka_tok_access_private";
const refreshToken = "opaque-refresh-private";
function makeEnv() {
  const env = {
    WAKATIME_OAUTH_CLIENT_ID: "client-id", WAKATIME_OAUTH_CLIENT_SECRET: clientSecret,
    WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
  } as Env;
  const ns = new MemoryCoordinatorNamespace(env);
  env.WAKATIME_OAUTH_COORDINATOR = ns as unknown as DurableObjectNamespace;
  return { env, ns };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("WakaTime OAuth", () => {
  it("creates a read_summaries URL and stores one-use state", async () => {
    const { env, ns } = makeEnv();
    const url = new URL(await createAuthorizationUrl(env));
    expect(url.origin + url.pathname).toBe("https://wakatime.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("email read_summaries");
    expect(ns.storage.values.get(`state:${url.searchParams.get("state")}`)).toMatchObject({ expires: expect.any(Number) });
    expect(url.toString()).not.toContain(clientSecret);
  });

  it("rejects missing or expired state before exchanging the code", async () => {
    const { env } = makeEnv();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const url of ["https://worker.example.com/oauth/callback", "https://worker.example.com/oauth/callback?code=private-code&state=expired"]) {
      const response = await completeAuthorization(new Request(url), env);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toMatch(/private-code|expired|client-secret/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("atomically consumes state and stores OAuth tokens", async () => {
    const { env, ns } = makeEnv(); const state = "one-use-state"; setState(ns, state);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ client_id: "client-id", client_secret: clientSecret, redirect_uri: env.WAKATIME_OAUTH_REDIRECT_URI, grant_type: "authorization_code", code: "private-code" });
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
    }); vi.stubGlobal("fetch", fetchMock);
    const response = await completeAuthorization(new Request(`https://worker.example.com/oauth/callback?code=private-code&state=${state}`), env);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/private-code|client-secret-private|waka_tok_/);
    expect(ns.storage.values.has(`state:${state}`)).toBe(false);
    expect(ns.storage.values.get("token")).toMatchObject({ access_token: accessToken, refresh_token: refreshToken, expires_at: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent callback to consume a state", async () => {
    const { env, ns } = makeEnv(); setState(ns, "race-state");
    const fetchMock = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return Response.json({ access_token: accessToken, refresh_token: refreshToken }); });
    vi.stubGlobal("fetch", fetchMock);
    const callback = () => completeAuthorization(new Request("https://worker.example.com/oauth/callback?code=private-code&state=race-state"), env);
    const results = await Promise.all([callback(), callback()]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects malformed token responses and overflowing expiry", async () => {
    const { env, ns } = makeEnv();
    for (const body of [{ refresh_token: refreshToken }, { access_token: accessToken, refresh_token: refreshToken, expires_in: 1e308 }]) {
      setState(ns, "state-" + Math.random());
      const state = [...ns.storage.values.keys()].at(-1)!.slice("state:".length);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
      const response = await completeAuthorization(new Request(`https://worker.example.com/oauth/callback?code=private-code&state=${state}`), env);
      expect(response.status).toBe(500);
      expect(ns.storage.values.has("token")).toBe(false);
    }
  });

  it("requires the configured WakaTime owner to approve MCP consent", async () => {
    const { env, ns } = makeEnv();
    env.WAKATIME_OWNER_EMAIL = "owner@example.com";
    const authorizeUrl = new URL(await createAuthorizationUrl(env, "consent-handle"));
    const state = authorizeUrl.searchParams.get("state");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return Response.json({ access_token: accessToken, refresh_token: refreshToken });
      }
      if (url.includes("/users/current")) {
        return Response.json({ data: { email: "attacker@example.com", is_email_confirmed: true } });
      }
      throw new Error("Unexpected upstream URL");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await processAuthorizationCallback(
      new Request(`https://worker.example.com/oauth/callback?code=code&state=${state}`), env,
    );
    expect(result.status).toBe(403);
    expect(ns.storage.values.has("token")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("grants MCP consent only to the verified owner", async () => {
    const { env, ns } = makeEnv();
    env.WAKATIME_OWNER_EMAIL = "owner@example.com";
    const authorizeUrl = new URL(await createAuthorizationUrl(env, "approved-handle"));
    const state = authorizeUrl.searchParams.get("state");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/oauth/token")) {
        return Response.json({ access_token: accessToken, refresh_token: refreshToken });
      }
      return Response.json({ data: { email: "owner@example.com", is_email_confirmed: true } });
    }));
    const result = await processAuthorizationCallback(
      new Request(`https://worker.example.com/oauth/callback?code=code&state=${state}`), env,
    );
    expect(result).toEqual({ status: 200, consentHandle: "approved-handle" });
    expect(ns.storage.values.get("token")).toMatchObject({ access_token: accessToken });
  });

  it("reads and refreshes tokens, serializing concurrent refreshes and rotation", async () => {
    const { env, ns } = makeEnv(); setToken(ns, { access_token: accessToken, refresh_token: refreshToken, expires_at: Date.now() - 1 });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).refresh_token).toBe(refreshToken);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 1800 });
    }); vi.stubGlobal("fetch", fetchMock);
    const results = await Promise.all([getAccessToken(env), refreshAccessToken(env, accessToken)]);
    expect(results).toEqual(["rotated-access", "rotated-access"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ns.storage.values.get("token")).toMatchObject({ access_token: "rotated-access", refresh_token: "rotated-refresh" });
  });
});
