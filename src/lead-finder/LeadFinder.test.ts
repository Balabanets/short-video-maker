import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import nock from "nock";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LeadFinderConfig } from "./config";
import { LeadFinder } from "./LeadFinder";
import { LeadStore } from "./LeadStore";
import { createLeadFinderRouter } from "./router";
import { YouTubeClient } from "./sources/youtube";
import { campaignSchema } from "./types";
import type { Classification, RawComment } from "./types";
import type { LlmClassifier } from "./classifier/llm";

const API = "https://yt.test";

const config: LeadFinderConfig = {
  youtubeApiKey: "test",
  dbPath: ":memory:",
  llm: null,
  scanIntervalMinutes: 0,
  dailyQuotaBudget: 10000,
  minRescanMinutes: 0,
};

const thread = (id: string, author: string, text: string, publishedAt: string, replies: { id: string; author: string; text: string }[] = []) => ({
  id,
  snippet: {
    topLevelComment: {
      id,
      snippet: {
        videoId: "vid00000001",
        textOriginal: text,
        authorDisplayName: author,
        authorChannelUrl: `http://www.youtube.com/@${author}`,
        authorChannelId: { value: `UC_${author}` },
        likeCount: 3,
        publishedAt,
      },
    },
  },
  replies: replies.length
    ? {
        comments: replies.map((r) => ({
          id: r.id,
          snippet: {
            videoId: "vid00000001",
            textOriginal: r.text,
            authorDisplayName: r.author,
            authorChannelUrl: `http://www.youtube.com/@${r.author}`,
            authorChannelId: { value: `UC_${r.author}` },
            publishedAt,
            parentId: id,
          },
        })),
      }
    : undefined,
});

function mockYouTube(threads: unknown[]) {
  nock(API)
    .get("/search")
    .query(true)
    .reply(200, {
      items: [
        {
          id: { videoId: "vid00000001" },
          snippet: { title: "Обзор серверов", channelTitle: "GameChan", channelId: "UC1", publishedAt: "2026-11-01T00:00:00Z" },
        },
      ],
    });
  nock(API).get("/commentThreads").query(true).reply(200, { items: threads });
}

