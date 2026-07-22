import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

type Msg = { role: "user" | "assistant"; content: string };

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
  "suas","meu","minha","meus","minhas","quero","preciso","gostaria","poderia","pode","podem",
]);

function normalize(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function tokenize(s: string): string[] {
  return normalize(s).split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
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
    if (contentNorm.includes(t)) score += 1;
  }
  return score;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { messages?: Msg[] };
          const messages = Array.isArray(body.messages) ? body.messages : [];
          if (messages.length === 0) return new Response("empty", { status: 400 });

          const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
          const tokens = tokenize(lastUser);

          let cases: CaseRow[] = [];
          const supabase = makeClient();
          if (supabase) {
            const { data: rows } = await supabase
              .from("cases")
              .select("title, sector, highlight, content, logo");
            cases = (rows as CaseRow[]) ?? [];
          }

          // Ranqueia os cases mais alinhados à pesquisa
          const scored = cases.map((c) => ({ c, score: scoreCase(c, tokens) }));
          scored.sort((a, b) => b.score - a.score);
          
          const relevant = scored.filter((s) => s.score > 0).slice(0, 3).map((s) => s.c);
          const finalCases = relevant.length > 0 ? relevant : cases.slice(0, 3);

          // Monta a resposta direto no Backend sem passar por NENHUMA IA externa
          let responseText = "";
          if (finalCases.length > 0) {
            responseText = `Aqui estão os cases mais relevantes que encontrei no banco de dados:\n\n`;
            for (const c of finalCases) {
              responseText += `### 📌 **${c.title}**\n`;
              if (c.sector) responseText += `* **Setor:** ${c.sector}\n`;
              if (c.highlight) responseText += `* **Destaque:** ${c.highlight}\n`;
              if (c.content) responseText += `* **Resumo:** ${c.content.slice(0, 300)}...\n\n`;
            }
          } else {
            responseText = "Não encontrei nenhum case correspondente aos termos pesquisados.";
          }

          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(responseText));
              
              // Inclui os logos das empresas encontradas
              const logos = finalCases
                .filter((c) => c.logo)
                .map((c) => ({ title: c.title, logo: c.logo! }));

              if (logos.length > 0) {
                controller.enqueue(encoder.encode("\n<<<PT_LOGOS>>>" + JSON.stringify({ logos })));
              }

              controller.close();
            },
          });

          return new Response(stream, {
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        } catch (err) {
          return new Response("Erro ao buscar cases.", { status: 500 });
        }
      },
    },
  },
});
