/**
 * Runs only the lead finder (no video rendering stack, no Pexels key needed):
 *   npm run leads            (dev, ts-node)
 *   node dist/lead-finder/standalone.js
 *
 * Exposes the same /api/leads API the main server mounts, so the control panel can
 * talk to either one.
 */
import path from "path";
import fs from "fs";
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

// Serve the web panel (Leads + Campaigns pages) if it was built (`npm run ui:build`).
// Built UI lives in dist/ui; from src/ (ts-node) "../ui" would be the unbuilt sources.
const builtUi = path.resolve(
  __dirname,
  __filename.endsWith(".ts") ? "../../dist/ui" : "../ui",
);
const uiDir = fs.existsSync(path.join(builtUi, "index.html")) ? builtUi : null;
if (uiDir) {
  app.use(express.static(uiDir));
  app.get("*", (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
} else {
  logger.info("UI is not built — run `npm run ui:build` to get the web panel");
}

app.listen(port, () =>
  logger.info({ port, api: "/api/leads" }, "lead finder server is running"),
);
