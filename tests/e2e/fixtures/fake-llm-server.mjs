// Test-only stand-in for an OpenAI-compatible AI server (used by Playwright, never by the app itself).
// It answers the packaging prompts with deterministic JSON built from words that appear in the
// transcript, so end-to-end tests can exercise the real provider path without a slow or paid model.
import http from "node:http";

const PORT = Number(process.env.FAKE_LLM_PORT ?? 3299);
let calls = 0;

function topWords(prompt) {
  const match = prompt.match(/<(transcript|summary)>([\s\S]*?)<\/\1>/);
  const words = (match?.[2] ?? "").toLowerCase().match(/[a-z]{5,}/g) ?? [];
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word]) => word);
}

function reply(prompt) {
  const words = topWords(prompt);
  const [a = "video", b = "editing", c = "ideas"] = words;
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  if (prompt.includes("Summarise what this part says")) return { summary: `This part talks about ${a} and ${b}.` };
  // Phase 9: a script of about 75 words in three scenes (fits a 30-second brief without a rewrite).
  if (prompt.includes("<brief>")) {
    const topic = prompt.match(/Topic: (.*)/)?.[1]?.trim() ?? "the topic";
    return {
      title: `Fake script: ${topic}`.slice(0, 90),
      hook: "Here is something you might not know.",
      scenes: [
        {
          narration:
            "Rain falls on mountains and slowly wears down the rocks. Tiny bits of minerals wash away with every storm, year after year, for millions of years.",
          visualQuery: "rain on mountain rocks",
          onScreenText: "Rain and rocks",
        },
        {
          narration:
            "Rivers carry those minerals all the way to the sea. Most of them are salts, and the most common one is the same salt you put on food.",
          visualQuery: "river flowing to sea",
          onScreenText: null,
        },
        {
          narration:
            "The sun heats the ocean and water rises as vapour, but the salt stays behind. That is why the sea tastes salty today.",
          visualQuery: "sun over ocean waves",
          onScreenText: "The salt stays",
        },
      ],
    };
  }
  if (prompt.includes("5 different title options")) {
    return {
      titles: [1, 2, 3, 4, 5].map((n) => `Fake title ${n}: ${cap(a)} and ${cap(b)}`),
      hooks: [`Ever wondered about ${a}?`, `Here is what ${b} really means.`, `Let's talk about ${c}.`],
    };
  }
  if (prompt.includes("engaging description")) {
    return {
      description: `A fake description about ${a}, ${b} and ${c} for automated tests.`,
      hashtags: [a, b, "UnrelatedCryptoTag"],
    };
  }
  if (prompt.includes("thumbnail concepts")) {
    return {
      concepts: [1, 2, 3].map((n) => ({
        headline: `${cap(a)} idea ${n}`,
        composition: "Speaker on the left, headline on the right.",
        emotion: "curious",
        excerpt: n,
      })),
    };
  }
  const ids = [...prompt.matchAll(/<excerpt id="(\d+)">/g)].map((m) => Number(m[1]));
  return { chapters: ids.map((id) => ({ id, title: `Section ${id}` })) };
}

http
  .createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, calls }));
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      calls += 1;
      const messages = JSON.parse(body || "{}").messages ?? [];
      const prompt = messages.at(-1)?.content ?? "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(reply(prompt)) } }] }),
      );
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Fake LLM listening on ${PORT}`));
