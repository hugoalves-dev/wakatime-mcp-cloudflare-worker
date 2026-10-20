import { afterEach, describe, expect, it, vi } from "vitest";
import { wakatimeGet } from "../src/wakatime.js";
import { MemoryCoordinatorNamespace, setToken } from "./helpers/coordinator.js";

const path = "users/current/summaries";
const accessToken = "waka_tok_api_access_private";
const refreshToken = "waka_tok_refresh_private";
const clientSecret = "test-wakatime-oauth-client-secret";
function makeEnv(withToken = true) {
  const env = {
    MCP_AUTH_TOKEN: "test-mcp-secret",
    WAKATIME_OAUTH_CLIENT_ID: "client-id",
    WAKATIME_OAUTH_CLIENT_SECRET: clientSecret,
    WAKATIME_OAUTH_REDIRECT_URI: "https://worker.example.com/oauth/callback",
    WAKATIME_OAUTH_COORDINATOR: undefined as unknown as DurableObjectNamespace,
  };
  const ns = new MemoryCoordinatorNamespace(env);
  if (withToken) setToken(ns, { access_token: accessToken, refresh_token: refreshToken, expires_at: null });
  env.WAKATIME_OAUTH_COORDINATOR = ns as unknown as DurableObjectNamespace;
  return env;
}
const env = makeEnv();

afterEach(() => vi.unstubAllGlobals());

// Fetch is mocked at the network boundary; assertions cover the real HTTP client.
describe("WakaTime response handling", () => {
  it("preserves daily and aggregate fields from the documented success envelope", async () => {
    const body = JSON.stringify({ data: [{ grand_total: { total_seconds: 3600, text: "1 hr" },
      range: { date: "2025-01-01", timezone: "Asia/Tokyo" }, branches: [], entities: [] }],
      cumulative_total: { seconds: 3600 }, daily_average: { seconds: 3600 } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(wakatimeGet(env, path, {})).resolves.toBe(body);
  });

  it("rejects a missing OAuth token record before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet(makeEnv(false), path, {})).rejects.toThrow(/OAuth/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, "Bad Request", { errors: { start: ["Invalid date"] } }, "Invalid date"],
    [403, "Forbidden", { error: "Insufficient permissions" }, "Insufficient permissions"],
    [403, "Forbidden", { error: "Access denied" }, "Access denied"],
    [429, "Too Many Requests", { error: "Rate limit exceeded" }, "Rate limit exceeded"],
    [500, "Internal Server Error", { errors: ["Service unavailable"] }, "Service unavailable"],
  ])("preserves sanitized HTTP %i diagnostics", async (status, statusText, body, detail) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status, statusText })));
    const error = await wakatimeGet(env, path, { start: "2025-01-01", end: "2025-01-02", project: "private project" })
      .then(() => { throw new Error("Expected rejection"); }, (error: Error) => error);
    expect(error.message).toContain(`WakaTime API request failed: ${status} ${statusText}:`);
    expect(error.message).toContain(detail);
    expect(error.message).toContain("/api/v1/users/current/summaries");
    expect(error.message).toContain("query parameters: start, end, project");
    expect(error.message).not.toContain("private project");
    expect(error.message).not.toContain("2025-01-01");
  });

  it("reports Retry-After for 429 without automatically retrying", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "Slow down" }, {
      status: 429, headers: { "Retry-After": "60" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet(env, path, {})).rejects.toThrow("Retry-After: 60 seconds");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports rate-limit redirects without following Location", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://other.example/private" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(wakatimeGet(env, path, {})).rejects.toThrow(/302.*rate limit/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["<html>private response</html>", "{broken", "", '"private response"'])
    ("does not dump malformed/non-object upstream error bodies: %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 500 })));
      const error = await wakatimeGet(env, path, {}).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/500.*no usable error details/i);
      expect((error as Error).message).not.toMatch(/private response|broken/);
    });

  it("redacts credentials in documented error fields and status text", async () => {
    const encodedToken = btoa(env.MCP_AUTH_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: `Invalid ${clientSecret} ${accessToken} ${refreshToken} ${env.MCP_AUTH_TOKEN} ${encodedToken} Authorization: Bearer unrelated-secret`,
      errors: { start: ["Invalid date"], api_key: "unknown-secret", credentials: "cloudflare-secret" },
      debug: "private debug response",
    }, { status: 403, statusText: `Forbidden ${clientSecret}` })));
    const error = await wakatimeGet(env, path, {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    for (const value of [clientSecret, accessToken, refreshToken, env.MCP_AUTH_TOKEN, encodedToken,
      "unrelated-secret", "unknown-secret", "cloudflare-secret", "private debug response"]) {
      expect(message).not.toContain(value);
    }
    expect(message).toContain("Invalid date");
    expect(message).toContain("[REDACTED]");
  });

  it("does not forward arbitrary fetch exception messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`network failure ${clientSecret} cloudflare-credential`); }));
    const error = await wakatimeGet(env, path, {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/WakaTime API request failed:.*network/i);
    expect((error as Error).message).not.toMatch(/test-wakatime-secret|cloudflare-credential/);
  });

  it("keeps request context when upstream error messages are long", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "x".repeat(5000) }, { status: 400 })));
    const error = await wakatimeGet(env, path, { start: "2025-01-01" }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("endpoint: /api/v1/users/current/summaries; query parameters: start");
    expect((error as Error).message.length).toBeLessThan(2000);
  });

  it("redacts named credentials and quoted values in error strings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: 'CLOUDFLARE_API_TOKEN="unknown-cloudflare-token" password="private password" api_key=unknown-api-key',
    }, { status: 403 })));
    const error = await wakatimeGet(env, path, {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/unknown-cloudflare-token|private password|unknown-api-key/);
  });

  it("does not forward response stream exceptions", async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.error(new Error(`stream failed ${accessToken}`));
    } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 500 })));
    const error = await wakatimeGet(env, path, {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("500 Internal Server Error: unable to read upstream response");
    expect((error as Error).message).not.toContain(accessToken);
  });

  it.each([
    ["Wed, 07 Oct 2026 00:00:00 GMT", "Retry-After: Wed, 07 Oct 2026 00:00:00 GMT"],
    ["not-a-retry-time-secret", "rate limited"],
  ])("handles Retry-After safely: %s", async (header, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429, headers: { "Retry-After": header } })));
    const error = await wakatimeGet(env, path, {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain("not-a-retry-time-secret");
  });

  it.each(["not JSON", "null", "[]", '{"data":{}}', '{"error":"unexpected"}'])
    ("rejects invalid success envelopes without dumping them: %s", async (body) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      await expect(wakatimeGet(env, path, {})).rejects.toThrow(/invalid.*response/i);
    });
});
