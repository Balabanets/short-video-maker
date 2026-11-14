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

/** "server" in its many spellings. */
const SRV = "(сервер\\S*|сервак\\S*|серв\\b|проект\\S*|server\\S*)";
/** Leaving verbs. */
const LEAVE =
  "(ушел|ушла|ушли|ухожу|уйду|ливнул\\S*|ливаю|ливнем|бросил\\S*|бросаю|свалил\\S*|сваливаю|завязал)";

/**
 * Tuned against eval-corpus.ts (YouTube comments + Discord chat). Single weak words
 * ("лагает", "вайп", "хочу зайти") are deliberately below the default threshold of 40:
 * in Discord chatter they are everyday talk, not leads. Two signals together, or one
 * strong one, are needed.
 */
export const RULES: Rule[] = [
  // ---- seeking: actively looking for a server (strongest signal)
  r(
    "seeking",
    60,
    "ищу сервер",
    `(ищу|ищем|искал\\S*|в поисках).{0,25}(${SRV}|где (по)?играть|куда|другой|другие|новый|новое место)`,
  ),
  r(
    "seeking",
    60,
    "посоветуйте сервер",
    `(посовету\\S*|подскаж\\S*|порекоменду\\S*|дайте ссылку|с?кин\\S* ссылку|кто знает).{0,30}${SRV}|${SRV}.{0,15}(посовету\\S*|порекоменду\\S*)`,
  ),
  r(
    "seeking",
    55,
    "какой сервер выбрать",
    `(как\\S*|на каком|в какой)\\s${SRV}.{0,25}(лучше|выбрать|самый|живой|живее|норм|посовету\\S*|стоит|актуал\\S*|сейчас|без доната|для новичк)`,
  ),
  r(
    "seeking",
    50,
    "хочу туда же",
    `(как\\S*|на каком)\\s${SRV}.{0,30}(хочу туда|тоже хочу|где найти)`,
  ),
  r(
    "seeking",
    55,
    "куда перейти",
    "куда(-нибудь|-то)? (бы )?(перейти|перейдем|уйти|уйдем|свалить|переехать|переедем|переезжать|податься|пойти играть)",
  ),
  r(
    "seeking",
    55,
    "сменить сервер",
    `(сменить|поменять|меняю|сменю)\\s.{0,10}${SRV}`,
  ),
  r(
    "seeking",
    45,
    "другие сервера",
    `(других|другие|другом|другой)\\s${SRV}.{0,30}\\?`,
  ),
  r(
    "seeking",
    50,
    "есть норм сервера",
    `есть (ли )?(норм|нормальн|хорош|живые|живой|годн|адекватн)\\S*\\s${SRV}`,
  ),
  r(
    "seeking",
    50,
    "где играть?",
    "где (сейчас |теперь )?(нормально |норм |лучше )?(по)?играть.{0,40}\\?",
  ),
  r("seeking", 45, "во что поиграть", "во что (бы )?поиграть"),
  r(
    "seeking",
    55,
    "looking for a server",
    "(looking for|recommend|suggest|any good).{0,25}server",
  ),
  r("seeking", 45, "which server", "(which|what|best) server.{0,30}\\?"),

  // ---- dissatisfied: strong (one is enough)
  r(
    "dissatisfied",
    45,
    "ушел с сервера",
    `${LEAVE}.{0,25}(${SRV}|оттуда|играть на)|${LEAVE} с [a-zа-я]{3,}`,
  ),
  r(
    "dissatisfied",
    45,
    "сервер умер",
    `${SRV}.{0,10}(умер|мертв\\S*|сдох|помер|загнулся|пустой|всё|все,|скатился|отстой|помойка|дно)`,
  ),
  r(
    "dissatisfied",
    40,
    "разочаровался",
    "разочаровал\\S*|раньше было (лучше|живее|норм)|раньше (сервер|проект) был",
  ),
  r(
    "dissatisfied",
    40,
    "донат-помойка",
    "(донат|donate).{0,30}(помойк|грабеж|дорог|решает|ужас|бред|развод|выкачива|без вложений)|пей ту вин|pay to win|p2w",
  ),
  r(
    "dissatisfied",
    40,
    "admin abuse",
    "админ\\S*.{0,30}(абуз\\S*|беспредел|неадекват|поехали|охренели|офигели|оборзел|клоун|раздают себе|банят за вс|банят ни за)",
  ),
  r(
    "dissatisfied",
    40,
    "left the server",
    "(quit|left|leaving).{0,20}(the )?server|server (is )?(dead|died|empty|trash|garbage)",
  ),

  // ---- dissatisfied: weak (need another signal)
  r(
    "dissatisfied",
    30,
    "бан ни за что",
    "(забанили|бан\\S*).{0,25}(ни за что|просто так|без причины|не разобрав)",
  ),
  r(
    "dissatisfied",
    30,
    "админы не реагируют",
    "(админ\\S*|администрац\\S*|модер\\S*).{0,30}(даже не|ничего не дела|не рассматрива|не отвеча|игнор|забил)",
  ),
  r(
    "dissatisfied",
    30,
    "вайп опять",
    "(вайп|wipe).{0,25}(опять|снова|каждый|третий|второй|достал|потерял)|(опять|снова).{0,10}(вайп|wipe)",
  ),
  r(
    "dissatisfied",
    30,
    "лаги постоянно",
    "(лаги|лагает|фризы|тормозит|краши|вылетает).{0,25}(постоянно|всегда|невозможн|ужас|каждый день|вечно)",
  ),
  r(
    "dissatisfied",
    25,
    "читеры",
    "(читер\\S*|читак\\S*|cheater\\S*|hacker\\S*).{0,25}(везде|полно|куча|никто не банит|full|every)|одни (читер|донатер)",
  ),
  r(
    "dissatisfied",
    30,
    "мертвый онлайн",
    "(онлайн|онлаин|народу|людей).{0,15}(мертв\\S*|ноль|0 |упал|никак|\\d{1,2} человек)",
  ),
  r(
    "dissatisfied",
    20,
    "играть невозможно",
    "(играть|играть там) невозможно|невозможно играть",
  ),
  r(
    "dissatisfied",
    40,
    "устал от сервера",
    `(устал|надоел\\S*) от (этого |этой )?${SRV}`,
  ),
  r("dissatisfied", 20, "не вернусь", "(больше )?(туда |сюда )?не вернусь"),
  r("dissatisfied", 15, "надоело", "надоел\\S*|достал\\S*|задолбал\\S*"),

  // ---- newcomer: wants to start
  r(
    "newcomer",
    45,
    "хочу в рп",
    "(хочу|хотел\\S*) (в|на) (рп|rp)(\\s|$|,|\\.|!)",
  ),
  r(
    "newcomer",
    45,
    "хочу начать играть",
    "(хочу|хотел бы|хотела бы|думаю|собираюсь|решил)\\s.{0,10}(начать|попробовать) (играть|в рп|рп|гта|поиграть)",
  ),
  r(
    "newcomer",
    45,
    "с чего начать",
    "с чего (начать|начинать)|как (тут |вообще )*(начать|начинать)(\\s?играть)?\\s*\\?|как (туда|сюда) попасть",
  ),
  r(
    "newcomer",
    40,
    "как зайти на сервер",
    `как (зайти|подключиться|попасть|скачать|установить).{0,15}(на |в )?(${SRV}|рп|гта|игру)`,
  ),
  r(
    "newcomer",
    40,
    "новичок",
    "(новичок|новеньк\\S*|нуб|впервые|первый раз|никогда не играл\\S*|только начал\\S*|только купил\\S*).{0,30}(рп|играть|начать|игр|сервер|гта)",
  ),
  r(
    "newcomer",
    35,
    "захотелось попробовать",
    "захотел\\S* (попробовать|поиграть|начать)",
  ),
  r(
    "newcomer",
    40,
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

/**
 * Cheap gate in front of the LLM: anything that talks about servers, the game or starting
 * to play. Measured on the eval corpora it lets through every labelled lead.
 */
const LLM_TOPIC =
  /сервер|сервак|серв(\s|$)|server|проект|админ|модер|донат|вайп|онлайн|игра|игру|играть|играю|поиграть|(^|\s)(рп|rp)(\s|$|,)|гта|gta|самп|samp|майн|бан|новичок|новеньк|начать|перейти|переехать|переедем|попасть/;

export function passesLlmPrefilter(
  text: string,
  rules: Classification,
  competitorNames: string[] = [],
): boolean {
  if (
    rules.reason === "looks like spam / self-promo" ||
    rules.reason === "too short"
  ) {
    return false;
  }
  if (rules.score > 0) return true;
  return (
    LLM_TOPIC.test(normalize(text)) ||
    findMentionedServers(text, competitorNames).length > 0
  );
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
  // A question to the audience is a strong "talk to me" signal — for seekers and newcomers.
  if (t.includes("?") && (perCategory.seeking || perCategory.newcomer)) {
    score += 10;
  }
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
