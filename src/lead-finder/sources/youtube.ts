import type { RawComment } from "../types";

/**
 * Read-only client for the official YouTube Data API v3 (API key, no account login).
 *
 * Quota (default 10 000 units/day per Google Cloud project):
 *   search.list = 100 units, every other call used here = 1 unit.
 * Channel uploads are read via the uploads playlist (1 unit) instead of search (100 units).
 */
export const QUOTA_COST = {
  search: 100,
  list: 1,
} as const;

export interface YouTubeVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  commentCount?: number;
}

export interface SearchOptions {
  publishedAfter?: Date;
  relevanceLanguage?: string;
  regionCode?: string;
  maxResults?: number;
  order?: "date" | "relevance" | "viewCount";
}

export class QuotaExceededError extends Error {}

interface CommentSnippet {
  videoId: string;
  textOriginal?: string;
  textDisplay?: string;
  authorDisplayName: string;
  authorChannelUrl?: string;
  authorChannelId?: { value: string };
  likeCount?: number;
  publishedAt: string;
  parentId?: string;
}

interface CommentResource {
  id: string;
  snippet: CommentSnippet;
}

interface CommentThreadResource {
  id: string;
  snippet: { topLevelComment: CommentResource; totalReplyCount?: number };
  replies?: { comments: CommentResource[] };
}

export function parseVideoId(input: string): string {
  const trimmed = input.trim();
  const m =
    trimmed.match(/[?&]v=([\w-]{11})/) ||
    trimmed.match(/youtu\.be\/([\w-]{11})/) ||
    trimmed.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
  return m ? m[1] : trimmed;
}

/** "UC…", "@handle", "youtube.com/@handle", "youtube.com/channel/UC…" → id or handle. */
export function parseChannelRef(input: string): {
  id?: string;
  handle?: string;
} {
  const t = input.trim();
  const id = t.match(/(?:^|\/channel\/)(UC[\w-]{22})(?:$|[/?])/);
  if (id) return { id: id[1] };
  const handle = t.match(/(?:^|youtube\.com\/)(@[\w.\-]+)/);
  if (handle) return { handle: handle[1] };
  return { handle: t.startsWith("@") ? t : `@${t}` };
}

export class YouTubeClient {
  public quotaUsed = 0;

