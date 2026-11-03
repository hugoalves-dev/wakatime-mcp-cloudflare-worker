// ABOUTME: Registers the WakaTime MCP tools against explicit Worker bindings.
// ABOUTME: A fresh instance is created for each stateless HTTP exchange.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./wakatime.js";
import { todayYmd, wakatimeGet, WakaTimeRequestError } from "./wakatime.js";
import { createAuthorizationUrl } from "./oauth.js";

const timezoneInput = z.string().refine((timezone) => {
  if (!timezone || /^[+-]/.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch { return false; }
}, "timezone must be a valid IANA timezone, for example Asia/Tokyo").optional();

const summariesInput = z
  .object({
    start: z.iso.date().describe("YYYY-MM-DD"),
    end: z.iso.date().describe("YYYY-MM-DD"),
    project: z.string().optional(),
    timezone: timezoneInput.describe("Timezone for the dates; defaults to the WakaTime account timezone"),
  })
  .strict()
  .refine(({ start, end }) => start <= end, "start must be on or before end");

const todayInput = z
  .object({
    project: z.string().optional(),
    timezone: timezoneInput.describe("Timezone for today; defaults to Asia/Tokyo"),
  })
  .strict();

async function toolResult(request: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await request() }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof WakaTimeRequestError
        ? error.message : "WakaTime tool request failed unexpectedly; try again later." }],
    };
  }
}

export function createServer(env: Env): McpServer {
  const server = new McpServer({ name: "wakatime-mcp", version: "0.0.2" });

  server.registerTool(
    "wakatime_connect",
    {
      description: "Connect or reconnect the WakaTime account using OAuth. Returns a browser authorization URL.",
      inputSchema: z.object({}).strict(),
    },
    async () => toolResult(async () => {
      const url = await createAuthorizationUrl(env);
      return `Open this WakaTime authorization URL in your browser: ${url}. After approving access, retry the original MCP request.`;
    }),
  );

  server.registerTool(
    "wakatime_summaries",
    {
      description: "WakaTime Summaries API を叩き、指定期間の日次サマリ(JSON)を返します。",
      inputSchema: summariesInput,
    },
    async ({ start, end, project, timezone }) => {
      return toolResult(() => wakatimeGet(env, "users/current/summaries", {
        start,
        end,
        project,
        timezone,
      }));
    },
  );

  server.registerTool(
    "wakatime_today",
    {
      description: "今日のサマリ(JSON)を返します（Asia/Tokyo をデフォルトにします）。",
      inputSchema: todayInput,
    },
    async ({ project, timezone }) => {
      return toolResult(async () => {
        const tz = timezone ?? "Asia/Tokyo";
        const date = todayYmd(tz);
        return wakatimeGet(env, "users/current/summaries", {
          start: date,
          end: date,
          project,
          timezone: tz,
        });
      });
    },
  );

  return server;
}
