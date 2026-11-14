import nock from "nock";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { LeadFinder } from "../LeadFinder";
import { LeadStore } from "../LeadStore";
import type { LeadFinderConfig } from "../config";
import { campaignSchema } from "../types";
import { DiscordClient, dateFromSnowflake, snowflakeFromDate } from "./discord";

const API = "https://discord.test";
const GUILD = "111111111111111111";
const GENERAL = "222222222222222222";
const RULES = "333333333333333333";
const FORUM = "444444444444444444";
const FORUM_POST = "555555555555555555";
const STAFF = "666666666666666666";

const config: LeadFinderConfig = {
  dbPath: ":memory:",
  llm: null,
  scanIntervalMinutes: 0,
  dailyQuotaBudget: 10000,
  minRescanMinutes: 0,
};

let seq = 0;
const msg = (
  author: { id: string; name: string; bot?: boolean },
  content: string,
  extra: Record<string, unknown> = {},
) => {
  const ts = new Date(Date.now() - 3600_000 + seq++ * 1000);
  return {
    id: (BigInt(snowflakeFromDate(ts)) + BigInt(seq)).toString(),
    type: 0,
    content,
    timestamp: ts.toISOString(),
    channel_id: GENERAL,
    author: {
      id: author.id,
      username: author.name,
      global_name: author.name,
      bot: author.bot,
    },
    ...extra,
  };
};

function mockGuild() {
  nock(API)
    .get(`/guilds/${GUILD}`)
    .reply(200, { id: GUILD, name: "Семья Corleone" });
  nock(API)
    .get(`/guilds/${GUILD}/channels`)
    .reply(200, [
      { id: GENERAL, type: 0, name: "общение" },
      { id: RULES, type: 0, name: "правила" },
      { id: FORUM, type: 15, name: "поиск-сервера" },
      { id: STAFF, type: 0, name: "staff" },
      { id: "777777777777777777", type: 2, name: "voice" },
    ]);
  nock(API)
    .get(`/guilds/${GUILD}/threads/active`)
    .reply(200, {
      threads: [
        { id: FORUM_POST, type: 11, name: "куда идти?", parent_id: FORUM },
      ],
    });
}

describe("Discord source", () => {
  let store: LeadStore;
  let finder: LeadFinder;

  beforeEach(() => {
    nock.disableNetConnect();
    store = new LeadStore(":memory:");
    finder = new LeadFinder(config, store, {
      youtube: null,
      llm: null,
      discord: new DiscordClient("token", API),
    });
  });
  afterEach(() => {
    nock.cleanAll();
    store.close();
  });
  afterAll(() => nock.enableNetConnect());

  test("snowflake helpers round-trip to the millisecond", () => {
    const d = "2026-11-14T10:00:00.123Z";
    expect(dateFromSnowflake(snowflakeFromDate(d))).toBe(d);
  });

  test("scans a guild: text channels + forum posts, skips bots, excluded and forbidden channels", async () => {
    mockGuild();
    const petya = { id: "900000000000000001", name: "petya" };
    nock(API)
      .get(`/channels/${GENERAL}/messages`)
      .query(true)
      .reply(200, [
        msg(petya, "на majestic админы беспредел, посоветуйте сервер"),
        msg(
          { id: "900000000000000009", name: "MEE6", bot: true },
          "посоветуйте сервер (бот)",
        ),
        msg({ id: "900000000000000002", name: "kolya" }, "го в 8 на дело"),
      ]);
    nock(API)
      .get(`/channels/${FORUM_POST}/messages`)
      .query(true)
      .reply(200, [
        msg(
          { id: "900000000000000003", name: "sveta" },
          "ищу сервер с живым онлайном, где норм рп?",
        ),
      ]);
    nock(API)
      .get(`/channels/${STAFF}/messages`)
      .query(true)
      .reply(403, { message: "Missing Access", code: 50001 });

    const c = store.createCampaign(
      campaignSchema.parse({
        name: "Discord partners",
        game: "GTA 5 RP",
        discordGuildIds: [GUILD],
        discordExcludeChannelIds: [RULES],
        competitorNames: ["Majestic"],
      }),
    );
    const [report] = await finder.scanAll([c.id]);

    expect(report.errors).toEqual([]);
    expect(report.discordChannelsScanned).toBe(3); // general, forum post, staff (403 → empty)
    expect(report.commentsRead).toBe(3); // bot message dropped
    expect(report.newLeads).toBe(2);

    const leads = store.listLeads({ platform: "discord" }).items;
    const p = leads.find((l) => l.authorName === "petya")!;
    expect(p.authorUrl).toBe(`https://discord.com/users/${petya.id}`);
    expect(p.comments[0].commentUrl).toMatch(
      new RegExp(`^https://discord.com/channels/${GUILD}/${GENERAL}/\\d+$`),
    );
    expect(p.comments[0].videoTitle).toBe("#общение — Семья Corleone");
    expect(p.comments[0].mentionedServers).toEqual(["Majestic"]);
    expect(leads.find((l) => l.authorName === "sveta")!.bestCategory).toBe(
      "seeking",
    );
  });

  test("next scan continues after the last read message and survives a rate limit", async () => {
    const c = store.createCampaign(
      campaignSchema.parse({
        name: "one channel",
        game: "Minecraft",
        discordChannelIds: [GENERAL],
      }),
    );
    nock(API)
      .get(`/channels/${GENERAL}`)
      .reply(200, { id: GENERAL, type: 0, name: "общение", guild_id: GUILD });
    nock(API).get(`/guilds/${GUILD}`).reply(200, { id: GUILD, name: "MC" });
    const first = msg(
      { id: "900000000000000004", name: "dima" },
      "ищу сервер майнкрафт без доната",
    );
    nock(API)
      .get(`/channels/${GENERAL}/messages`)
      .query(true)
      .reply(200, [first]);
    await finder.scanAll([c.id]);

    const state = store.getVideoScanState("discord", GENERAL)!;
    expect(state.newestCommentAt).toBe(first.timestamp);

    nock(API)
      .get(`/channels/${GENERAL}`)
      .reply(200, { id: GENERAL, type: 0, name: "общение", guild_id: GUILD });
    let afterParam = "";
    nock(API)
      .get(`/channels/${GENERAL}/messages`)
      .query(true)
      .reply(429, {
        message: "You are being rate limited.",
        retry_after: 0.01,
      });
    nock(API)
      .get(`/channels/${GENERAL}/messages`)
      .query((q) => {
        afterParam = String(q.after);
        return true;
      })
      .reply(200, [
        first,
        msg(
          { id: "900000000000000005", name: "olya" },
          "как зайти на сервер? хочу начать играть",
        ),
      ]);

    const [report] = await finder.scanAll([c.id]);
    expect(report.errors).toEqual([]);
    expect(BigInt(afterParam)).toBeLessThanOrEqual(BigInt(first.id));
    expect(report.newLeads).toBe(1); // the repeated first message is not classified twice
    expect(store.listLeads().total).toBe(2);
  });

  test("reports a clear error when no bot token is configured", async () => {
    const noBot = new LeadFinder(config, store, {
      youtube: null,
      llm: null,
      discord: null,
    });
    const c = store.createCampaign(
      campaignSchema.parse({ name: "x", game: "x", discordGuildIds: [GUILD] }),
    );
    const [report] = await noBot.scanAll([c.id]);
    expect(report.errors).toEqual([
      "discord: DISCORD_BOT_TOKEN is not configured",
    ]);
  });
});