describe("LeadFinder", () => {
  let store: LeadStore;
  let finder: LeadFinder;

  beforeEach(() => {
    nock.disableNetConnect();
    store = new LeadStore(":memory:");
    finder = new LeadFinder(config, store, { youtube: new YouTubeClient("test", API), llm: null });
  });
  afterEach(() => {
    nock.cleanAll();
    store.close();
  });
  afterAll(() => nock.enableNetConnect());

  const campaign = () =>
    store.createCampaign(
      campaignSchema.parse({ name: "GTA RP", game: "GTA 5 RP", queries: ["сервера гта 5 рп"], competitorNames: ["Arizona"] }),
    );

  test("scans a campaign and stores only leads, with profile and comment links", async () => {
    const c = campaign();
    mockYouTube([
      thread("c1", "petya", "Посоветуйте сервер, на Arizona админы абузят", "2026-11-10T10:00:00Z", [
        { id: "c1.r1", author: "vasya", text: "тоже ищу сервер нормальный" },
      ]),
      thread("c2", "masha", "Классное видео!", "2026-11-10T09:00:00Z"),
    ]);

    const [report] = await finder.scanAll([c.id]);
    expect(report.errors).toEqual([]);
    expect(report.videosScanned).toBe(1);
    expect(report.commentsRead).toBe(3);
    expect(report.newLeads).toBe(2);
    expect(report.quotaUnitsUsed).toBe(101);

    const { total, items } = store.listLeads();
    expect(total).toBe(2);
    const petya = items.find((l) => l.authorName === "petya")!;
    expect(petya.authorUrl).toBe("https://www.youtube.com/@petya");
    expect(petya.comments[0].commentUrl).toBe("https://www.youtube.com/watch?v=vid00000001&lc=c1");
    expect(petya.comments[0].mentionedServers).toEqual(["Arizona"]);
    expect(petya.comments[0].videoTitle).toBe("Обзор серверов");
  });

  test("re-scan only reads newer comments and never duplicates leads", async () => {
    const c = campaign();
    mockYouTube([thread("c1", "petya", "ищу сервер, посоветуйте", "2026-11-10T10:00:00Z")]);
    await finder.scanAll([c.id]);

    mockYouTube([
      thread("c3", "petya", "ну что, никто не посоветует сервер?", "2026-11-11T10:00:00Z"),
      thread("c1", "petya", "ищу сервер, посоветуйте", "2026-11-10T10:00:00Z"),
    ]);
    const [report] = await finder.scanAll([c.id]);
    expect(report.commentsRead).toBe(1);
    expect(report.newLeads).toBe(0);

    const { items } = store.listLeads();
    expect(items).toHaveLength(1);
    expect(items[0].comments).toHaveLength(2);
  });

  test("stops at the daily quota budget", async () => {
    const tight = new LeadFinder({ ...config, dailyQuotaBudget: 50 }, store, { youtube: new YouTubeClient("test", API), llm: null });
    const c = campaign();
    const [report] = await tight.scanAll([c.id]);
    expect(report.errors.join()).toMatch(/quota/);
    expect(report.videosScanned).toBe(0);
  });

  test("LLM verdict overrides rules for prefiltered comments", async () => {
    const calls: RawComment[][] = [];
    const llm = {
      classify: async (comments: RawComment[]) => {
        calls.push(comments);
        return new Map<number, Classification>(
          comments.map((_, i) => [i, { category: "dissatisfied", score: 77, matchedKeywords: [], mentionedServers: ["Radmir"], reason: "жалуется", classifier: "llm" }]),
        );
      },
    } as unknown as LlmClassifier;
    const withLlm = new LeadFinder({ ...config, llm: { model: "x", prefilter: "signals" } }, store, { youtube: null, llm });

    const res = await withLlm.importComments([
      { platform: "tiktok", commentId: "t1", videoId: "v1", videoUrl: "https://www.tiktok.com/@a/video/1", authorId: "u1", authorName: "u1", authorUrl: "https://www.tiktok.com/@u1", text: "на радмире онлайн совсем упал" },
      { platform: "tiktok", commentId: "t2", videoId: "v1", videoUrl: "https://www.tiktok.com/@a/video/1", authorId: "u2", authorName: "u2", authorUrl: "https://www.tiktok.com/@u2", text: "смешной кот" },
    ]);
    expect(calls[0]).toHaveLength(1); // "смешной кот" never reaches the LLM
    expect(res.newLeads).toBe(1);
    const lead = store.listLeads().items[0];
    expect(lead.bestScore).toBe(77);
    expect(lead.comments[0].classifier).toBe("llm");

    // Same comments again: nothing re-classified.
    const again = await withLlm.importComments([
      { platform: "tiktok", commentId: "t1", videoId: "v1", videoUrl: "https://www.tiktok.com/@a/video/1", authorId: "u1", authorName: "u1", authorUrl: "https://www.tiktok.com/@u1", text: "на радмире онлайн совсем упал" },
    ]);
    expect(again.classified).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("lead finder REST API", () => {
  let server: http.Server;
  let base: string;
  let store: LeadStore;

  beforeEach(async () => {
    store = new LeadStore(":memory:");
    const finder = new LeadFinder({ ...config, youtubeApiKey: undefined, apiToken: "secret" }, store, { youtube: null, llm: null });
    const app = express();
    app.use("/api/leads", createLeadFinderRouter(finder));
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/leads`;
  });
  afterEach(() => {
    server.close();
    store.close();
  });

  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: "Bearer secret", ...(init.headers ?? {}) },
    });

  test("requires the token", async () => {
    const res = await fetch(base + "/status");
    expect(res.status).toBe(401);
  });

  test("campaign CRUD, import, list, patch, stats, csv, delete", async () => {
    const created = await call("/campaigns", { method: "POST", body: JSON.stringify({ name: "MC", game: "Minecraft", queries: ["лучший сервер майнкрафт"] }) });
    expect(created.status).toBe(201);
    expect((await created.json()).minScore).toBe(40);

    const bad = await call("/campaigns", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(bad.status).toBe(400);

    const imp = await call("/import", {
      method: "POST",
      body: JSON.stringify({
        comments: [
          { commentId: "t1", videoId: "v1", videoUrl: "https://www.tiktok.com/@a/video/1", authorId: "u1", authorName: "=HYPERLINK()", authorUrl: "https://www.tiktok.com/@u1", text: "посоветуйте сервер майнкрафт с друзьями" },
        ],
      }),
    });
    expect(await imp.json()).toMatchObject({ classified: 1, newLeads: 1 });

    const list = await (await call("/?status=new&minScore=40")).json();
    expect(list.total).toBe(1);
    const id = list.items[0].id;

    const patched = await (await call(`/${id}`, { method: "PATCH", body: JSON.stringify({ status: "contacted", notes: "написал в ЛС" }) })).json();
    expect(patched.status).toBe("contacted");

    const stats = await (await call("/stats")).json();
    expect(stats.byStatus).toEqual([{ status: "contacted", n: 1 }]);

    const csv = await (await call("/export.csv")).text();
    expect(csv).toContain("'=HYPERLINK()"); // formula injection neutralised
    expect(csv).toContain("посоветуйте сервер майнкрафт");

    expect((await call(`/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/${id}`)).status).toBe(404);
  });
});
