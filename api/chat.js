// Teacher Chatbot: answers teacher questions, pitched to the chosen key stage and year,
// grounded in National Curriculum statements when a subject or topic is selected.
const curriculum = require("../curriculum.json");
const { callGemini } = require("../lib/gemini.js");

const KS_AGES = { KS1: "5 to 7", KS2: "7 to 11", KS3: "11 to 14" };
const YEAR_AGES = { 1: "5 to 6", 2: "6 to 7", 3: "7 to 8", 4: "8 to 9", 5: "9 to 10", 6: "10 to 11", 7: "11 to 12", 8: "12 to 13", 9: "13 to 14" };
const YEARS = { KS1: [1, 2], KS2: [3, 4, 5, 6], KS3: [7, 8, 9] };

const PUPIL_LANGUAGE = {
  KS1: "Any text meant for pupils (questions, explanations, examples, word definitions) must use very short sentences of 5 to 8 words and only simple everyday words a 6 year old knows.",
  KS2: "Any text meant for pupils (questions, explanations, examples, word definitions) must use short sentences of up to 12 words and everyday words; define subject words with a simple example from a child's life.",
  KS3: "Any text meant for pupils (questions, explanations, examples, word definitions) can use correct subject terms, but define each technical term in plain words with a concrete example; sentences up to 18 words.",
};

function sectionMatchesYear(title, year) {
  if (!title) return true;
  const nums = (title.match(/\d+/g) || []).map(Number);
  if (/^Years? \d/.test(title) || /^Spoken language/.test(title)) {
    if (/^Spoken language/.test(title)) return year <= 6;
    if (nums.length === 2) return year >= nums[0] && year <= nums[1];
    return nums[0] === year;
  }
  return true; // KS3 strands (e.g. Biology) apply to every KS3 year
}

function grounding(ctx) {
  const ks = curriculum.keyStages.find((k) => k.id === ctx.ks);
  if (!ks) return { error: "Invalid key stage" };
  const year = Number(ctx.year);
  if (!YEARS[ks.id].includes(year)) return { error: "Invalid year" };
  if (!ctx.subject) return { ks, year, pool: [], text: "" };
  const subject = ks.subjects.find((s) => s.name === ctx.subject);
  if (!subject) return { error: "Invalid subject" };
  const sections = subject.sections.filter((s) => sectionMatchesYear(s.title, year));
  const pool = [];
  const add = (t) => t.statements.forEach((s) => pool.push({ topic: t.title, text: s.text, details: s.details }));
  const fmt = () => pool.map((s) => `- [${s.topic}] ${s.text}${s.details.length ? ": " + s.details.join("; ") : ""}`).join("\n");
  if (ctx.topic) {
    for (const sec of sections) {
      const t = sec.topics.find((x) => x.title === ctx.topic && (sec.title || null) === (ctx.section || null));
      if (t) {
        add(t);
        const ex = t.examples && t.examples.length ? `\nNon-statutory examples listed for this topic (suggestions, not requirements): ${t.examples.join("; ")}` : "";
        return { ks, year, subject, topic: t, pool, text: `Selected topic: ${t.title}\nStatutory statements:\n${fmt()}${ex}` };
      }
    }
    return { error: "Invalid topic" };
  }
  sections.forEach((sec) => sec.topics.forEach(add));
  return { ks, year, subject, pool, text: `All statutory ${subject.name} statements for this year, with their topic in brackets:\n${fmt()}` };
}

