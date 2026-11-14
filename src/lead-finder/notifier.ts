import { logger } from "../logger";
import type { Classification, RawComment } from "./types";

export interface NewLead {
  leadId: number;
  comment: RawComment;
  verdict: Classification;
}

const CATEGORY_RU: Record<string, string> = {
  seeking: "ищет сервер",
  dissatisfied: "недоволен",
  newcomer: "новичок",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Sends the OWNER a Telegram message about fresh hot leads, so someone asking
 * "посоветуйте сервер" an hour ago gets an answer while they are still choosing.
 * It only messages the configured chat (you / your team), never the leads.
 */
export class TelegramNotifier {
  constructor(
    private botToken: string,
    private chatId: string,
    public minScore = 70,
    private baseURL = "https://api.telegram.org",
  ) {}

  format(title: string, leads: NewLead[], panelUrl?: string): string | null {
    const hot = leads
      .filter((l) => l.verdict.score >= this.minScore)
      .sort((a, b) => b.verdict.score - a.verdict.score);
    if (hot.length === 0) return null;

    const lines = [
      `🔥 <b>${esc(title)}</b>: новых горячих лидов — ${hot.length}`,
      "",
    ];
    for (const l of hot.slice(0, 10)) {
      const c = l.comment;
      const text = c.text.length > 180 ? `${c.text.slice(0, 180)}…` : c.text;
      lines.push(
        `• <a href="${esc(c.authorUrl)}">${esc(c.authorName)}</a> · ${c.platform} · ${l.verdict.score} · ${CATEGORY_RU[l.verdict.category] ?? l.verdict.category}`,
        `«${esc(text)}»`,
        `<a href="${esc(c.commentUrl ?? c.videoUrl)}">открыть</a>${c.videoTitle ? ` · ${esc(c.videoTitle.slice(0, 60))}` : ""}`,
        "",
      );
    }
    if (hot.length > 10) lines.push(`…и ещё ${hot.length - 10}`);
    if (panelUrl)
      lines.push(`<a href="${esc(panelUrl)}">Открыть очередь лидов</a>`);
    return lines.join("\n");
  }

  async send(text: string): Promise<void> {
    const res = await fetch(`${this.baseURL}/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        description?: string;
      };
      throw new Error(
        `Telegram: ${res.status} ${body.description ?? res.statusText}`,
      );
    }
  }

  async notify(
    title: string,
    leads: NewLead[],
    panelUrl?: string,
  ): Promise<void> {
    const text = this.format(title, leads, panelUrl);
    if (!text) return;
    try {
      await this.send(text);
    } catch (e) {
      logger.warn({ error: (e as Error).message }, "lead notification failed");
    }
  }
}
