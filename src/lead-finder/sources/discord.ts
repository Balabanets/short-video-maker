import type { RawComment } from "../types";

/**
 * Read-only Discord source built on the official Bot API (REST, bot token).
 *
 * The bot only sees servers it was invited to by their admins (your own server,
 * partner / clan / streamer communities that agreed). It never logs in as a user
 * account and never writes anything. Reading message text needs the privileged
 * "Message Content Intent" switched on in the Developer Portal → Bot.
 *
 * Required bot permissions: View Channels + Read Message History (= 66560).
 */
export const DISCORD_READ_PERMISSIONS = 1024 + 65536;
const DISCORD_EPOCH = 1420070400000n;

/** Text-like channel types whose messages we read. */
const TEXT_CHANNEL_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT
const THREAD_TYPES = new Set([10, 11, 12]); // announcement / public / private thread
const FORUM_TYPES = new Set([15, 16]); // GUILD_FORUM, GUILD_MEDIA (posts are threads)
/** Message types that carry user-written text: DEFAULT, REPLY, THREAD_STARTER_MESSAGE. */
const USER_MESSAGE_TYPES = new Set([0, 19, 21]);

export interface DiscordChannel {
  id: string;
  guildId: string;
  guildName: string;
  name: string;
  type: number;
  parentId?: string | null;
}

interface ApiChannel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  guild_id?: string;
}

interface ApiMessage {
  id: string;
  type: number;
  content: string;
  timestamp: string;
  channel_id: string;
  webhook_id?: string;
  author: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
    system?: boolean;
  };
  message_reference?: { message_id?: string };
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}

export function snowflakeFromDate(date: Date | string): string {
  const ms = BigInt(new Date(date).getTime());
  return ((ms - DISCORD_EPOCH) << 22n).toString();
}

