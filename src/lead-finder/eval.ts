/**
 * Measures classifier quality on the hand-labelled corpora:
 *   npm run leads:eval
 * Without ANTHROPIC_API_KEY only the keyword rules are measured. With it, the full
 * pipeline (rules → prefilter → Claude) runs too and token usage is printed, so you can
 * compare models: LEAD_FINDER_LLM_MODEL=claude-haiku-5-5 npm run leads:eval
 *
 * Add your own real comments to eval-corpus.ts to make the numbers about your niche.
 */
import "dotenv/config";
import { classifyByRules, passesLlmPrefilter } from "./classifier/rules";
import { LlmClassifier } from "./classifier/llm";
import {
  EVAL_CORPUS,
  HOLDOUT_CORPUS,
  EvalSample,
} from "./classifier/eval-corpus";
import type { Classification, RawComment } from "./types";

const MIN_SCORE = 40;

function score(name: string, set: EvalSample[], verdicts: Classification[]) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  const mistakes: string[] = [];
  set.forEach((s, i) => {
    const v = verdicts[i];
    const predicted = v.category !== "irrelevant" && v.score >= MIN_SCORE;
    if (predicted && s.lead) tp++;
    else if (predicted) fp++, mistakes.push(`  лишний  [${v.score}] ${s.text}`);
    else if (s.lead) fn++, mistakes.push(`  пропуск [${v.score}] ${s.text}`);
    else tn++;
  });
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(
    `${name.padEnd(22)} точность ${pct(tp / Math.max(1, tp + fp)).padStart(4)}  полнота ${pct(tp / Math.max(1, tp + fn)).padStart(4)}  (найдено ${tp}, лишних ${fp}, пропущено ${fn}, из ${set.length})`,
  );
  mistakes.forEach((m) => console.log(m));
}

async function main() {
  const sets: [string, EvalSample[]][] = [
    ["train", EVAL_CORPUS],
    ["holdout", HOLDOUT_CORPUS],
  ];
  const model = process.env.LEAD_FINDER_LLM_MODEL || "claude-opus-5-5";
  const llm = process.env.ANTHROPIC_API_KEY ? new LlmClassifier(model) : null;

  for (const [name, set] of sets) {
    const rules = set.map((s) => classifyByRules(s.text));
    score(`${name}: правила`, set, rules);
    if (!llm) continue;

    const candidates = set
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => passesLlmPrefilter(s.text, rules[i]));
    const raw: RawComment[] = candidates.map(({ s, i }) => ({
      platform: s.source,
      commentId: `${name}-${i}`,
      videoId: "eval",
      videoUrl: "https://example.com",
      authorId: "eval",
      authorName: "eval",
      authorUrl: "https://example.com",
      text: s.text,
      publishedAt: new Date().toISOString(),
    }));
    const llmVerdicts = await llm.classify(raw, {
      game: "GTA 5 RP / SAMP / онлайн-игры",
      competitorNames: [],
    });
    const combined = [...rules];
    llmVerdicts.forEach((v, k) => (combined[candidates[k].i] = v));
    score(`${name}: правила+${model}`, set, combined);
    console.log(`  в Claude ушло ${candidates.length} из ${set.length}`);
  }
  if (llm) {
    console.log("токены:", llm.usage);
  } else {
    console.log("\nANTHROPIC_API_KEY не задан — Claude не проверялся.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
