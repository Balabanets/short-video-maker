import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import nock from "nock";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import type { LeadFinderConfig } from "./config";
import { LeadFinder } from "./LeadFinder";
import { LeadStore } from "./LeadStore";
import { TelegramNotifier } from "./notifier";
import { createLeadFinderRouter } from "./router";
import { YouTubeClient } from "./sources/youtube";
import { campaignSchema } from "./types";

const YT = "https://yt.test";
const TG = "https://tg.test";

const config: LeadFinderConfig = {
  youtubeApiKey: "k",
  dbPath: ":memory:",
  llm: null,
  scanIntervalMinutes: 0,
  dailyQuotaBudget: 10000,
  minRescanMinutes: 0,
};

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString();
const thread = (
  id: string,
  author: string,
  text: string,
  publishedAt: string,
) => ({
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
        publishedAt,
      },
    },
  },
});

function mockScan(threads: unknown[]) {
  nock(YT)
    .get("/videos")
    .query(true)
    .reply(200, {
      items: [
        {
          id: "vid00000001",
          snippet: {
            title: "Топ серверов",
            channelTitle: "Chan",
            channelId: "UC1",
            publishedAt: daysAgo(400),
          },
        },
      ],
    });
  nock(YT).get("/commentThreads").query(true).reply(200, { items: threads });
}

describe("lead finder features", () => {
  let store: LeadStore;

  beforeEach(() => {
    nock.disableNetConnect();
    nock.enableNetConnect("127.0.0.1");
    store = new LeadStore(":memory:");
  });
  afterEach(() => {
    nock.cleanAll();
    store.close();
  });
  afterAll(() => nock.enableNetConnect());

  const campaign = (extra: Record<string, unknown> = {}) =>
    store.createCampaign(
      campaignSchema.parse({
        name: "Старое видео",
        game: "GTA 5 RP",
        videoIds: ["vid00000001"],
        ...extra,
      }),
    );

  test("comments older than maxCommentAgeDays are not leads, even on an evergreen video", async () => {
    const finder = new LeadFinder(config, store, {
      youtube: new YouTubeClient("k", YT),
      llm: null,
      notifier: null,
    });
    const c = campaign({ maxCommentAgeDays: 30 });
    mockScan([
      thread(
        "new1",
        "fresh",
        "посоветуйте сервер, где норм онлайн?",
        daysAgo(2),
      ),
      thread("old1", "stale", "ищу сервер, посоветуйте", daysAgo(300)),
    ]);
    const [report] = await finder.scanAll([c.id]);
    expect(report.commentsRead).toBe(1);
    expect(store.listLeads().items.map((l) => l.authorName)).toEqual(["fresh"]);
  });

  test("YouTube quota usage survives a restart", async () => {
    const c = campaign();
    mockScan([]);
    await new LeadFinder(config, store, {
      youtube: new YouTubeClient("k", YT),
      llm: null,
      notifier: null,
    }).scanAll([c.id]);
    const restarted = new LeadFinder(config, store, {
      youtube: null,
      llm: null,
      notifier: null,
    });
    expect(restarted.status().quota.used).toBe(2); // videos.list + commentThreads.list
  });

  test("sends one Telegram message with hot leads only", async () => {
    const notifier = new TelegramNotifier("T", "42", 70, TG);
    const finder = new LeadFinder(config, store, {
      youtube: new YouTubeClient("k", YT),
      llm: null,
      notifier,
    });
    const c = campaign();
    mockScan([
      thread(
        "h1",
        "hot",
        "Посоветуйте сервер, на Majestic админы абузят",
        daysAgo(1),
      ),
      thread("w1", "warm", "хочу в рп, но не знаю", daysAgo(1)),
      thread("n1", "noise", "классное видео", daysAgo(1)),
    ]);
    let sent: { chat_id: string; text: string; parse_mode: string } | null =
      null;
    nock(TG)
      .post("/botT/sendMessage", (body) => {
        sent = body;
        return true;
      })
      .reply(200, { ok: true });

    const [report] = await finder.scanAll([c.id]);
    expect(report.newLeads).toBe(2);
    expect(sent).not.toBeNull();
    expect(sent!.chat_id).toBe("42");
    expect(sent!.parse_mode).toBe("HTML");
    expect(sent!.text).toContain("новых горячих лидов — 1");
    expect(sent!.text).toContain("https://www.youtube.com/@hot");
    expect(sent!.text).not.toContain("warm");
  });

  test("a Telegram failure never breaks the scan", async () => {
    const notifier = new TelegramNotifier("T", "42", 10, TG);
    const finder = new LeadFinder(config, store, {
      youtube: new YouTubeClient("k", YT),
      llm: null,
      notifier,
    });
    const c = campaign();
    mockScan([
      thread("h1", "hot", "Посоветуйте сервер пожалуйста", daysAgo(1)),
    ]);
    nock(TG)
      .post("/botT/sendMessage")
      .reply(400, { ok: false, description: "chat not found" });
    const [report] = await finder.scanAll([c.id]);
    expect(report.newLeads).toBe(1);
    expect(report.errors).toEqual([]);
  });

  test("HTML in comments is escaped in notifications", () => {
    const n = new TelegramNotifier("T", "1", 0, TG);
    const text = n.format("x", [
      {
        leadId: 1,
        comment: {
          platform: "youtube",
          commentId: "c",
          videoId: "v",
          videoUrl: "https://y/v",
          authorId: "a",
          authorName: "<b>hacker</b>",
          authorUrl: "https://y/a",
          text: "ищу сервер <script>",
          publishedAt: daysAgo(0),
        },
        verdict: {
          category: "seeking",
          score: 90,
          matchedKeywords: [],
          mentionedServers: [],
          reason: "",
          classifier: "rules",
        },
      },
    ])!;
    expect(text).toContain("&lt;b&gt;hacker&lt;/b&gt;");
    expect(text).toContain("&lt;script&gt;");
  });

  test("signal quality shows which signals end up rejected", async () => {
    const finder = new LeadFinder(config, store, {
      youtube: null,
      llm: null,
      notifier: null,
    });
    await finder.importComments([
      {
        commentId: "a",
        videoId: "v",
        videoUrl: "https://t/v",
        authorId: "1",
        authorName: "a",
        authorUrl: "https://t/1",
        text: "посоветуйте сервер пожалуйста",
      },
      {
        commentId: "b",
        videoId: "v",
        videoUrl: "https://t/v",
        authorId: "2",
        authorName: "b",
        authorUrl: "https://t/2",
        text: "подскажите сервер с онлайном",
      },
    ]);
    const [a, b] = store.listLeads().items;
    store.updateLead(a.id, { status: "rejected" });
    store.updateLead(b.id, { status: "contacted" });
    const q = store
      .stats()
      .signalQuality.find((s) => s.signal === "посоветуйте сервер")!;
    expect(q).toMatchObject({ leads: 2, worked: 2, rejected: 1, positive: 1 });
  });

  test("CORS for a panel on another origin", async () => {
    const finder = new LeadFinder(
      { ...config, corsOrigin: "https://panel.example" },
      store,
      {
        youtube: null,
        llm: null,
        notifier: null,
      },
    );
    const app = express();
    app.use("/api/leads", createLeadFinderRouter(finder));
    const server: http.Server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/leads`;
    try {
      const pre = await fetch(`${base}/status`, { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(
        "https://panel.example",
      );
      const res = await fetch(`${base}/status`);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://panel.example",
      );
    } finally {
      server.close();
    }
  });
});
