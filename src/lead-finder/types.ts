import { z } from "zod";

export const platforms = ["youtube", "tiktok", "discord"] as const;
export type Platform = (typeof platforms)[number];

/**
 * What kind of "cold" player a comment points to.
 * - dissatisfied: unhappy with the server they play on now (lags, admins, donate, wipes, dead online…)
 * - seeking: actively looking for a server ("посоветуйте сервер", "куда перейти")
 * - newcomer: wants to start playing / asks how to join
 * - irrelevant: not a lead
 */
export const leadCategories = [
  "dissatisfied",
  "seeking",
  "newcomer",
  "irrelevant",
] as const;
export type LeadCategory = (typeof leadCategories)[number];

/** Pipeline status the operator moves a lead through by hand. */
export const leadStatuses = [
  "new",
  "in_progress",
  "contacted",
  "subscribed",
  "converted",
  "rejected",
] as const;
export type LeadStatus = (typeof leadStatuses)[number];

export const campaignSchema = z.object({
  name: z.string().min(1),
  /** Game the servers are for, e.g. "GTA 5 RP", "Minecraft", "Rust". Used in the LLM prompt. */
  game: z.string().min(1),
  /** YouTube search queries ("обзор серверов гта 5 рп", "лучший сервер майнкрафт"). */
  queries: z.array(z.string().min(1)).default([]),
  /** Competitor / niche channels whose fresh uploads are scanned. Channel IDs (UC…). */
  channelIds: z.array(z.string().min(1)).default([]),
  /** Explicit videos to scan (IDs or URLs). */
  videoIds: z.array(z.string().min(1)).default([]),
  /**
   * Discord servers (guild IDs) where YOUR bot was invited — every readable text channel,
   * forum and active thread is scanned. Partner / clan / streamer communities, your own server.
   */
  discordGuildIds: z.array(z.string().regex(/^\d{15,25}$/)).default([]),
  /** Specific Discord channels (IDs) to scan instead of / in addition to whole servers. */
  discordChannelIds: z.array(z.string().regex(/^\d{15,25}$/)).default([]),
  /** Channels to skip (e.g. #rules, #staff, off-topic memes). Excluding a forum skips its posts. */
  discordExcludeChannelIds: z
    .array(z.string().regex(/^\d{15,25}$/))
    .default([]),
  /** Max Discord messages read per channel per scan; the rest is read on the next scan. */
  maxMessagesPerChannel: z.number().int().positive().max(10000).default(1000),
  /** Names of competitor servers — mentions are stored to see who players leave. */
  competitorNames: z.array(z.string().min(1)).default([]),
  /** Your own server name — comments by people already playing on it are skipped. */
  ownServerName: z.string().optional(),
  /** Extra phrases that signal a lead for this niche (added to the built-in dictionary). */
  extraKeywords: z.array(z.string().min(1)).default([]),
  /** ISO 639-1, passed to YouTube search as relevanceLanguage. */
  language: z.string().default("ru"),
  /** ISO 3166-1 alpha-2, passed to YouTube search as regionCode. */
  regionCode: z.string().optional(),
  /** Only search videos published in the last N days. */
  publishedWithinDays: z.number().int().positive().default(30),
  maxVideosPerQuery: z.number().int().positive().max(50).default(15),
  maxCommentsPerVideo: z.number().int().positive().max(5000).default(500),
  /** Minimum score (0-100) for a comment to be stored as a lead. */
  minScore: z.number().int().min(0).max(100).default(40),
  enabled: z.boolean().default(true),
});
export type CampaignInput = z.input<typeof campaignSchema>;
export type CampaignConfig = z.output<typeof campaignSchema>;

export interface Campaign extends CampaignConfig {
  id: number;
  createdAt: string;
  lastRunAt: string | null;
}

/** A raw comment from any source, before classification. */
export interface RawComment {
  platform: Platform;
  commentId: string;
  parentCommentId?: string | null;
  videoId: string;
  videoUrl: string;
  videoTitle?: string | null;
  videoChannelTitle?: string | null;
  authorId: string;
  authorName: string;
  authorUrl: string;
  text: string;
  likeCount?: number;
  publishedAt: string;
  /** Direct link to the comment (YouTube supports &lc=COMMENT_ID). */
  commentUrl?: string | null;
}

export interface Classification {
  category: LeadCategory;
  /** 0-100, how likely this person is a reachable potential player. */
  score: number;
  matchedKeywords: string[];
  /** Competitor servers mentioned in the comment. */
  mentionedServers: string[];
  /** Short human-readable reason (from the LLM, or the matched rules). */
  reason: string;
  classifier: "rules" | "llm";
}

export interface StoredComment extends RawComment, Classification {
  id: number;
  leadId: number;
  campaignId: number | null;
  foundAt: string;
}

export interface Lead {
  id: number;
  platform: Platform;
  authorId: string;
  authorName: string;
  authorUrl: string;
  status: LeadStatus;
  notes: string;
  tags: string[];
  bestScore: number;
  bestCategory: LeadCategory;
  commentCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export interface LeadWithComments extends Lead {
  comments: StoredComment[];
}

export interface ScanReport {
  campaignId: number | null;
  startedAt: string;
  finishedAt: string;
  videosScanned: number;
  discordChannelsScanned: number;
  commentsRead: number;
  leadsFound: number;
  newLeads: number;
  quotaUnitsUsed: number;
  errors: string[];
}

export const importCommentSchema = z.object({
  platform: z.enum(platforms).default("tiktok"),
  commentId: z.string().min(1),
  videoId: z.string().min(1),
  videoUrl: z.string().url(),
  videoTitle: z.string().optional(),
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  authorUrl: z.string().url(),
  text: z.string().min(1),
  likeCount: z.number().int().nonnegative().optional(),
  publishedAt: z.string().optional(),
  commentUrl: z.string().url().optional(),
});
export type ImportComment = z.input<typeof importCommentSchema>;
