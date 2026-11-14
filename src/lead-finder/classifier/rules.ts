import type { Classification, LeadCategory } from "../types";

/**
 * Fast, free, offline scorer. It is the first pass for every comment:
 * - when no LLM is configured, its verdict is final;
 * - when an LLM is configured, only comments that pass `prefilterScore` are sent to it.
 *
 * Patterns are lower-case regex fragments matched against normalised text (ё → е).
 */
interface Rule {
  category: Exclude<LeadCategory, "irrelevant">;
  weight: number;
  label: string;
  pattern: RegExp;
}

const r = (
  category: Rule["category"],
  weight: number,
  label: string,
  pattern: string,
): Rule => ({ category, weight, label, pattern: new RegExp(pattern, "i") });

export const RULES: Rule[] = [
  // ---- seeking: actively looking for a server (strongest signal)
  r(
    "seeking",
    60,
    "ищу сервер",
    "ищу (норм\\S* |хорош\\S* |нов\\S* |годн\\S* )?сервер",
  ),
  r(
    "seeking",
    60,
    "посоветуйте сервер",
    "(посовету\\S*|подскаж\\S*|порекоменду\\S*).{0,25}сервер",
  ),
  r(
    "seeking",
    55,
    "какой сервер выбрать",
    "(какой|на каком|какой лучше).{0,20}сервер",
  ),
  r(
    "seeking",
    50,
    "куда перейти",
    "(куда|на какой).{0,15}(перейти|уйти|свалить|переехать)",
  ),
  r("seeking", 45, "во что поиграть", "во что (бы )?поиграть"),
  r(
    "seeking",
    40,
    "есть норм сервера",
    "есть (ли )?(норм|нормальн|хорош|живые)\\S* сервер",
  ),
  r(
    "seeking",
    55,
    "looking for a server",
    "(looking for|recommend|suggest).{0,20}server",
  ),
  r("seeking", 45, "which server", "(which|what|best) server"),

  // ---- dissatisfied: complains about the server they play on now
  r(
    "dissatisfied",
    45,
    "ушел с сервера",
    "(ушел|ухожу|уйду|ливнул|ливаю|бросил|бросаю).{0,25}(сервер|проект|оттуда)",
  ),
  r(
    "dissatisfied",
    40,
    "сервер умер",
    "сервер (умер|мертв|сдох|помер|загнулся|пустой)",
  ),
  r(
    "dissatisfied",
    35,
    "мертвый онлайн",
    "(онлайн|онлаин|народу).{0,15}(мертв|ноль|нет|упал|никак)",
  ),
  r(
    "dissatisfied",
    35,
    "админы",
    "админ\\S*.{0,30}(абуз|беспредел|неадекват|банят|оборзел|ужас|клоун|дураки|не отвечают)",
  ),
  r(
    "dissatisfied",
    30,
    "бан ни за что",
    "(забанили|бан|банят).{0,25}(ни за что|просто так|без причины)",
  ),
  r(
    "dissatisfied",
    40,
    "донат",
    "(донат|donate|пей ту вин|pay to win|p2w).{0,30}(помойк|грабеж|дорог|решает|ужас|бред|развод|выкачивают)",
  ),
  r(
    "dissatisfied",
    30,
    "вайп",
    "(вайп|wipe).{0,25}(опять|снова|каждый|достал|потерял)",
  ),
  r(
    "dissatisfied",
    30,
    "лаги",
    "(лаги|лагает|фризы|тормозит|краши|вылетает|пинг).{0,25}(сервер|постоянно|ужас|невозможно|всегда)?",
  ),
  r(
    "dissatisfied",
    25,
    "читеры",
    "(читер\\S*|читаки|cheater\\S*|hacker\\S*).{0,25}(везде|полно|куча|никто не банит|full|every)",
  ),
  r(
    "dissatisfied",
    35,
    "разочаровался",
    "(разочаровал\\S*|надоел\\S* сервер|сервер (отстой|говно|помойка|дно|скатился))",
  ),
  r(
    "dissatisfied",
    30,
    "раньше было лучше",
    "раньше (было|сервер был) (лучше|норм|живее)",
  ),
  r(
    "dissatisfied",
    40,
    "left the server",
    "(quit|left|leaving).{0,20}(the )?server",
  ),
  r(
    "dissatisfied",
    30,
    "server is dead",
    "server (is )?(dead|died|empty|trash|garbage)",
  ),

  // ---- newcomer: wants to start
  r(
    "newcomer",
    40,
    "хочу начать играть",
    "(хочу|хотел бы|думаю|собираюсь).{0,15}(начать|поиграть|зайти|попробовать)",
  ),
  r(
    "newcomer",
    35,
    "как зайти",
    "как (зайти|начать|подключиться|скачать|установить|играть)",
  ),
  r("newcomer", 30, "новичок", "(новичок|нуб|впервые|первый раз|только начал)"),
  r(
    "newcomer",
    35,
    "how to join",
    "(how (do i|to) (join|start|play|download))|(new player|just started)",
  ),
];

