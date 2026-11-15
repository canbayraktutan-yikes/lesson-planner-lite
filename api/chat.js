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
  if (!ctx.subject) return { ks, year, text: "" };
  const subject = ks.subjects.find((s) => s.name === ctx.subject);
  if (!subject) return { error: "Invalid subject" };
  const sections = subject.sections.filter((s) => sectionMatchesYear(s.title, year));
  if (ctx.topic) {
    for (const sec of sections) {
      const t = sec.topics.find((x) => x.title === ctx.topic && (sec.title || null) === (ctx.section || null));
      if (t) {
        const lines = t.statements.map((s) => `- ${s.text}${s.details.length ? ": " + s.details.join("; ") : ""}`);
        const ex = t.examples && t.examples.length ? `\nNon-statutory examples listed in the curriculum: ${t.examples.join("; ")}` : "";
        return { ks, year, subject, topic: t, text: `Selected topic: ${t.title}${sec.title ? ` (${sec.title})` : ""}\nStatutory curriculum statements for this topic:\n${lines.join("\n")}${ex}` };
      }
    }
    return { error: "Invalid topic" };
  }
  const list = sections.map((sec) => `${sec.title ? sec.title + ": " : ""}${sec.topics.map((t) => t.title).join("; ")}`).join("\n");
  return { ks, year, subject, text: `Topics in the ${subject.name} curriculum for this year:\n${list}` };
}

function buildPrompt(ctx, g, messages) {
  const convo = messages.map((m) => `${m.role === "teacher" ? "Teacher" : "Assistant"}: ${m.text}`).join("\n\n");
  return `You are Madlen, a friendly and knowledgeable teaching assistant for teachers in England. You help with questions about the National Curriculum, topics, lesson ideas, activities, misconceptions, questioning, differentiation and classroom practice.

CONTEXT CHOSEN BY THE TEACHER
- Key stage: ${g.ks.id} (pupils aged ${KS_AGES[g.ks.id]})
- Year: Year ${g.year} (pupils aged ${YEAR_AGES[g.year]})
${g.subject ? `- Subject: ${g.subject.name}\n` : ""}${g.text ? `\nCURRICULUM (quoted from The national curriculum in England, DfE 2014):\n${g.text}\n` : ""}
HOW TO ANSWER
- Pitch every idea, activity and example to pupils in Year ${g.year}. ${PUPIL_LANGUAGE[g.ks.id]}
- Offer drafts and suggestions, never instructions. Use phrases like "You could...", "One option is...", "If it suits your class...". The teacher decides what goes into the lesson.
- Be concise and practical: a short answer first, then up to 5 bullet points if useful. No long essays.
- Ground curriculum claims in the curriculum text above. When you use it, say "The National Curriculum says..." and quote the statement. Never invent curriculum statements, exam board content or statistics. If the teacher asks about GCSE, A level or exam board specifications (AQA, Edexcel, OCR), say kindly that you cover Key Stages 1 to 3 of the National Curriculum and cannot quote exam board specifications.
- If a question has nothing to do with teaching or education, reply briefly and kindly that you are here to help with teaching, and suggest one thing you can help with.
- Use British English. Never use em dashes or en dashes.
- Formatting: plain text, "- " for bullets, **bold** for at most a few key words. No headings, no tables.

OFFER A LESSON PLAN
Set "offerLessonPlan" to true only when the teacher's latest message is about planning, teaching or building a lesson on the selected topic${g.topic ? ` ("${g.topic.title}")` : ""}. Otherwise set it to false.${g.topic ? "" : " No topic is selected, so it must be false."}

CONVERSATION SO FAR
${convo}

Reply to the teacher's latest message. Return only JSON: {"reply": "your answer", "offerLessonPlan": false}`;
}

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
    const raw = await callGemini(buildPrompt(ctx, g, messages), { temperature: 0.6 });
    const reply = String(raw?.reply || "").replace(/\s*[—–]\s*/g, ", ").trim();
    if (!reply) throw new Error("The AI answer was empty. Please try again.");
    return res.status(200).json({ reply, offerLessonPlan: Boolean(raw?.offerLessonPlan) && Boolean(g.topic) });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

module.exports.config = { maxDuration: 60 };