export function dateFromSnowflake(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DiscordClient {
  private guildNames = new Map<string, string>();

  constructor(
    private token: string,
    private baseURL = "https://discord.com/api/v10",
    private timeoutMs = 20000,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined) qs.set(k, String(v));
    const url = `${this.baseURL}${path}${qs.size ? `?${qs}` : ""}`;

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bot ${this.token}`,
          "User-Agent": "DiscordBot (lead-finder, 1.0)",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;

      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        code?: number;
        retry_after?: number;
      };
      // Respect Discord rate limits instead of hammering the API.
      if (res.status === 429 && attempt < 3) {
        await sleep(Math.ceil((body.retry_after ?? 1) * 1000) + 100);
        continue;
      }
      throw new DiscordApiError(
        `Discord API ${path} failed: ${res.status} ${body.message ?? res.statusText}`,
        res.status,
        body.code,
      );
    }
  }

  async application(): Promise<{ id: string; name: string }> {
    return this.get("/oauth2/applications/@me");
  }

  inviteUrl(applicationId: string): string {
    return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${DISCORD_READ_PERMISSIONS}`;
  }

  async listGuilds(): Promise<{ id: string; name: string }[]> {
    const guilds = await this.get<{ id: string; name: string }[]>(
      "/users/@me/guilds",
      { limit: 200 },
    );
    guilds.forEach((g) => this.guildNames.set(g.id, g.name));
    return guilds.map((g) => ({ id: g.id, name: g.name }));
  }

  private async guildName(guildId: string): Promise<string> {
    if (!this.guildNames.has(guildId)) {
      const g = await this.get<{ name: string }>(`/guilds/${guildId}`);
      this.guildNames.set(guildId, g.name);
    }
    return this.guildNames.get(guildId)!;
  }

  /**
   * Readable text channels + active threads (incl. forum posts) of a server.
   * Channels the bot has no access to are filtered later by a 403 on read.
   */
  async listReadableChannels(
    guildId: string,
    exclude: string[] = [],
  ): Promise<DiscordChannel[]> {
    const guildName = await this.guildName(guildId);
    const channels = await this.get<ApiChannel[]>(
      `/guilds/${guildId}/channels`,
    );
    const out: DiscordChannel[] = channels
      .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
      .map((c) => ({
        id: c.id,
        guildId,
        guildName,
        name: c.name ?? c.id,
        type: c.type,
        parentId: c.parent_id,
      }));

    const forumIds = new Set(
      channels.filter((c) => FORUM_TYPES.has(c.type)).map((c) => c.id),
    );
    const textIds = new Set(out.map((c) => c.id));
    try {
      const { threads } = await this.get<{ threads: ApiChannel[] }>(
        `/guilds/${guildId}/threads/active`,
      );
      for (const t of threads) {
        if (!THREAD_TYPES.has(t.type)) continue;
        if (
          t.parent_id &&
          (forumIds.has(t.parent_id) || textIds.has(t.parent_id))
        ) {
          out.push({
            id: t.id,
            guildId,
            guildName,
            name: t.name ?? t.id,
            type: t.type,
            parentId: t.parent_id,
          });
        }
      }
    } catch {
      // Active-thread listing can be forbidden; plain channels are still useful.
    }
    const ex = new Set(exclude);
    return out.filter(
      (c) => !ex.has(c.id) && !(c.parentId && ex.has(c.parentId)),
    );
  }

  async getChannel(channelId: string): Promise<DiscordChannel> {
    const c = await this.get<ApiChannel>(`/channels/${channelId}`);
    const guildId = c.guild_id ?? "";
    return {
      id: c.id,
      guildId,
      guildName: guildId ? await this.guildName(guildId) : "",
      name: c.name ?? c.id,
      type: c.type,
      parentId: c.parent_id,
    };
  }

  /**
   * Reads messages oldest → newest starting after `since` (ISO date), up to `limit`.
   * Next scan continues from the newest message read, so a long backlog is consumed
   * over several scans without gaps. Returns [] for channels the bot can't read.
   */
  async fetchMessages(
    channel: DiscordChannel,
    opts: { since: string; limit: number },
  ): Promise<{ messages: RawComment[]; cursorAt: string | null }> {
    const out: RawComment[] = [];
    let cursorAt: string | null = null;
    let after = snowflakeFromDate(opts.since);
    const channelUrl = `https://discord.com/channels/${channel.guildId}/${channel.id}`;
    const title = `#${channel.name}${channel.guildName ? ` — ${channel.guildName}` : ""}`;

    while (out.length < opts.limit) {
      let batch: ApiMessage[];
      try {
        batch = await this.get<ApiMessage[]>(
          `/channels/${channel.id}/messages`,
          { after, limit: 100 },
        );
      } catch (e) {
        // 50001 Missing Access, 50013 Missing Permissions — not our channel to read.
        if (
          e instanceof DiscordApiError &&
          (e.status === 403 || e.status === 404)
        ) {
          return { messages: out, cursorAt };
        }
        throw e;
      }
      if (batch.length === 0) break;
      batch.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      after = batch[batch.length - 1].id;
      // Cursor advances past bot/system messages too, so they are not re-read.
      cursorAt = dateFromSnowflake(after);

      for (const m of batch) {
        if (m.author.bot || m.author.system || m.webhook_id) continue;
        if (!USER_MESSAGE_TYPES.has(m.type) || !m.content.trim()) continue;
        out.push({
          platform: "discord",
          commentId: m.id,
          parentCommentId: m.message_reference?.message_id ?? null,
          videoId: channel.id,
          videoUrl: channelUrl,
          videoTitle: title,
          videoChannelTitle: channel.guildName || null,
          authorId: m.author.id,
          authorName: m.author.global_name || m.author.username,
          authorUrl: `https://discord.com/users/${m.author.id}`,
          text: m.content,
          likeCount: 0,
          publishedAt: m.timestamp,
          commentUrl: `${channelUrl}/${m.id}`,
        });
      }
      if (batch.length < 100) break;
    }
    return { messages: out, cursorAt };
  }
}
