import { describe, expect, test } from "vitest";
import {
  classifyByRules,
  findMentionedServers,
  passesLlmPrefilter,
} from "./rules";
import { EVAL_CORPUS, HOLDOUT_CORPUS } from "./eval-corpus";
import { parseChannelRef } from "../sources/youtube";

describe("classifyByRules", () => {
  test.each([
    ["Посоветуйте нормальный сервер, на Arizona уже надоело", "seeking"],
    ["ищу сервер где адекватная администрация", "seeking"],
    ["Куда перейти после вайпа? Все друзья ушли", "seeking"],
    ["админы абузят и банят без причины, ухожу с сервера", "dissatisfied"],
    ["Сервер умер, онлайн ноль, раньше было лучше", "dissatisfied"],
    ["донат решает всё, полный пей ту вин", "dissatisfied"],
    ["Хочу начать играть в рп, как зайти на сервер?", "newcomer"],
    ["looking for a good server, any recommendations?", "seeking"],
  ])("%s → %s", (text, category) => {
    const res = classifyByRules(text);
    expect(res.category).toBe(category);
    expect(res.score).toBeGreaterThanOrEqual(40);
  });

  test.each([
    "Классное видео, лайк!",
    "ахахах",
    "Заходи на мой сервер, промокод BONUS даёт 100к https://discord.gg/xxx",
    "Подпишись на мой канал, ищу сервер тоже",
  ])("not a lead: %s", (text) => {
    expect(classifyByRules(text).category).toBe("irrelevant");
  });

  test("skips players already on our server unless they are leaving", () => {
    const opts = { ownServerName: "Nova RP" };
    expect(
      classifyByRules("на Nova RP админы абузят, ужас", opts).category,
    ).toBe("irrelevant");
    expect(
      classifyByRules("ушел с Nova RP, админы абузят, посоветуйте сервер", opts)
        .category,
    ).not.toBe("irrelevant");
  });

  test("detects competitor mentions and boosts complaints naming them", () => {
    const opts = { competitorNames: ["Arizona", "Radmir"] };
    const res = classifyByRules("На Arizona лаги постоянно, сервер умер", opts);
    expect(res.mentionedServers).toEqual(["Arizona"]);
    expect(res.category).toBe("dissatisfied");
  });

  test("extra keywords from the campaign count as signals", () => {
    const res = classifyByRules("кто знает где есть ролевка с экономикой", {
      extraKeywords: ["ролевка с экономикой"],
    });
    expect(res.category).toBe("seeking");
  });

  test("competitor match is whole-word", () => {
    expect(findMentionedServers("играю на arizonarp", ["Arizona"])).toEqual([]);
    expect(findMentionedServers("играю на Arizona!", ["Arizona"])).toEqual([
      "Arizona",
    ]);
  });
});

describe("eval corpora", () => {
  for (const [name, set] of [
    ["train", EVAL_CORPUS],
    ["holdout", HOLDOUT_CORPUS],
  ] as const) {
    test(`${name}: no false positives, every lead reaches the LLM prefilter`, () => {
      const falsePositives: string[] = [];
      const prefilterMisses: string[] = [];
      let found = 0;
      let leads = 0;
      for (const s of set) {
        const r = classifyByRules(s.text);
        const predicted = r.category !== "irrelevant" && r.score >= 40;
        if (s.lead) {
          leads++;
          if (predicted) found++;
          if (!passesLlmPrefilter(s.text, r)) prefilterMisses.push(s.text);
        } else if (predicted) {
          falsePositives.push(s.text);
        }
      }
      expect(falsePositives).toEqual([]);
      expect(prefilterMisses).toEqual([]);
      expect(found / leads).toBeGreaterThanOrEqual(0.9);
    });
  }
});

test("channel refs: id, handle, urls", () => {
  expect(parseChannelRef("UC1234567890123456789012")).toEqual({
    id: "UC1234567890123456789012",
  });
  expect(
    parseChannelRef(
      "https://www.youtube.com/channel/UC1234567890123456789012/videos",
    ),
  ).toEqual({
    id: "UC1234567890123456789012",
  });
  expect(parseChannelRef("https://www.youtube.com/@GtaRpNews/videos")).toEqual({
    handle: "@GtaRpNews",
  });
  expect(parseChannelRef("@gta.rp-news")).toEqual({ handle: "@gta.rp-news" });
  expect(parseChannelRef("GtaRpNews")).toEqual({ handle: "@GtaRpNews" });
});
