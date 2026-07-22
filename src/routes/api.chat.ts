import { createFileRoute } from "@tanstack/react-router";
import { useSession } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

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
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
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

function summarize(content: string, maxChars = 400): string {
  const clean = (content || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars) + " …";
}

type CaseRow = {
  title: string;
  sector?: string;
  highlight?: string;
  content?: string;
  logo?: string | null;
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
        try {
          const session = await useSession<GateSession>(sessionConfig());
          if (!session.data?.unlocked) {
            return new Response("locked", { status: 401 });
          }

          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) return new Response("ANTHROPIC_API_KEY missing", { status: 500 });

          const body = (await request.json()) as { messages?: Msg[] };
          const messages = Array.isArray(body.messages) ? body.messages : [];
          if (messages.length === 0) return new Response("empty", { status: 400 });

          let cases: CaseRow[] = [];
          const supabase = makeClient();
          if (supabase) {
            try {
              const { data: rows, error } = await supabase
                .from("cases")
                .select("title, sector, highlight, content, logo");

              if (!error && rows) {
                cases = rows as CaseRow[];
              }
            } catch (err) {
              console.error("Erro Supabase:", err);
            }
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
                    `--- CASE ${String(i + 1).padStart(2, "0")}: ${d.title}${d.sector ? " (" + d.sector + ")" : ""}${d.highlight ? " [" + d.highlight + "]" : ""} ---\n${summarize(d.content ?? "")}`,
                )
                .join("\n\n")
            : "Nenhum case encontrado no banco de dados.";

          const system = `Você é o assistente interno de cases da Paytrack. Responda à pergunta do usuário utilizando prioritariamente as informações dos cases fornecidos abaixo extraídos do Supabase. Se não encontrar nos cases fornecidos, responda com base no seu conhecimento de forma educada e objetiva.

FORMATAÇÃO:
- Respostas curtas e diretas ao ponto.
- Use **negrito** para destacar nomes de empresas e métricas.
- Destaque o setor e os principais resultados obtidos.

CASES DISPONÍVEIS DO SUPABASE (${relevant.length} selecionados):

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
            return new Response(`Erro API Claude (${anthropicRes.status}): ${errText.slice(0, 200)}`, { status: 502 });
          }

          const encoder = new TextEncoder();
          const decoder = new TextDecoder();

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
                        controller.enqueue(encoder.encode(ev.delta.text));
                      }
                    } catch {
                      // ignore parse errors
                    }
                  }
                }
              } catch (err) {
                console.error("Stream error:", err);
              } finally {
                controller.close();
              }
            },
          });

          return new Response(stream, {
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-cache",
            },
          });
        } catch (globalErr) {
          console.error("Global route error:", globalErr);
          return new Response("Erro interno no servidor.", { status: 500 });
        }
      },
    },
  },
});
