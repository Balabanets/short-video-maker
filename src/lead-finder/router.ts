import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { logger } from "../logger";
import type { LeadFinder } from "./LeadFinder";
import {
  campaignSchema,
  importCommentSchema,
  leadCategories,
  leadStatuses,
  platforms,
} from "./types";

const leadQuerySchema = z.object({
  status: z.enum(leadStatuses).optional(),
  category: z.enum(leadCategories).optional(),
  platform: z.enum(platforms).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  campaignId: z.coerce.number().int().optional(),
  search: z.string().optional(),
  sort: z.enum(["score", "recent"]).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const leadPatchSchema = z.object({
  status: z.enum(leadStatuses).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
});

const importSchema = z.object({
  campaignId: z.number().int().optional(),
  comments: z.array(importCommentSchema).min(1).max(5000),
});

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // Prefix formula-looking cells so spreadsheets don't execute them.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/**
 * REST API for the control panel, mounted at /api/leads.
 *
 *   GET    /status                 config, quota, whether a scan is running
 *   GET    /campaigns              list            POST /campaigns            create
 *   PUT    /campaigns/:id          replace         DELETE /campaigns/:id      delete
 *   POST   /campaigns/:id/scan     scan one campaign now (waits for the result)
 *   POST   /scan                   scan all enabled campaigns in the background
 *   GET    /scans                  recent scan reports
 *   GET    /                       list leads (filters: status, category, platform, minScore, campaignId, search, sort, limit, offset)
 *   GET    /export.csv             same filters, CSV for spreadsheets / CRM import
 *   GET    /stats                  insights: statuses, categories, competitor mentions, best videos/channels
 *   GET    /:id                    one lead with all its comments
 *   PATCH  /:id                    { status, notes, tags }
 *   DELETE /:id                    remove a lead and its comments
 *   POST   /import                 { campaignId?, comments: [...] } — TikTok / manual comments
 */
export function createLeadFinderRouter(finder: LeadFinder): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "5mb" }));

  if (finder.config.apiToken) {
    const token = finder.config.apiToken;
    router.use((req: Request, res: Response, next: NextFunction) => {
      if (req.headers.authorization === `Bearer ${token}`) return next();
      res.status(401).json({ error: "unauthorized" });
    });
  }

  const idParam = (req: Request) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await fn(req, res);
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          res
            .status(400)
            .json({ error: "validation failed", issues: error.issues });
          return;
        }
        logger.error(error, "lead finder API error");
        res
          .status(500)
          .json({
            error: error instanceof Error ? error.message : "unknown error",
          });
      }
    };

  router.get(
    "/status",
    handle((_req, res) => res.json(finder.status())),
  );

  // ------------------------------------------------------------ campaigns
  router.get(
    "/campaigns",
    handle((_req, res) =>
      res.json({ campaigns: finder.store.listCampaigns() }),
    ),
  );

  router.post(
    "/campaigns",
    handle((req, res) => {
      const config = campaignSchema.parse(req.body);
      res.status(201).json(finder.store.createCampaign(config));
    }),
  );

  router.put(
    "/campaigns/:id",
    handle((req, res) => {
      const id = idParam(req);
      if (!id || !finder.store.getCampaign(id))
        return res.status(404).json({ error: "not found" });
      res.json(finder.store.updateCampaign(id, campaignSchema.parse(req.body)));
    }),
  );

  router.delete(
    "/campaigns/:id",
    handle((req, res) => {
      const id = idParam(req);
      res
        .status(id && finder.store.deleteCampaign(id) ? 200 : 404)
        .json({ success: Boolean(id) });
    }),
  );

  router.post(
    "/campaigns/:id/scan",
    handle(async (req, res) => {
      const id = idParam(req);
      if (!id || !finder.store.getCampaign(id))
        return res.status(404).json({ error: "not found" });
      if (finder.status().scanning)
        return res.status(409).json({ error: "a scan is already running" });
      const [report] = await finder.scanAll([id]);
      res.json(report);
    }),
  );

  router.post(
    "/scan",
    handle((_req, res) => {
      if (finder.status().scanning)
        return res.status(409).json({ error: "a scan is already running" });
      finder.scanAll().catch((e) => logger.error(e, "lead scan failed"));
      res.status(202).json({ started: true });
    }),
  );

  router.get(
    "/scans",
    handle((_req, res) => res.json({ scans: finder.store.listScanRuns() })),
  );

  // ------------------------------------------------------------ import
  router.post(
    "/import",
    handle(async (req, res) => {
      const body = importSchema.parse(req.body);
      res.json(await finder.importComments(body.comments, body.campaignId));
    }),
  );

  // ------------------------------------------------------------ leads
  router.get(
    "/stats",
    handle((_req, res) => res.json(finder.store.stats())),
  );

  router.get(
    "/export.csv",
    handle((req, res) => {
      const q = leadQuerySchema.parse(req.query);
      const { items } = finder.store.listLeads({
        ...q,
        limit: 500,
        offset: q.offset ?? 0,
      });
      const header = [
        "id",
        "platform",
        "author",
        "profile_url",
        "status",
        "score",
        "category",
        "comment",
        "comment_url",
        "video_title",
        "video_url",
        "published_at",
        "notes",
      ];
      const lines = [header.join(",")];
      for (const lead of items) {
        const c = lead.comments[0];
        lines.push(
          [
            lead.id,
            lead.platform,
            lead.authorName,
            lead.authorUrl,
            lead.status,
            lead.bestScore,
            lead.bestCategory,
            c?.text,
            c?.commentUrl,
            c?.videoTitle,
            c?.videoUrl,
            c?.publishedAt,
            lead.notes,
          ]
            .map(csvCell)
            .join(","),
        );
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
      res.send("﻿" + lines.join("\n"));
    }),
  );

  router.get(
    "/",
    handle((req, res) =>
      res.json(finder.store.listLeads(leadQuerySchema.parse(req.query))),
    ),
  );

  router.get(
    "/:id",
    handle((req, res) => {
      const id = idParam(req);
      const lead = id ? finder.store.getLead(id) : null;
      if (!lead) return res.status(404).json({ error: "not found" });
      res.json(lead);
    }),
  );

  router.patch(
    "/:id",
    handle((req, res) => {
      const id = idParam(req);
      if (!id || !finder.store.getLead(id))
        return res.status(404).json({ error: "not found" });
      res.json(finder.store.updateLead(id, leadPatchSchema.parse(req.body)));
    }),
  );

  router.delete(
    "/:id",
    handle((req, res) => {
      const id = idParam(req);
      res
        .status(id && finder.store.deleteLead(id) ? 200 : 404)
        .json({ success: Boolean(id) });
    }),
  );

  return router;
}