function buildPrompt(ctx, g, messages) {
  const convo = messages.map((m) => `${m.role === "teacher" ? "Teacher" : "Madlen"}: ${m.text}`).join("\n\n");
  return `You are Madlen, an expert teaching assistant for teachers in England. You help with the National Curriculum, topics, lesson ideas, activities, misconceptions, questioning, assessment, differentiation and classroom practice.

CONTEXT CHOSEN BY THE TEACHER
- Key stage: ${g.ks.id} (pupils aged ${KS_AGES[g.ks.id]})
- Year: Year ${g.year} (pupils aged ${YEAR_AGES[g.year]})
${g.subject ? `- Subject: ${g.subject.name}\n` : "- Subject: not chosen\n"}${g.text ? `\nNATIONAL CURRICULUM (The national curriculum in England, DfE 2014):\n${g.text}\n` : "\nNo subject is chosen, so you have no curriculum text. Do not quote or describe the curriculum; if asked, suggest the teacher picks a subject.\n"}
HOW TO ANSWER
- Answer the teacher's actual question directly in the first sentence. No filler, no praise, no "great question", no "it is lots of fun".
- Be specific to Year ${g.year}${g.subject ? ` ${g.subject.name}` : ""}: name the exact skills, facts, numbers, texts or examples a Year ${g.year} teacher would use. Generic advice that fits any year is not good enough.
- ${PUPIL_LANGUAGE[g.ks.id]}
- Offer suggestions, not instructions: "You could...", "One option is...". The teacher decides.
- If a question is vague, give your best useful answer and end the answer with one short question to narrow it down.
- Curriculum claims: only use the curriculum text above. Never invent or paraphrase curriculum requirements. Copy the exact statements you rely on into "quotes" (word for word, without the topic in brackets). Do not write "the National Curriculum says" in the answer; the quotes are shown separately with the source.
- If asked about GCSE, A level or exam board specifications (AQA, Edexcel, OCR), say you cover Key Stages 1 to 3 of the National Curriculum only.
- If the question is not about teaching or education, say kindly in one sentence that you help with teaching, and suggest one thing you can help with.
- British English. Never use em dashes or en dashes. No markdown headings or tables. You may use **bold** for up to 3 key words.

OFFER A LESSON PLAN
"offerLessonPlan" is true only when the teacher's latest message asks to plan, teach or build a lesson on the selected topic${g.topic ? ` ("${g.topic.title}")` : ""}. Otherwise false.${g.topic ? "" : " No topic is selected, so it must be false."}

CONVERSATION SO FAR
${convo}

Reply to the teacher's latest message. Return only JSON:
{"answer": "1 to 3 sentences that directly answer", "points": ["0 to 5 short, concrete suggestions or facts"], "quotes": ["0 to 3 exact curriculum statements you relied on"], "offerLessonPlan": false}`;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function verifyQuotes(quotes, pool) {
  const out = [];
  (Array.isArray(quotes) ? quotes : []).forEach((q) => {
    const nq = norm(q).replace(/^\s*\[[^\]]*\]\s*/, "");
    if (nq.length < 15) return;
    const hit = pool.find((s) => { const ns = norm(s.text); return ns === nq || ns.includes(nq) || (nq.includes(ns) && ns.length > 25); });
    if (hit && !out.some((o) => o.text === hit.text)) out.push({ topic: hit.topic, text: hit.text });
  });
  return out.slice(0, 3);
}

const clean = (v) => String(v || "").replace(/\s*[\u2014\u2013]\s*/g, ", ").trim();

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const ctx = body.context || {};
    const g = grounding(ctx);
    if (g.error) return res.status(400).json({ error: g.error });
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === "teacher" || m.role === "assistant") && typeof m.text === "string")
      .slice(-12)
      .map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
    if (!messages.length || messages[messages.length - 1].role !== "teacher") return res.status(400).json({ error: "Ask a question first" });
    const raw = await callGemini(buildPrompt(ctx, g, messages), { temperature: 0.5 });
    const answer = clean(raw?.answer || raw?.reply);
    const points = (Array.isArray(raw?.points) ? raw.points : []).map(clean).filter(Boolean).slice(0, 6);
    if (!answer && !points.length) throw new Error("The AI answer was empty. Please try again.");
    const sources = verifyQuotes(raw?.quotes, g.pool || []);
    return res.status(200).json({ answer, points, sources, offerLessonPlan: Boolean(raw?.offerLessonPlan) && Boolean(g.topic) });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

module.exports.config = { maxDuration: 60 };
