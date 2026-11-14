import { createRequire } from "module";
import path from "path";
import fs from "fs-extra";
import type {
  DatabaseSync as DatabaseSyncType,
  SQLInputValue,
} from "node:sqlite";
import type {
  Campaign,
  CampaignConfig,
  Classification,
  Lead,
  LeadCategory,
  LeadStatus,
  LeadWithComments,
  Platform,
  RawComment,
  ScanReport,
  StoredComment,
} from "./types";

// Built-in since Node 22.5 — loaded via require so bundlers/test runners don't try to resolve it.
const { DatabaseSync } = createRequire(__filename)(
  "node:sqlite",
) as typeof import("node:sqlite");

type Row = Record<string, unknown>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  best_score INTEGER NOT NULL DEFAULT 0,
  best_category TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, author_id)
);
CREATE INDEX IF NOT EXISTS leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS leads_score ON leads(best_score);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  parent_comment_id TEXT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  video_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  video_title TEXT,
  video_channel_title TEXT,
  text TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL,
  comment_url TEXT,
  category TEXT NOT NULL,
  score INTEGER NOT NULL,
  matched_keywords TEXT NOT NULL DEFAULT '[]',
  mentioned_servers TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  classifier TEXT NOT NULL,
  found_at TEXT NOT NULL,
  UNIQUE (platform, comment_id)
);
CREATE INDEX IF NOT EXISTS comments_lead ON comments(lead_id);

