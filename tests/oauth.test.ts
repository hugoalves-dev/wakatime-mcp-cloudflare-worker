import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAuthorization, createAuthorizationUrl, getAccessToken, refreshAccessToken } from "../src/oauth.js";
import type { Env } from "../src/wakatime.js";

class MemoryKV {
  values = new Map<string, string>();
  puts: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];
  deletes: string[] = [];

  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.deletes.push(key);
  }
}

const clientSecret = "client-secret-private";
const accessToken = "waka_tok_access_private";
const refreshToken = "waka_tok_refresh_private";

function makeEnv(kv = new MemoryKV()): Env & { WAKATIME_OAUTH_STORE: KVNamespace; testKv: MemoryKV } {
  return {
    WAKATIME_OAUTH_CLIENT_ID: "client-id",
    WAKATIME_OAUTH_CLIENT_SECRET: clientSecret,
    WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
    WAKATIME_OAUTH_STORE: kv as unknown as KVNamespace,
    testKv: kv,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WakaTime OAuth setup", () => {
  it("creates a read_summaries authorization URL and stores one-use state", async () => {
    const env = makeEnv();
    const url = new URL(await createAuthorizationUrl(env));
    expect(url.origin + url.pathname).toBe("https://wakatime.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(env.WAKATIME_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("read_summaries");
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(env.testKv.puts).toEqual([{
      key: `oauth:state:${state}`,
      value: "1",
      options: { expirationTtl: 600 },
    }]);
    expect(url.toString()).not.toContain(clientSecret);
  });

  it.each([
    ["missing", "https://worker.example.com/oauth/callback"],
    ["expired", "https://worker.example.com/oauth/callback?code=private-code&state=expired-state"],
  ])("rejects %s state before exchanging the authorization code", async (_caseName, callbackUrl) => {
    const env = makeEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await completeAuthorization(new Request(callbackUrl), env);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/private-code|expired-state|client-secret/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes valid state before exchanging the code and stores tokens privately", async () => {
    const env = makeEnv();
    const state = "valid-one-use-state";
    env.testKv.values.set(`oauth:state:${state}`, "1");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://wakatime.com/oauth/token");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        client_id: "client-id",
        client_secret: clientSecret,
        redirect_uri: env.WAKATIME_OAUTH_REDIRECT_URI,
        grant_type: "authorization_code",
        code: "private-code",
      });
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await completeAuthorization(
      new Request(`https://worker.example.com/oauth/callback?code=private-code&state=${state}`), env,
    );
    const responseText = await response.text();
    expect(response.status).toBe(200);
    expect(responseText).not.toMatch(/private-code|client-secret-private|waka_tok_/);
    expect(env.testKv.deletes).toEqual([`oauth:state:${state}`]);
    expect(JSON.parse(env.testKv.values.get("oauth:token")!)).toEqual({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing access token", { refresh_token: refreshToken }],
    ["missing refresh token", { access_token: accessToken }],
    ["malformed response", undefined],
  ])("does not persist incomplete or %s token responses", async (_caseName, body) => {
    const env = makeEnv();
    const state = "token-response-state";
    env.testKv.values.set(`oauth:state:${state}`, "1");
    vi.stubGlobal("fetch", vi.fn(async () => body === undefined
      ? new Response("{bad json", { status: 200 })
      : Response.json(body)));
    const response = await completeAuthorization(
      new Request(`https://worker.example.com/oauth/callback?code=private-code&state=${state}`), env,
    );
    expect(response.status).toBe(500);
    expect(env.testKv.values.has("oauth:token")).toBe(false);
    expect(await response.text()).not.toMatch(/private-code|client-secret-private|waka_tok_/);
  });

  it("returns the stored access token and rejects when no token record exists", async () => {
    const env = makeEnv();
    await expect(getAccessToken(env)).rejects.toThrow(/authorize/i);
    env.testKv.values.set("oauth:token", JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expires_at: null }));
    await expect(getAccessToken(env)).resolves.toBe(accessToken);
  });

  it("refreshes with the stored refresh token and persists rotated credentials", async () => {
    const env = makeEnv();
    env.testKv.values.set("oauth:token", JSON.stringify({
      access_token: accessToken, refresh_token: refreshToken, expires_at: Date.now() - 1,
    }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        client_id: "client-id",
        client_secret: clientSecret,
        redirect_uri: env.WAKATIME_OAUTH_REDIRECT_URI,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      return Response.json({ access_token: "waka_tok_rotated", refresh_token: "waka_tok_refresh_rotated", expires_in: 1800 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshAccessToken(env, accessToken)).resolves.toBe("waka_tok_rotated");
    expect(JSON.parse(env.testKv.values.get("oauth:token")!)).toMatchObject({
      access_token: "waka_tok_rotated",
      refresh_token: "waka_tok_refresh_rotated",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
