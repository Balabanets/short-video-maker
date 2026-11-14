import path from "path";
import os from "os";
import "dotenv/config";

export interface LeadFinderConfig {
  youtubeApiKey?: string;
  dbPath: string;
  /** null = LLM classification off, rules only. */
  llm: { apiKey?: string; model: string; prefilter: "signals" | "all" } | null;
  /** 0 = no automatic scans (run via API only). */
  scanIntervalMinutes: number;
  /** Soft daily cap on YouTube API units this service may spend (Google's default project quota is 10 000). */
  dailyQuotaBudget: number;
  /** Don't re-read the same video more often than this. */
  minRescanMinutes: number;
  /** If set, every /api/leads request must send `Authorization: Bearer <token>`. */
  apiToken?: string;
}

export function loadLeadFinderConfig(env: NodeJS.ProcessEnv = process.env): LeadFinderConfig {
  const dataDir = env.DATA_DIR_PATH || path.join(os.homedir(), ".ai-agents-az-video-generator");
  const llmEnabled =
    env.LEAD_FINDER_LLM !== "false" && Boolean(env.ANTHROPIC_API_KEY || env.LEAD_FINDER_LLM === "true");
  return {
    youtubeApiKey: env.YOUTUBE_API_KEY || undefined,
    dbPath: env.LEAD_FINDER_DB_PATH || path.join(dataDir, "leads.db"),
    llm: llmEnabled
      ? {
          apiKey: env.ANTHROPIC_API_KEY || undefined,
          model: env.LEAD_FINDER_LLM_MODEL || "claude-opus-5-5",
          prefilter: env.LEAD_FINDER_LLM_PREFILTER === "all" ? "all" : "signals",
        }
      : null,
    scanIntervalMinutes: Number(env.LEAD_FINDER_SCAN_INTERVAL_MINUTES ?? 0) || 0,
    dailyQuotaBudget: Number(env.LEAD_FINDER_DAILY_QUOTA ?? 9000) || 9000,
    minRescanMinutes: Number(env.LEAD_FINDER_MIN_RESCAN_MINUTES ?? 60) || 0,
    apiToken: env.LEAD_FINDER_API_TOKEN || undefined,
  };
}
