/**
 * Runs only the lead finder (no video rendering stack, no Pexels key needed):
 *   npm run leads            (dev, ts-node)
 *   node dist/lead-finder/standalone.js
 *
 * Exposes the same /api/leads API the main server mounts, so the control panel can
 * talk to either one.
 */
import express from "express";
import { logger } from "../logger";
import { createLeadFinder, createLeadFinderRouter } from "./index";

const port = Number(process.env.LEAD_FINDER_PORT || process.env.PORT || 3124);
const finder = createLeadFinder();

const app = express();
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/leads", createLeadFinderRouter(finder));

app.listen(port, () =>
  logger.info({ port, api: "/api/leads" }, "lead finder server is running"),
);
