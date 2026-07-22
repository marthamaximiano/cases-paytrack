import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type GateSession = { unlocked?: boolean };
type Msg = { role: "user" | "assistant"; content: string };

function sessionConfig() {
  return {
    password: process.env.SESSION_SECRET!,
    name: "paytrack-gate",
    maxAge: 60 * 60 * 24 * 7,
    cookie: { httpOnly: true, secure: true, sameSite: "none" as const, path: "/" },
  };
}

function makeClient() {
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(process.env.SUPABASE_URL!, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`) h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

const STOP = new Set([
  "a","o","as","os","de","da","do","das","dos","e","um","uma","uns","umas","no","na","nos","nas",
  "em","por","para","pra","pro","com","sem","que","qual","quais","quando","onde","como","porque",
  "sobre","ao","aos","à","às","é","são","foi","ser","tem","têm","ter","tinha","havia","mais","menos",
  "muito","pouco","bem","mal","case","cases","cliente","clientes","empresa","empresas","exemplo",
  "exemplos","me","mostra","mostre","mostrar","fala","fale","falar","diga","dizer","dar","dá",
  "algum","alguns","alguma","algumas","todos","todas","tudo","nada","isso","isto","aquele",
  "aquela","este","esta","esses","essas","aqueles","aquelas","sim","não","nao","seu","sua","seus",
  "suas","meu","minha","meus","minhas","the","of","and","or","for","to","in","on","with","a","an",
  "quero","preciso","gostaria","poderia","pode","podem","tem","há","ha","também","tambem","só","so",
  "usa","usam","usar","usam","big","numbers","números","numeros","principais","principal","resultado",
  "resultados","paytrack","grupo","ltda","sa",
]);

function normalize(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

function summarize(content: string, maxChars = 350): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars) + " …";
}

type CaseRow = {
  title: string;
  sector: string;
  highlight: string;
  content: string;
  logo: string | null;
};

function scoreCase(c: CaseRow, tokens: string[]): number {
  if (!tokens.length) return 0;
  const title = normalize(c.title || "");
  const sector = normalize(c.sector || "");
  const highlight = normalize(c.highlight || "");
  const contentNorm = normalize(c.content || "");
  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 8;
    if (sector.includes(t)) score += 5;
    if (highlight.includes(t)) score += 3;
    let idx = 0, n = 0;
    while (n < 5) {
      const found = contentNorm.indexOf(t, idx);
      if (found === -1) break;
      n++;
      idx = found + t.length;
    }
    score += n;
  }
  return score;
}

function pickRelevant(cases: CaseRow[], userTokens: string[], convoTokens: string[], limit = 3): CaseRow[] {
  if (!cases || cases.length === 0) return [];
  const scored = cases.map((c) => ({
    c,
    score: scoreCase(c, userTokens) * 2 + scoreCase(c, convoTokens),
  }));
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.c);
  if (relevant.length > 0) return relevant;
  return cases.slice(0, Math.min(limit, cases.length));
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const session = await useSession<GateSession>(sessionConfig());
        if (!session.data.unlocked) {
          return new Response("locked", { status: 401 });
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return new Response("ANTHROPIC_API_KEY missing", { status: 500 });

        const body = (await request.json()) as { messages?: Msg[] };
        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (messages.length === 0) return new Response("empty", { status: 400 });

        let cases: CaseRow[] = [];
        try {
          const supabase = makeClient();
          const { data: rows, error } = await supabase
            .from("cases")
            .select("title, sector, highlight, content, logo");

          if (error) {
            console.error("Erro ao buscar no Supabase:", error);
          }
          cases = rows ?? [];
        } catch (err) {
          console.error("Falha de conexao Supabase:", err);
        }

        const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const convoText = messages.map((m) => m.content).join(" ");
        const userTokens = tokenize(lastUser);
        
        if (userTokens.includes("km") || convoText.toLowerCase().includes("km")) {
          userTokens.push("trajetos", "trajeto");
        }
        if (userTokens.includes("trajetos") || userTokens.includes("trajeto")) {
          userTokens.push("km");
        }

        const convoTokens = tokenize(convoText);
        const relevant = pickRelevant(cases, userTokens, convoTokens, 3);

        const docsText = relevant.length > 0
          ? relevant
              .map(
                (d, i) =>
                  `--- CASE ${String(i + 1).padStart(2, "0")}: ${d.title}${d.sector ? " (" + d.sector + ")" : ""}${d.highlight ? " [" + d.highlight + "]" : ""} [LOGO: ${d.logo ? "disponível" : "não disponível"}] ---\n${summarize(d.content ?? "")}`,
              )
              .join("\n\n")
          : "Nenhum case encontrado na tabela do Supabase.";

        const system = `Você é o assistente interno de cases da Paytrack, empresa de gestão de despesas, viagens e cartões corporativos. Responda perguntas de funcionários usando APENAS o conteúdo dos cases abaixo extraídos do banco de dados Supabase. Se a resposta não estiver nos cases, diga claramente que não encontrou essa informação nos documentos disponíveis — não invente números nem clientes. Sempre cite o nome do cliente/case de onde veio a informação.

Cada case indica entre colchetes se tem LOGO disponível. Ao citar uma empresa, o sistema exibe o logo automaticamente abaixo da resposta — NÃO insira markdown de imagem, URLs ou tags <img>. Apenas cite o nome da empresa.

FORMATAÇÃO (obrigatório):
- Markdown limpo: **negrito** para destaques, ## para títulos curtos quando útil, listas com "- ".
- NUNCA use linhas divisórias ("---", "***", "___").
- Não use blocos de código para texto normal.
- Ao apresentar vários cases, use lista onde cada item começa com **nome da empresa** e os números/insights.

Trate "Gestão de km" e "Trajetos" como o mesmo recurso.

CASES RELEVANTES DO SUPABASE (${relevant.length} de ${cases.length}):

${docsText}`;

        const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-haiku-20240307",
            max_tokens: 1024,
            stream: true,
            system,
            messages,
          }),
        });

        if (!anthropicRes.ok || !anthropicRes.body) {
          const errText = await anthropicRes.text().catch(() => "");
          console.error("Anthropic error details:", errText);
          return new Response(`Anthropic error ${anthropicRes.status}: ${errText.slice(0, 300)}`, {
            status: 502,
          });
        }

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        let assistantBuf = "";

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = anthropicRes.body!.getReader();
            let sseBuf = "";
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuf += decoder.decode(value, { stream: true });
                const parts = sseBuf.split("\n\n");
                sseBuf = parts.pop() ?? "";
                for (const part of parts) {
                  const line = part.split("\n").find((l) => l.startsWith("data:"));
                  if (!line) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  try {
                    const ev = JSON.parse(payload) as {
                      type?: string;
                      delta?: { type?: string; text?: string };
                    };
                    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
                      assistantBuf += ev.delta.text;
                      controller.enqueue(encoder.encode(ev.delta.text));
                    }
                  } catch {
                    // ignore malformed SSE
                  }
                }
              }

              const hay = new Set(normalize(lastUser + " " + assistantBuf).split(/\s+/).filter(Boolean));
              const LOGO_STOP = new Set([
                "grupo","de","da","do","das","dos","e","a","o","case","ltda","sa","consorcio",
                "construtor","centro","estudos","pesquisas","sistema","sistemas","brasil","the",
              ]);
              const seen = new Set<string>();
              const logos: Array<{ title: string; logo: string }> = [];
              for (const d of cases) {
                if (!d.logo || seen.has(d.title)) continue;
                const tw = normalize(d.title).split(/\s+/).filter((w) => w.length >= 3 && !LOGO_STOP.has(w));
                if (!tw.length) continue;
                if (tw.some((w) => hay.has(w))) {
                  logos.push({ title: d.title, logo: d.logo });
                  seen.add(d.title);
                }
              }

              controller.enqueue(
                encoder.encode("\n<<<PT_LOGOS>>>" + JSON.stringify({ logos })),
              );
            } catch (err) {
              controller.enqueue(encoder.encode("\n[erro de streaming]"));
              console.error("stream error", err);
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
