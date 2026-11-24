// One entry point for AI writing. Providers are tried in AI_PROVIDER_ORDER; one
// without a key is skipped, and one that fails hands over to the next.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function aiStatus() {
  return config.ai.order.map((name) => {
    const p = config.ai[name];
    return { name, model: p?.model ?? "", configured: Boolean(p?.key) };
  });
}

// Pulls the first JSON object out of a reply, tolerating ```json fences.
export function parseJson(text) {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error("The AI reply was not valid JSON.");
  }
}

async function gemini(system, prompt, maxTokens) {
  const { key, model, fallback } = config.ai.gemini;
  let lastErr;
  for (const m of [model, fallback].filter(Boolean)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: Math.max(maxTokens * 3, 16384), temperature: 0.7 },
        }),
        signal: AbortSignal.timeout(300000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        try {
          if (text) {
            parseJson(text);
            return { text, model: m };
          }
          lastErr = new Error(`Gemini ${m} returned no text (${json.candidates?.[0]?.finishReason ?? "unknown"}).`);
        } catch {
          lastErr = new Error(`Gemini ${m} reply was cut off or not valid JSON (${json.candidates?.[0]?.finishReason ?? "unknown"}).`);
          // A broken JSON reply is usually a one-off: ask the same model once more before moving on.
          if (attempt === 0) continue;
        }
        break;
      }
      lastErr = new Error(`Gemini ${m}: ${json.error?.message ?? res.status}`);
      // Busy model: one short wait, then move on to the fallback model rather than waiting minutes.
      if ((res.status === 503 || res.status === 429) && attempt === 0) await sleep(3000);
      else break;
    }
  }
  throw lastErr;
}

async function openai(system, prompt, maxTokens) {
  const { key, model } = config.ai.openai;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI: ${json.error?.message ?? res.status}`);
  return { text: json.choices?.[0]?.message?.content ?? "", model };
}

let anthropic = null;
async function claude(system, prompt, maxTokens) {
  const { key, model } = config.ai.claude;
  anthropic ??= new Anthropic({ apiKey: key });
  // Server-side fallback re-runs a declined request on a suitable model in the same call.
  const stream = anthropic.beta.messages.stream({
    model,
    max_tokens: Math.max(maxTokens, 16000),
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: `${system}\n\nReply with one JSON object only, no other text.`,
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined this request.");
  const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { text, model: msg.model };
}

const PROVIDERS = { gemini, openai, claude };

/**
 * Asks the configured AI for a JSON object.
 * @returns {Promise<{data: any, provider: string, model: string, errors: string[]}>}
 */
export async function generateJson({ system, prompt, maxTokens = 8192 }) {
  const errors = [];
  for (const name of config.ai.order) {
    if (!PROVIDERS[name] || !config.ai[name]?.key) continue;
    try {
      const { text, model } = await PROVIDERS[name](system, prompt, maxTokens);
      return { data: parseJson(text), provider: name, model, errors };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(errors.length ? `All AI providers failed. ${errors.join(" | ")}` : "No AI key is set. Add GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY to .env.");
}