  constructor(
    private apiKey: string,
    private baseURL = "https://www.googleapis.com/youtube/v3",
    private timeoutMs = 20000,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, unknown>,
    cost: number,
  ): Promise<T> {
    const qs = new URLSearchParams({ key: this.apiKey });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    this.quotaUsed += cost; // Google charges for failed calls too.
    const res = await fetch(`${this.baseURL}${path}?${qs}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => ({}))) as {
      error?: { errors?: { reason?: string }[]; message?: string };
    };
    const reason = body.error?.errors?.[0]?.reason;
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      throw new QuotaExceededError("YouTube API daily quota exceeded");
    }
    const e = new Error(
      `YouTube API ${path} failed: ${res.status} ${reason ?? body.error?.message ?? res.statusText}`,
    );
    (e as Error & { reason?: string }).reason = reason;
    throw e;
  }

  async searchVideos(
    query: string,
    opts: SearchOptions = {},
  ): Promise<YouTubeVideo[]> {
    const data = await this.get<{
      items: {
        id: { videoId: string };
        snippet: {
          title: string;
          channelTitle: string;
          channelId: string;
          publishedAt: string;
        };
      }[];
    }>(
      "/search",
      {
        part: "snippet",
        type: "video",
        q: query,
        maxResults: opts.maxResults ?? 15,
        order: opts.order ?? "relevance",
        publishedAfter: opts.publishedAfter?.toISOString(),
        relevanceLanguage: opts.relevanceLanguage,
        regionCode: opts.regionCode,
      },
      QUOTA_COST.search,
    );
    return (data.items ?? []).map((i) => ({
      videoId: i.id.videoId,
      title: i.snippet.title,
      channelTitle: i.snippet.channelTitle,
      channelId: i.snippet.channelId,
      publishedAt: i.snippet.publishedAt,
    }));
  }

  /** Latest uploads of a channel via its uploads playlist (2 quota units instead of 100). */
  /**
   * Latest uploads of a channel. Accepts a channel ID (UC…), an @handle or a channel URL —
   * the handle is resolved by the same channels.list call, so it costs nothing extra.
   */
  async channelUploads(
    channel: string,
    maxResults = 15,
  ): Promise<YouTubeVideo[]> {
    const ref = parseChannelRef(channel);
    const ch = await this.get<{
      items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[];
    }>(
      "/channels",
      {
        part: "contentDetails",
        ...(ref.id ? { id: ref.id } : { forHandle: ref.handle }),
      },
      QUOTA_COST.list,
    );
    const uploads = ch.items?.[0]?.contentDetails.relatedPlaylists.uploads;
    if (!uploads) throw new Error(`channel not found: ${channel}`);
    const pl = await this.get<{
      items: {
        snippet: {
          title: string;
          channelTitle: string;
          channelId: string;
          publishedAt: string;
          resourceId: { videoId: string };
        };
      }[];
    }>(
      "/playlistItems",
      {
        part: "snippet",
        playlistId: uploads,
        maxResults: Math.min(50, maxResults),
      },
      QUOTA_COST.list,
    );
    return (pl.items ?? []).map((i) => ({
      videoId: i.snippet.resourceId.videoId,
      title: i.snippet.title,
      channelTitle: i.snippet.channelTitle,
      channelId: i.snippet.channelId,
      publishedAt: i.snippet.publishedAt,
    }));
  }

  async getVideos(videoIds: string[]): Promise<YouTubeVideo[]> {
    const out: YouTubeVideo[] = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const ids = videoIds.slice(i, i + 50);
      const data = await this.get<{
        items: {
          id: string;
          snippet: {
            title: string;
            channelTitle: string;
            channelId: string;
            publishedAt: string;
          };
          statistics?: { commentCount?: string };
        }[];
      }>(
        "/videos",
        { part: "snippet,statistics", id: ids.join(",") },
        QUOTA_COST.list,
      );
      for (const v of data.items ?? []) {
        out.push({
          videoId: v.id,
          title: v.snippet.title,
          channelTitle: v.snippet.channelTitle,
          channelId: v.snippet.channelId,
          publishedAt: v.snippet.publishedAt,
          commentCount: v.statistics?.commentCount
            ? Number(v.statistics.commentCount)
            : undefined,
        });
      }
    }
    return out;
  }

  /**
   * Reads comments newest-first and stops at `since` (incremental re-scan) or `limit`.
   * Includes up to 5 inline replies per thread — complaints often appear in reply chains.
   */
  async fetchComments(
    video: Pick<YouTubeVideo, "videoId" | "title" | "channelTitle">,
    opts: { since?: string | null; limit?: number } = {},
  ): Promise<RawComment[]> {
    const limit = opts.limit ?? 500;
    const since = opts.since ? Date.parse(opts.since) : 0;
    const out: RawComment[] = [];
    let pageToken: string | undefined;

    do {
      let data: { items?: CommentThreadResource[]; nextPageToken?: string };
      try {
        data = await this.get(
          "/commentThreads",
          {
            part: "snippet,replies",
            videoId: video.videoId,
            maxResults: 100,
            order: "time",
            textFormat: "plainText",
            pageToken,
          },
          QUOTA_COST.list,
        );
      } catch (error: unknown) {
        const reason = (error as { reason?: string }).reason;
        if (
          reason === "commentsDisabled" ||
          reason === "videoNotFound" ||
          reason === "forbidden"
        ) {
          return out;
        }
        throw error;
      }

      let reachedOld = false;
      for (const thread of data.items ?? []) {
        const top = thread.snippet.topLevelComment;
        if (since && Date.parse(top.snippet.publishedAt) <= since) {
          reachedOld = true;
          // Old thread, but it may have fresh replies.
        } else {
          out.push(this.toRaw(top, video));
        }
        for (const reply of thread.replies?.comments ?? []) {
          if (!since || Date.parse(reply.snippet.publishedAt) > since) {
            out.push(this.toRaw(reply, video));
          }
        }
        if (out.length >= limit) break;
      }
      pageToken = data.nextPageToken;
      if (reachedOld || out.length >= limit) break;
    } while (pageToken);

    return out.slice(0, limit);
  }

  private toRaw(
    c: CommentResource,
    video: Pick<YouTubeVideo, "videoId" | "title" | "channelTitle">,
  ): RawComment {
    const s = c.snippet;
    const authorId = s.authorChannelId?.value ?? s.authorDisplayName;
    const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    return {
      platform: "youtube",
      commentId: c.id,
      parentCommentId: s.parentId ?? null,
      videoId: video.videoId,
      videoUrl,
      videoTitle: video.title,
      videoChannelTitle: video.channelTitle,
      authorId,
      authorName: s.authorDisplayName,
      authorUrl:
        s.authorChannelUrl?.replace(/^http:/, "https:") ??
        `https://www.youtube.com/channel/${authorId}`,
      text: s.textOriginal ?? s.textDisplay ?? "",
      likeCount: s.likeCount ?? 0,
      publishedAt: s.publishedAt,
      commentUrl: `${videoUrl}&lc=${c.id}`,
    };
  }
}
