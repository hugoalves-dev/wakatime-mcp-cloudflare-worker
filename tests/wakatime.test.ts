import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/wakatime.js";
import { todayYmd, wakatimeGet } from "../src/wakatime.js";

const accessToken = "waka_tok_api_access";
const refreshToken = "waka_tok_api_refresh";

class MemoryKV {
  values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}

function makeEnv(token = accessToken, expiresAt: number | null = null) {
  const store = new MemoryKV();
  store.values.set("oauth:token", JSON.stringify({ access_token: token, refresh_token: refreshToken, expires_at: expiresAt }));
  return {
    env: {
      WAKATIME_OAUTH_CLIENT_ID: "client-id",
      WAKATIME_OAUTH_CLIENT_SECRET: "client-secret",
      WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
      WAKATIME_OAUTH_STORE: store as unknown as KVNamespace,
    } satisfies Env,
    store,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("todayYmd", () => {
  it("formats today's date in the requested timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T02:00:00.000Z"));
    expect(todayYmd("America/Los_Angeles")).toBe("2024-12-31");
  });
});

describe("wakatimeGet", () => {
  it("uses bearer auth and encodes query values", async () => {
    const { env } = makeEnv();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.wakatime.com/api/v1/users/current/summaries?start=2025-01-01&end=2025-01-02&project=sample+project&timezone=Asia%2FTokyo",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
      expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      return new Response('{"data":[]}');
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(wakatimeGet(env, "users/current/summaries", {
      start: "2025-01-01", end: "2025-01-02", project: "sample project", timezone: "Asia/Tokyo",
    })).resolves.toBe('{"data":[]}');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects when the OAuth token record is missing before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet({}, "users/current/summaries", {})).rejects.toThrow(/OAuth/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a near-expiry token before requesting summaries and saves rotated credentials", async () => {
    const { env, store } = makeEnv(accessToken, Date.now() + 30_000);
    const requestedAuth: Array<string | null> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://wakatime.com/oauth/token") {
        expect(JSON.parse(String(init?.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: refreshToken });
        return Response.json({ access_token: "waka_tok_new_access", refresh_token: "waka_tok_new_refresh", expires_in: 3600 });
      }
      requestedAuth.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet(env, "users/current/summaries", {})).resolves.toBe('{"data":[]}');
    expect(requestedAuth).toEqual(["Bearer waka_tok_new_access"]);
    expect(JSON.parse(store.values.get("oauth:token")!)).toMatchObject({
      access_token: "waka_tok_new_access", refresh_token: "waka_tok_new_refresh",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes once and retries once after a 401", async () => {
    const { env } = makeEnv();
    let apiRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://wakatime.com/oauth/token") {
        return Response.json({ access_token: "waka_tok_refreshed", refresh_token: "waka_tok_refresh_new" });
      }
      apiRequests += 1;
      const auth = new Headers(init?.headers).get("Authorization");
      if (apiRequests === 1) {
        expect(auth).toBe(`Bearer ${accessToken}`);
        return Response.json({ error: "expired" }, { status: 401 });
      }
      expect(auth).toBe("Bearer waka_tok_refreshed");
      return Response.json({ data: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet(env, "users/current/summaries", {})).resolves.toBe('{"data":[]}');
    expect(apiRequests).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not refresh after a 403", async () => {
    const { env } = makeEnv();
    const fetchMock = vi.fn(async () => Response.json({ error: "Access denied" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet(env, "users/current/summaries", {})).rejects.toThrow("WakaTime API request failed: 403");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
