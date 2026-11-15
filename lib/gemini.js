// Shared Gemini caller with model fallback and timeouts.
const RETRY = new Set([404, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(prompt, opts = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set on the server.");
  const models = [...new Set([process.env.GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest", "gemini-flash-lite-latest"].filter(Boolean))];
  const started = Date.now();
  let lastMsg = "";
  for (let round = 0; round < 2; round++) {
    for (const model of models) {
      const left = 52000 - (Date.now() - started);
      if (left < 4000) break;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(25000, left));
      const gen = { responseMimeType: "application/json", temperature: opts.temperature ?? 0.7 };
      if (model.startsWith("gemini-2.5")) gen.thinkingConfig = { thinkingBudget: 0 };
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      let r, data;
      try {
        r = await fetch(url, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: gen,
          }),
        });
        data = await r.json();
      } catch (e) { clearTimeout(timer); lastMsg = e.name === "AbortError" ? `${model} was too slow` : e.message; continue; }
      clearTimeout(timer);
      if (RETRY.has(r.status)) { lastMsg = data?.error?.message || `Gemini error ${r.status}`; continue; }
      if (!r.ok) throw new Error(data?.error?.message || `Gemini error ${r.status}`);
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      const clean = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
      try { return JSON.parse(clean); } catch { lastMsg = "The AI answer was not complete."; continue; }
    }
    if (52000 - (Date.now() - started) < 6000) break;
    await sleep(1500);
  }
  throw new Error("The AI service is busy right now. Please try again in a minute. (" + lastMsg + ")");
}


module.exports = { callGemini };
