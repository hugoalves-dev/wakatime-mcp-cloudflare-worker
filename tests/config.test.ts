import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const wrangler = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as {
  vars?: Record<string, string>;
  durable_objects?: {
    bindings?: Array<{ name: string; class_name: string }>;
  };
  migrations?: Array<{
    tag: string;
    new_sqlite_classes?: string[];
    new_classes?: string[];
  }>;
  observability?: { logs?: { invocation_logs?: boolean } };
};

describe("OAuth deployment configuration", () => {
  it("documents OAuth configuration and removes the obsolete API key requirement", () => {
    expect(readme).toContain("WAKATIME_OAUTH_CLIENT_ID");
    expect(readme).toContain("WAKATIME_OAUTH_CLIENT_SECRET");
    expect(readme).toContain("WAKATIME_OAUTH_REDIRECT_URI");
    expect(readme).toContain("Worker secrets");
    expect(readme).toContain("Durable Object");
    expect(readme).toContain("WAKATIME_OWNER_EMAIL");
    expect(readme).toContain("read_summaries");
    expect(readme).not.toContain("WAKATIME_API_KEY");
  });

  it("uses a SQLite-backed OAuth Durable Object and preserves dashboard-managed secrets", () => {
    expect(wrangler.vars).toBeUndefined();
    expect(wrangler.durable_objects?.bindings).toContainEqual({
      name: "WAKATIME_OAUTH_COORDINATOR",
      class_name: "WakaTimeOAuthCoordinator",
    });
    expect(wrangler.migrations).toContainEqual({
      tag: "v2-wakatime-sqlite",
      new_sqlite_classes: ["WakaTimeOAuthCoordinator"],
    });
    expect(wrangler.migrations?.some((migration) => migration.new_classes)).toBe(false);
    expect(wrangler.observability?.logs?.invocation_logs).toBe(false);
  });
});
