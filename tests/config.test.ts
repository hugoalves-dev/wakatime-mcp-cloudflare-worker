import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("OAuth deployment configuration", () => {
  it("documents OAuth configuration and removes the obsolete API key requirement", () => {
    expect(readme).toContain("WAKATIME_OAUTH_CLIENT_ID");
    expect(readme).toContain("WAKATIME_OAUTH_CLIENT_SECRET");
    expect(readme).toContain("WAKATIME_OAUTH_REDIRECT_URI");
    expect(readme).toContain("WAKATIME_OAUTH_STORE");
    expect(readme).toContain("/oauth/start");
    expect(readme).toContain("read_summaries");
    expect(readme).not.toContain("WAKATIME_API_KEY");
  });

  it("binds the dedicated OAuth KV namespace in Wrangler", () => {
    expect(wrangler).toContain("WAKATIME_OAUTH_CLIENT_ID");
    expect(wrangler).toContain("WAKATIME_OAUTH_REDIRECT_URI");
    expect(wrangler).toMatch(/"binding"\s*:\s*"WAKATIME_OAUTH_STORE"/);
    expect(wrangler).toMatch(/"id"\s*:\s*"REPLACE_WITH_PRODUCTION_KV_NAMESPACE_ID"/);
    expect(wrangler).toMatch(/"preview_id"\s*:\s*"REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID"/);
    expect(wrangler).toMatch(/"invocation_logs"\s*:\s*false/);
  });
});