-- Every comment ever classified (leads or not), so re-scans and re-imports never pay twice.
CREATE TABLE IF NOT EXISTS seen_comments (
  platform TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  PRIMARY KEY (platform, comment_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS scanned_videos (
  platform TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT,
  channel_title TEXT,
  last_scanned_at TEXT NOT NULL,
  newest_comment_at TEXT,
  comments_read INTEGER NOT NULL DEFAULT 0,
  leads_found INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (platform, video_id)
);

CREATE TABLE IF NOT EXISTS quota_usage (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER,
  started_at TEXT NOT NULL,
  report TEXT NOT NULL
);
`;

export interface LeadQuery {
  status?: LeadStatus;
  category?: LeadCategory;
  platform?: Platform;
  minScore?: number;
  campaignId?: number;
  search?: string;
  sort?: "score" | "recent";
  limit?: number;
  offset?: number;
}

const now = () => new Date().toISOString();
const json = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

export class LeadStore {
  private db: DatabaseSyncType;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.ensureDirSync(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------------------------------------------------------------- campaigns

  createCampaign(config: CampaignConfig): Campaign {
    const res = this.db
      .prepare(
        "INSERT INTO campaigns (name, config, created_at) VALUES (?, ?, ?)",
      )
      .run(config.name, JSON.stringify(config), now());
    return this.getCampaign(Number(res.lastInsertRowid))!;
  }

  updateCampaign(id: number, config: CampaignConfig): Campaign | null {
    this.db
      .prepare("UPDATE campaigns SET name = ?, config = ? WHERE id = ?")
      .run(config.name, JSON.stringify(config), id);
    return this.getCampaign(id);
  }

  deleteCampaign(id: number): boolean {
    return (
      this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id).changes > 0
    );
  }

  getCampaign(id: number): Campaign | null {
    const row = this.db
      .prepare("SELECT * FROM campaigns WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? this.toCampaign(row) : null;
  }

  listCampaigns(): Campaign[] {
    return (
      this.db.prepare("SELECT * FROM campaigns ORDER BY id").all() as Row[]
    ).map((r) => this.toCampaign(r));
  }

  markCampaignRun(id: number) {
    this.db
      .prepare("UPDATE campaigns SET last_run_at = ? WHERE id = ?")
      .run(now(), id);
  }

  private toCampaign(row: Row): Campaign {
    return {
      ...json<CampaignConfig>(row.config, {} as CampaignConfig),
      id: Number(row.id),
      name: String(row.name),
      createdAt: String(row.created_at),
      lastRunAt: (row.last_run_at as string) ?? null,
    };
  }

  // ---------------------------------------------------------------- quota

  /** YouTube units spent on a (Pacific-time) day — survives restarts so the budget holds. */
  getQuota(day: string): { day: string; used: number } {
    const row = this.db
      .prepare("SELECT used FROM quota_usage WHERE day = ?")
      .get(day) as Row | undefined;
    return { day, used: row ? Number(row.used) : 0 };
  }

  saveQuota(day: string, used: number) {
    this.db
      .prepare(
        "INSERT INTO quota_usage (day, used) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET used = excluded.used",
      )
      .run(day, used);
  }

  // ---------------------------------------------------------------- scanning state

  filterUnseen(comments: RawComment[]): RawComment[] {
    const stmt = this.db.prepare(
      "SELECT 1 FROM seen_comments WHERE platform = ? AND comment_id = ?",
    );
    return comments.filter((c) => !stmt.get(c.platform, c.commentId));
  }

  markSeen(comments: RawComment[]) {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO seen_comments (platform, comment_id) VALUES (?, ?)",
    );
    this.tx(() => comments.forEach((c) => stmt.run(c.platform, c.commentId)));
  }

  getVideoScanState(
    platform: Platform,
    videoId: string,
  ): { newestCommentAt: string | null; lastScannedAt: string } | null {
    const row = this.db
      .prepare(
        "SELECT newest_comment_at, last_scanned_at FROM scanned_videos WHERE platform = ? AND video_id = ?",
      )
      .get(platform, videoId) as Row | undefined;
    return row
      ? {
          newestCommentAt: (row.newest_comment_at as string) ?? null,
          lastScannedAt: String(row.last_scanned_at),
        }
      : null;
  }

  recordVideoScan(v: {
    platform: Platform;
    videoId: string;
    title?: string | null;
    channelTitle?: string | null;
    newestCommentAt: string | null;
    commentsRead: number;
    leadsFound: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO scanned_videos (platform, video_id, title, channel_title, last_scanned_at, newest_comment_at, comments_read, leads_found)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, video_id) DO UPDATE SET
           title = COALESCE(excluded.title, title),
           channel_title = COALESCE(excluded.channel_title, channel_title),
           last_scanned_at = excluded.last_scanned_at,
           newest_comment_at = MAX(COALESCE(newest_comment_at, ''), COALESCE(excluded.newest_comment_at, '')),
           comments_read = comments_read + excluded.comments_read,
           leads_found = leads_found + excluded.leads_found`,
      )
      .run(
        v.platform,
        v.videoId,
        v.title ?? null,
        v.channelTitle ?? null,
        now(),
        v.newestCommentAt,
        v.commentsRead,
        v.leadsFound,
      );
  }

  saveScanRun(report: ScanReport) {
    this.db
      .prepare(
        "INSERT INTO scan_runs (campaign_id, started_at, report) VALUES (?, ?, ?)",
      )
      .run(report.campaignId, report.startedAt, JSON.stringify(report));
  }

  listScanRuns(limit = 20): ScanReport[] {
    return (
      this.db
        .prepare("SELECT report FROM scan_runs ORDER BY id DESC LIMIT ?")
        .all(limit) as Row[]
    ).map((r) => json<ScanReport>(r.report, {} as ScanReport));
  }

  // ---------------------------------------------------------------- leads

  /** Upserts the author as a lead and attaches the comment. Returns whether the lead is new. */
  saveLead(
    comment: RawComment,
    cls: Classification,
    campaignId: number | null,
  ): { leadId: number; isNew: boolean } {
    return this.tx(() => {
      const ts = now();
      const existing = this.db
        .prepare(
          "SELECT id, best_score FROM leads WHERE platform = ? AND author_id = ?",
        )
        .get(comment.platform, comment.authorId) as Row | undefined;

      let leadId: number;
      if (existing) {
        leadId = Number(existing.id);
        const better = cls.score > Number(existing.best_score);
        this.db
          .prepare(
            `UPDATE leads SET author_name = ?, author_url = ?, last_seen_at = ?, updated_at = ?
               ${better ? ", best_score = ?, best_category = ?" : ""} WHERE id = ?`,
          )
          .run(
            ...([
              comment.authorName,
              comment.authorUrl,
              ts,
              ts,
            ] as SQLInputValue[]),
            ...((better ? [cls.score, cls.category] : []) as SQLInputValue[]),
            leadId,
          );
      } else {
        const res = this.db
          .prepare(
            `INSERT INTO leads (platform, author_id, author_name, author_url, best_score, best_category, first_seen_at, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            comment.platform,
            comment.authorId,
            comment.authorName,
            comment.authorUrl,
            cls.score,
            cls.category,
            ts,
            ts,
            ts,
          );
        leadId = Number(res.lastInsertRowid);
      }

      this.db
        .prepare(
          `INSERT OR IGNORE INTO comments (platform, comment_id, parent_comment_id, lead_id, campaign_id, video_id, video_url,
             video_title, video_channel_title, text, like_count, published_at, comment_url, category, score,
             matched_keywords, mentioned_servers, reason, classifier, found_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          comment.platform,
          comment.commentId,
          comment.parentCommentId ?? null,
          leadId,
          campaignId,
          comment.videoId,
          comment.videoUrl,
          comment.videoTitle ?? null,
          comment.videoChannelTitle ?? null,
          comment.text,
          comment.likeCount ?? 0,
          comment.publishedAt,
          comment.commentUrl ?? null,
          cls.category,
          cls.score,
          JSON.stringify(cls.matchedKeywords),
          JSON.stringify(cls.mentionedServers),
          cls.reason,
          cls.classifier,
          ts,
        );

      return { leadId, isNew: !existing };
    });
  }

  listLeads(q: LeadQuery = {}): { total: number; items: LeadWithComments[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.status) where.push("l.status = ?"), params.push(q.status);
    if (q.category) where.push("l.best_category = ?"), params.push(q.category);
    if (q.platform) where.push("l.platform = ?"), params.push(q.platform);
    if (q.minScore !== undefined)
      where.push("l.best_score >= ?"), params.push(q.minScore);
    if (q.campaignId !== undefined) {
      where.push(
        "EXISTS (SELECT 1 FROM comments c WHERE c.lead_id = l.id AND c.campaign_id = ?)",
      );
      params.push(q.campaignId);
    }
    if (q.search) {
      where.push(
        "(l.author_name LIKE ? OR l.notes LIKE ? OR EXISTS (SELECT 1 FROM comments c WHERE c.lead_id = l.id AND c.text LIKE ?))",
      );
      const like = `%${q.search}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order =
      q.sort === "recent"
        ? "l.last_seen_at DESC"
        : "l.best_score DESC, l.last_seen_at DESC";
    const limit = Math.min(q.limit ?? 50, 500);
    const offset = q.offset ?? 0;

    const total = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM leads l ${whereSql}`)
          .get(...params) as Row
      ).n,
    );
    const rows = this.db
      .prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM comments c WHERE c.lead_id = l.id) AS comment_count
         FROM leads l ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Row[];

    return {
      total,
      items: rows.map((r) => ({
        ...this.toLead(r),
        comments: this.commentsFor(Number(r.id)),
      })),
    };
  }

  getLead(id: number): LeadWithComments | null {
    const row = this.db
      .prepare(
        "SELECT l.*, (SELECT COUNT(*) FROM comments c WHERE c.lead_id = l.id) AS comment_count FROM leads l WHERE id = ?",
      )
      .get(id) as Row | undefined;
    return row ? { ...this.toLead(row), comments: this.commentsFor(id) } : null;
  }

  updateLead(
    id: number,
    patch: { status?: LeadStatus; notes?: string; tags?: string[] },
  ): LeadWithComments | null {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.status) sets.push("status = ?"), params.push(patch.status);
    if (patch.notes !== undefined)
      sets.push("notes = ?"), params.push(patch.notes);
    if (patch.tags)
      sets.push("tags = ?"), params.push(JSON.stringify(patch.tags));
    if (sets.length) {
      sets.push("updated_at = ?");
      params.push(now());
      this.db
        .prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params, id);
    }
    return this.getLead(id);
  }

  /** Hard delete (e.g. a person asks to be removed). Comments go with it. */
  deleteLead(id: number): boolean {
    return (
      this.db.prepare("DELETE FROM leads WHERE id = ?").run(id).changes > 0
    );
  }

  private commentsFor(leadId: number): StoredComment[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM comments WHERE lead_id = ? ORDER BY score DESC, published_at DESC",
        )
        .all(leadId) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      leadId: Number(r.lead_id),
      campaignId: r.campaign_id === null ? null : Number(r.campaign_id),
      platform: r.platform as Platform,
      commentId: String(r.comment_id),
      parentCommentId: (r.parent_comment_id as string) ?? null,
      videoId: String(r.video_id),
      videoUrl: String(r.video_url),
      videoTitle: (r.video_title as string) ?? null,
      videoChannelTitle: (r.video_channel_title as string) ?? null,
      authorId: "",
      authorName: "",
      authorUrl: "",
      text: String(r.text),
      likeCount: Number(r.like_count),
      publishedAt: String(r.published_at),
      commentUrl: (r.comment_url as string) ?? null,
      category: r.category as LeadCategory,
      score: Number(r.score),
      matchedKeywords: json<string[]>(r.matched_keywords, []),
      mentionedServers: json<string[]>(r.mentioned_servers, []),
      reason: String(r.reason),
      classifier: r.classifier as "rules" | "llm",
      foundAt: String(r.found_at),
    }));
  }

  private toLead(r: Row): Lead {
    return {
      id: Number(r.id),
      platform: r.platform as Platform,
      authorId: String(r.author_id),
      authorName: String(r.author_name),
      authorUrl: String(r.author_url),
      status: r.status as LeadStatus,
      notes: String(r.notes),
      tags: json<string[]>(r.tags, []),
      bestScore: Number(r.best_score),
      bestCategory: r.best_category as LeadCategory,
      commentCount: Number(r.comment_count ?? 0),
      firstSeenAt: String(r.first_seen_at),
      lastSeenAt: String(r.last_seen_at),
      updatedAt: String(r.updated_at),
    };
  }

  // ---------------------------------------------------------------- insights

  stats() {
    const all = <T>(sql: string, ...p: SQLInputValue[]) =>
      this.db.prepare(sql).all(...p) as T[];
    return {
      totalLeads: Number(
        (this.db.prepare("SELECT COUNT(*) AS n FROM leads").get() as Row).n,
      ),
      byStatus: all<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM leads GROUP BY status",
      ),
      byCategory: all<{ category: string; n: number }>(
        "SELECT best_category AS category, COUNT(*) AS n FROM leads GROUP BY best_category",
      ),
      byPlatform: all<{ platform: string; n: number }>(
        "SELECT platform, COUNT(*) AS n FROM leads GROUP BY platform",
      ),
      /** Which competitor servers unhappy players talk about — content & positioning input. */
      topMentionedServers: all<{ server: string; n: number }>(
        `SELECT j.value AS server, COUNT(*) AS n FROM comments, json_each(comments.mentioned_servers) j
         GROUP BY lower(j.value) ORDER BY n DESC LIMIT 20`,
      ),
      /** What people complain about most — ready-made video topics. */
      topSignals: all<{ signal: string; n: number }>(
        `SELECT j.value AS signal, COUNT(*) AS n FROM comments, json_each(comments.matched_keywords) j
         GROUP BY j.value ORDER BY n DESC LIMIT 20`,
      ),
      /** Videos/channels whose audience produces the most leads — scan them more often. */
      topVideos: all<{
        videoId: string;
        videoUrl: string;
        title: string;
        channel: string;
        leads: number;
      }>(
        `SELECT video_id AS videoId, video_url AS videoUrl, video_title AS title, video_channel_title AS channel,
                COUNT(DISTINCT lead_id) AS leads
         FROM comments GROUP BY platform, video_id ORDER BY leads DESC LIMIT 20`,
      ),
      topChannels: all<{ channel: string; leads: number }>(
        `SELECT video_channel_title AS channel, COUNT(DISTINCT lead_id) AS leads FROM comments
         WHERE video_channel_title IS NOT NULL GROUP BY video_channel_title ORDER BY leads DESC LIMIT 20`,
      ),
      /**
       * Feedback loop: how leads found by each signal ended up after you worked them.
       * A signal with many "rejected" is noise for your niche — drop it or raise minScore.
       */
      signalQuality: all<{
        signal: string;
        leads: number;
        worked: number;
        rejected: number;
        positive: number;
      }>(
        `SELECT signal, COUNT(*) AS leads,
                SUM(status != 'new') AS worked,
                SUM(status = 'rejected') AS rejected,
                SUM(status IN ('contacted', 'subscribed', 'converted')) AS positive
         FROM (
           SELECT DISTINCT l.id, l.status,
                  CASE WHEN c.classifier = 'llm' AND j.value IS NULL THEN 'claude' ELSE j.value END AS signal
           FROM leads l JOIN comments c ON c.lead_id = l.id
           LEFT JOIN json_each(c.matched_keywords) j
         ) WHERE signal IS NOT NULL
         GROUP BY signal ORDER BY leads DESC LIMIT 40`,
      ),
      byCampaign: all<{
        campaignId: number;
        name: string;
        leads: number;
        positive: number;
      }>(
        `SELECT c.campaign_id AS campaignId, COALESCE(k.name, 'импорт') AS name,
                COUNT(DISTINCT c.lead_id) AS leads,
                COUNT(DISTINCT CASE WHEN l.status IN ('contacted','subscribed','converted') THEN l.id END) AS positive
         FROM comments c JOIN leads l ON l.id = c.lead_id LEFT JOIN campaigns k ON k.id = c.campaign_id
         GROUP BY c.campaign_id ORDER BY leads DESC`,
      ),
      videosScanned: Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM scanned_videos")
            .get() as Row
        ).n,
      ),
      commentsClassified: Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM seen_comments")
            .get() as Row
        ).n,
      ),
    };
  }
}