/** Comments that look like ads / self-promo from other servers or bots — never leads. */
const SPAM_PATTERNS: RegExp[] = [
  /(https?:\/\/|discord\.gg|t\.me\/|www\.)/i,
  /промокод|промо-код|promo ?code/i,
  /(заходи|залетай|приходи|join|присоединяйся).{0,20}(на )?(мой|наш) (сервер|проект|канал)/i,
  /подпишись на (мой|наш)|subscribe to my/i,
  /(бесплатн\S*|free).{0,10}(донат|robux|v-?bucks|голд|gold)/i,
];

export function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

export function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some((p) => p.test(text));
}

export interface RuleOptions {
  extraKeywords?: string[];
  competitorNames?: string[];
  ownServerName?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMentionedServers(
  text: string,
  competitorNames: string[] = [],
): string[] {
  const t = normalize(text);
  return competitorNames.filter((name) =>
    new RegExp(
      `(^|[^\\p{L}\\d])${escapeRegExp(normalize(name))}($|[^\\p{L}\\d])`,
      "iu",
    ).test(t),
  );
}

export function classifyByRules(
  text: string,
  options: RuleOptions = {},
): Classification {
  const t = normalize(text);
  const mentionedServers = findMentionedServers(text, options.competitorNames);

  const irrelevant = (reason: string): Classification => ({
    category: "irrelevant",
    score: 0,
    matchedKeywords: [],
    mentionedServers,
    reason,
    classifier: "rules",
  });

  if (t.length < 8) return irrelevant("too short");
  if (isSpam(t)) return irrelevant("looks like spam / self-promo");
  if (
    options.ownServerName &&
    new RegExp(escapeRegExp(normalize(options.ownServerName)), "i").test(t) &&
    !/(ушел|бросил|разочаров|left|quit)/i.test(t)
  ) {
    return irrelevant("already talks about our server");
  }

  const perCategory: Record<string, number> = {};
  const matched: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(t)) {
      perCategory[rule.category] =
        (perCategory[rule.category] ?? 0) + rule.weight;
      matched.push(rule.label);
    }
  }
  for (const kw of options.extraKeywords ?? []) {
    if (t.includes(normalize(kw))) {
      perCategory.seeking = (perCategory.seeking ?? 0) + 25;
      matched.push(kw);
    }
  }

  const entries = Object.entries(perCategory).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return irrelevant("no lead signals");

  // An explicit "looking for a server" is the most actionable signal, even next to complaints.
  const [category, top] = perCategory.seeking
    ? ["seeking", perCategory.seeking]
    : entries[0];
  let score = entries.reduce((sum, [, v]) => sum + v, 0);
  // A question to the audience is a strong "talk to me" signal.
  if (t.includes("?")) score += 10;
  // Naming a competitor server together with a complaint means a concrete switch candidate.
  if (mentionedServers.length > 0 && perCategory.dissatisfied) score += 10;
  score = Math.min(100, Math.max(top, score));

  return {
    category: category as LeadCategory,
    score,
    matchedKeywords: matched,
    mentionedServers,
    reason: `rules: ${matched.join(", ")}`,
    classifier: "rules",
  };
}
