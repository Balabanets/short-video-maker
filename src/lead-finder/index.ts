import { logger } from "../logger";
import { loadLeadFinderConfig, LeadFinderConfig } from "./config";
import { LeadFinder } from "./LeadFinder";
import { LeadStore } from "./LeadStore";

export { LeadFinder } from "./LeadFinder";
export { LeadStore } from "./LeadStore";
export { createLeadFinderRouter } from "./router";
export { loadLeadFinderConfig } from "./config";
export * from "./types";

export function createLeadFinder(
  config: LeadFinderConfig = loadLeadFinderConfig(),
): LeadFinder {
  const finder = new LeadFinder(config, new LeadStore(config.dbPath));
  if (!config.youtubeApiKey) {
    logger.warn(
      "YOUTUBE_API_KEY is not set — lead finder works in import-only mode",
    );
  }
  logger.info(
    {
      db: config.dbPath,
      llm: config.llm?.model ?? "off (rules only)",
      schedule: config.scanIntervalMinutes,
    },
    "lead finder ready",
  );
  finder.startScheduler();
  return finder;
}
