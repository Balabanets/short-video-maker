import { logger } from "../logger";
import {
  classifyByRules,
  findMentionedServers,
  normalize,
} from "./classifier/rules";
import { LlmClassifier } from "./classifier/llm";
import type { LeadFinderConfig } from "./config";
import { LeadStore } from "./LeadStore";
import {
  QUOTA_COST,
  QuotaExceededError,
  YouTubeClient,
  YouTubeVideo,
  parseVideoId,
} from "./sources/youtube";
import type {
  Campaign,
  CampaignConfig,
  Classification,
  ImportComment,
  RawComment,
  ScanReport,
} from "./types";
import { importCommentSchema } from "./types";

type ClassifyContext = Pick<
  CampaignConfig,
  "game" | "competitorNames" | "ownServerName" | "extraKeywords" | "minScore"
>;

const DEFAULT_IMPORT_CONTEXT: ClassifyContext = {
  game: "online game servers",
  competitorNames: [],
  extraKeywords: [],
  minScore: 40,
};

/** Day key in Pacific time — YouTube resets quota at midnight PT. */
const quotaDay = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export class LeadFinder {
  private youtube: YouTubeClient | null;
  private llm: LlmClassifier | null;
  private running: Promise<ScanReport[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private quota = { day: quotaDay(), used: 0 };

  constructor(
    public readonly config: LeadFinderConfig,
    public readonly store: LeadStore,
    deps: { youtube?: YouTubeClient | null; llm?: LlmClassifier | null } = {},
  ) {
    this.youtube =
      deps.youtube !== undefined
        ? deps.youtube
        : config.youtubeApiKey
          ? new YouTubeClient(config.youtubeApiKey)
          : null;
    this.llm =
      deps.llm !== undefined
        ? deps.llm
        : config.llm
          ? new LlmClassifier(config.llm.model, config.llm.apiKey)
          : null;
  }

  status() {
    this.rollQuotaDay();
    return {
      youtubeConfigured: Boolean(this.youtube),
      llmClassifier: this.llm ? (this.config.llm?.model ?? "custom") : null,
      scanning: Boolean(this.running),
      scheduleMinutes: this.config.scanIntervalMinutes,
      quota: {
        day: this.quota.day,
        used: this.quota.used,
        budget: this.config.dailyQuotaBudget,
      },
    };
  }

  // ---------------------------------------------------------------- scheduling

  startScheduler() {
    if (!this.config.scanIntervalMinutes || this.timer) return;
    const ms = this.config.scanIntervalMinutes * 60_000;
    logger.info(
      { everyMinutes: this.config.scanIntervalMinutes },
      "lead finder scheduler started",
    );
    this.timer = setInterval(() => {
      this.scanAll().catch((e) =>
        logger.error(e, "scheduled lead scan failed"),
      );
    }, ms);
    this.timer.unref();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every enabled campaign (or the given ones). Only one scan runs at a time. */
  scanAll(campaignIds?: number[]): Promise<ScanReport[]> {
    if (this.running) return this.running;
    const campaigns = this.store
      .listCampaigns()
      .filter((c) => (campaignIds ? campaignIds.includes(c.id) : c.enabled));
    this.running = (async () => {
      const reports: ScanReport[] = [];
      try {
        for (const c of campaigns) reports.push(await this.runCampaign(c));
      } finally {
        this.running = null;
      }
      return reports;
    })();
    return this.running;
  }

  // ---------------------------------------------------------------- YouTube scan

  private rollQuotaDay() {
    const day = quotaDay();
    if (day !== this.quota.day) this.quota = { day, used: 0 };
  }

  private ensureQuota(cost: number) {
    this.rollQuotaDay();
    if (this.quota.used + cost > this.config.dailyQuotaBudget) {
      throw new QuotaExceededError(
        `daily YouTube quota budget reached (${this.quota.used}/${this.config.dailyQuotaBudget})`,
      );
    }
  }

  private async yt<T>(
    cost: number,
    fn: (yt: YouTubeClient) => Promise<T>,
  ): Promise<T> {
    if (!this.youtube) throw new Error("YOUTUBE_API_KEY is not configured");
    this.ensureQuota(cost);
    const before = this.youtube.quotaUsed;
    try {
      return await fn(this.youtube);
    } finally {
      this.quota.used += this.youtube.quotaUsed - before;
    }
  }

  async runCampaign(campaign: Campaign): Promise<ScanReport> {
    const quotaStart = this.quota.used;
    const report: ScanReport = {
      campaignId: campaign.id,
      startedAt: new Date().toISOString(),
      finishedAt: "",
      videosScanned: 0,
      commentsRead: 0,
      leadsFound: 0,
      newLeads: 0,
      quotaUnitsUsed: 0,
      errors: [],
    };
    logger.info({ campaign: campaign.name }, "lead scan started");

    try {
      if (!this.youtube)
        throw new Error("YOUTUBE_API_KEY is not configured (import-only mode)");
      const videos = await this.collectVideos(campaign, report);
      for (const video of videos) {
        const state = this.store.getVideoScanState("youtube", video.videoId);
        if (
          state &&
          this.config.minRescanMinutes > 0 &&
          Date.now() - Date.parse(state.lastScannedAt) <
            this.config.minRescanMinutes * 60_000
        ) {
          continue;
        }
        try {
          const comments = await this.yt(QUOTA_COST.list, (yt) =>
            yt.fetchComments(video, {
              since: state?.newestCommentAt,
              limit: campaign.maxCommentsPerVideo,
            }),
          );
          const result = await this.processComments(
            comments,
            campaign,
            campaign.id,
          );
          const newest = comments.reduce<string | null>(
            (max, c) => (!max || c.publishedAt > max ? c.publishedAt : max),
            null,
          );
          this.store.recordVideoScan({
            platform: "youtube",
            videoId: video.videoId,
            title: video.title,
            channelTitle: video.channelTitle,
            newestCommentAt: newest,
            commentsRead: comments.length,
            leadsFound: result.leadsFound,
          });
          report.videosScanned++;
          report.commentsRead += comments.length;
          report.leadsFound += result.leadsFound;
          report.newLeads += result.newLeads;
        } catch (e) {
          if (e instanceof QuotaExceededError) throw e;
          report.errors.push(`${video.videoId}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      report.errors.push((e as Error).message);
      logger.warn(
        { campaign: campaign.name, error: (e as Error).message },
        "lead scan stopped early",
      );
    }

    this.store.markCampaignRun(campaign.id);
    report.finishedAt = new Date().toISOString();
    report.quotaUnitsUsed = this.quota.used - quotaStart;
    this.store.saveScanRun(report);
    logger.info(
      { campaign: campaign.name, ...report, errors: report.errors.length },
      "lead scan finished",
    );
    return report;
  }

  private async collectVideos(
    campaign: Campaign,
    report: ScanReport,
  ): Promise<YouTubeVideo[]> {
    const byId = new Map<string, YouTubeVideo>();
    const publishedAfter = new Date(
      Date.now() - campaign.publishedWithinDays * 86_400_000,
    );

    for (const q of campaign.queries) {
      try {
        const found = await this.yt(QUOTA_COST.search, (yt) =>
          yt.searchVideos(q, {
            publishedAfter,
            relevanceLanguage: campaign.language,
            regionCode: campaign.regionCode,
            maxResults: campaign.maxVideosPerQuery,
          }),
        );
        found.forEach((v) => byId.set(v.videoId, v));
      } catch (e) {
        if (e instanceof QuotaExceededError) throw e;
        report.errors.push(`search "${q}": ${(e as Error).message}`);
      }
    }

    for (const channelId of campaign.channelIds) {
      try {
        const uploads = await this.yt(2 * QUOTA_COST.list, (yt) =>
          yt.channelUploads(channelId, campaign.maxVideosPerQuery),
        );
        uploads
          .filter((v) => Date.parse(v.publishedAt) >= publishedAfter.getTime())
          .forEach((v) => byId.set(v.videoId, v));
      } catch (e) {
        if (e instanceof QuotaExceededError) throw e;
        report.errors.push(`channel ${channelId}: ${(e as Error).message}`);
      }
    }

    if (campaign.videoIds.length) {
      const ids = campaign.videoIds.map(parseVideoId);
      try {
        const vids = await this.yt(Math.ceil(ids.length / 50), (yt) =>
          yt.getVideos(ids),
        );
        vids.forEach((v) => byId.set(v.videoId, v));
      } catch (e) {
        if (e instanceof QuotaExceededError) throw e;
        report.errors.push(`videos: ${(e as Error).message}`);
      }
    }
    return [...byId.values()];
  }

  // ---------------------------------------------------------------- classification

  /**
   * Classifies new comments and stores the ones that look like leads.
   * Comments already seen (by platform + comment id) are skipped so nothing is paid for twice.
   */
  async processComments(
    comments: RawComment[],
    ctx: ClassifyContext,
    campaignId: number | null,
  ): Promise<{ classified: number; leadsFound: number; newLeads: number }> {
    const fresh = this.store.filterUnseen(comments);
    if (fresh.length === 0)
      return { classified: 0, leadsFound: 0, newLeads: 0 };

    const verdicts: Classification[] = fresh.map((c) =>
      classifyByRules(c.text, {
        competitorNames: ctx.competitorNames,
        extraKeywords: ctx.extraKeywords,
        ownServerName: ctx.ownServerName,
      }),
    );

    if (this.llm) {
      const candidates = fresh
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => this.worthLlm(c, verdicts[i], ctx));
      if (candidates.length) {
        const llmVerdicts = await this.llm.classify(
          candidates.map((x) => x.c),
          {
            game: ctx.game,
            competitorNames: ctx.competitorNames,
            ownServerName: ctx.ownServerName,
          },
        );
        llmVerdicts.forEach((v, k) => {
          const i = candidates[k].i;
          verdicts[i] = {
            ...v,
            matchedKeywords: verdicts[i].matchedKeywords,
            mentionedServers: [
              ...new Set([
                ...v.mentionedServers,
                ...verdicts[i].mentionedServers,
              ]),
            ],
          };
        });
      }
    }

    let leadsFound = 0;
    let newLeads = 0;
    fresh.forEach((c, i) => {
      const v = verdicts[i];
      if (v.category === "irrelevant" || v.score < ctx.minScore) return;
      const { isNew } = this.store.saveLead(c, v, campaignId);
      leadsFound++;
      if (isNew) newLeads++;
    });
    this.store.markSeen(fresh);
    return { classified: fresh.length, leadsFound, newLeads };
  }

  /** Cheap gate in front of the LLM: rules found something, or the comment talks about servers at all. */
  private worthLlm(
    c: RawComment,
    rules: Classification,
    ctx: ClassifyContext,
  ): boolean {
    if (
      rules.reason === "looks like spam / self-promo" ||
      rules.reason === "too short"
    )
      return false;
    if (this.config.llm?.prefilter === "all") return true;
    if (rules.score > 0) return true;
    const t = normalize(c.text);
    return (
      /сервер|server|проект|админ|донат|вайп|онлайн|играть|играю|поиграть/.test(
        t,
      ) || findMentionedServers(c.text, ctx.competitorNames).length > 0
    );
  }

  // ---------------------------------------------------------------- import (TikTok etc.)

  /**
   * Accepts comments collected outside the YouTube API (TikTok, manual copy, an export
   * from a licensed data provider) and runs them through the same classifier and store.
   */
  async importComments(items: ImportComment[], campaignId?: number | null) {
    const campaign = campaignId ? this.store.getCampaign(campaignId) : null;
    const parsed: RawComment[] = items.map((raw) => {
      const i = importCommentSchema.parse(raw);
      return {
        ...i,
        publishedAt: i.publishedAt ?? new Date().toISOString(),
        commentUrl: i.commentUrl ?? i.videoUrl,
      };
    });
    return this.processComments(
      parsed,
      campaign ?? DEFAULT_IMPORT_CONTEXT,
      campaign?.id ?? null,
    );
  }
}
