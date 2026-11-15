// Essay Marker: subject-specific rubric, in-text highlights verified against the essay,
// curriculum grounding and an editable pupil summary.
const curriculum = require("../curriculum.json");
const { callGemini } = require("../lib/gemini.js");

const YEARS = { KS1: [1, 2], KS2: [3, 4, 5, 6], KS3: [7, 8, 9] };
const YEAR_AGES = { 1: "5 to 6", 2: "6 to 7", 3: "7 to 8", 4: "8 to 9", 5: "9 to 10", 6: "10 to 11", 7: "11 to 12", 8: "12 to 13", 9: "13 to 14" };

// content: criteria capped at 1 when the essay does not answer the question
const RUBRICS = {
  English: [
    { name: "Ideas and purpose", content: true, desc: "answers the task, ideas suit the purpose and audience, ideas are developed" },
    { name: "Structure", desc: "clear opening and ending, paragraphs, ideas in a logical order, links between paragraphs" },
    { name: "Vocabulary and style", desc: "precise and varied word choice, sentence variety, appropriate tone" },
    { name: "Spelling, punctuation and grammar", desc: "accurate spelling, punctuation and grammar for the year group" },
  ],
  History: [
    { name: "Historical knowledge", content: true, desc: "accurate, relevant facts, dates, people and events" },
    { name: "Use of evidence", content: true, desc: "supports points with specific examples or sources" },
    { name: "Argument and judgement", content: true, desc: "answers the question, explains causes or significance, reaches a supported judgement" },
    { name: "Clear communication", desc: "organised paragraphs, clear sentences; spelling and grammar only matter if they block meaning" },
  ],
  Geography: [
    { name: "Geographical knowledge", content: true, desc: "accurate knowledge of places, processes and key terms" },
    { name: "Examples and data", content: true, desc: "uses named places, case studies, figures or maps to support points" },
    { name: "Explanation", content: true, desc: "explains how and why, links causes and effects" },
    { name: "Clear communication", desc: "organised and clear; spelling and grammar only matter if they block meaning" },
  ],
  Science: [
    { name: "Scientific knowledge", content: true, desc: "accurate scientific ideas for the year group, no misconceptions" },
    { name: "Scientific vocabulary", desc: "uses correct scientific terms accurately" },
    { name: "Explanation and reasoning", content: true, desc: "explains cause and effect step by step" },
    { name: "Use of evidence", content: true, desc: "refers to observations, data or experiments to support claims" },
  ],
  Citizenship: [
    { name: "Knowledge", content: true, desc: "accurate knowledge of institutions, rights, laws or democracy" },
    { name: "Different viewpoints", content: true, desc: "considers more than one viewpoint fairly" },
    { name: "Argument and judgement", content: true, desc: "answers the question with reasons and a justified conclusion" },
    { name: "Clear communication", desc: "organised and clear; spelling and grammar only matter if they block meaning" },
  ],
};

function sectionMatchesYear(title, year) {
  if (!title) return true;
  if (/^Spoken language/.test(title)) return false;
  if (/^Years? \d/.test(title)) { const n = (title.match(/\d+/g) || []).map(Number); return n.length === 2 ? year >= n[0] && year <= n[1] : n[0] === year; }
  return true;
}

function curriculumPool(ks, subjectName, year) {
  const subj = ks.subjects.find((s) => s.name === subjectName);
  const pool = [];
  if (!subj) return pool;
  subj.sections.filter((s) => sectionMatchesYear(s.title, year)).forEach((sec) => sec.topics.forEach((t) => {
    if (subjectName === "English" && !/writing|grammar/i.test(t.title)) return;
    if (subjectName === "English" && /handwriting/i.test(t.title)) return;
    t.statements.forEach((s) => pool.push({ topic: t.title, text: s.text, details: s.details }));
  }));
  return pool;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clean = (v) => String(v || "").replace(/\s*[\u2014\u2013]\s*/g, ", ").trim();

function findInEssay(essay, quote) {
  const q = String(quote || "").trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  if (q.length < 6) return null;
  let i = essay.indexOf(q);
  if (i >= 0) return essay.slice(i, i + q.length);
  // tolerate whitespace and curly quote differences
  const pat = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+").replace(/['’‘]/g, "['’‘]").replace(/["“”]/g, "[\"“”]");
  const m = essay.match(new RegExp(pat));
  return m ? m[0] : null;
}

function buildPrompt(k, year, subject, rubric, question, essay, pool) {
  const statements = pool.map((s) => `- [${s.topic}] ${s.text}${s.details.length ? ": " + s.details.join("; ") : ""}`).join("\n");
  return `You are an experienced ${subject} teacher in England marking a pupil's extended writing. Mark fairly for the pupil's age, like a careful UK teacher.

PUPIL
- Key stage ${k.replace("KS", "")}, Year ${year} (aged ${YEAR_AGES[year]})
- Subject: ${subject}
- Task or question: ${question || "Not given. Judge the essay on its own purpose."}

NATIONAL CURRICULUM STATEMENTS FOR THIS YEAR (The national curriculum in England, DfE 2014):
${statements || "(none)"}

RUBRIC (score each criterion 0 to 5; 3 means secure for Year ${year}, 5 means well above, 1 means well below):
${rubric.map((c, i) => `${i + 1}. ${c.name}: ${c.desc}`).join("\n")}

RULES
- Judge against what is expected for Year ${year}, not adult standards.
- ${subject === "English" ? "Spelling, punctuation and grammar is its own criterion." : "Do not reward or punish spelling and grammar except inside Clear communication, and only when it blocks meaning. Good grammar must not lift weak subject content."}
- If the essay does not answer the task or is about a different topic, set "onTopic" to false and say why in "offTopicNote".
- Highlights: pick 3 to 6 short passages copied EXACTLY, character for character, from the essay (5 to 25 words each). Mark each as "strength" or "improve". Each comment speaks to the pupil ("You...") in language a Year ${year} pupil understands, names what works or what to change, and for "improve" gives a concrete example of a better version.
- Reasons for each score are for the teacher: one or two plain sentences that point to the essay.
- Summary: 2 or 3 sentences to the pupil, in language a Year ${year} pupil understands: one or two strengths and one clear next step.
- Curriculum: copy 1 to 3 statements from the list above, word for word without the topic in brackets, that the marking relied on.
- British English. Never use em dashes or en dashes.

ESSAY
"""
${essay}
"""

Return only JSON:
{"onTopic": true, "offTopicNote": "", "criteria": [{"name": "${rubric[0].name}", "score": 3, "reason": "..."}], "highlights": [{"quote": "exact text", "type": "strength", "comment": "..."}], "summary": "...", "quotes": ["exact statement"]}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const ks = curriculum.keyStages.find((x) => x.id === b.ks);
    const year = Number(b.year);
    if (!ks || !YEARS[ks.id].includes(year)) return res.status(400).json({ error: "Choose a key stage and year" });
    const rubric = RUBRICS[b.subject];
    if (!rubric) return res.status(400).json({ error: "Choose a subject" });
    const essay = String(b.essay || "").replace(/\r\n/g, "\n").trim();
    const words = essay.split(/\s+/).filter(Boolean).length;
    if (words < 40) return res.status(400).json({ error: "Please paste an essay of at least 40 words." });
    if (essay.length > 12000) return res.status(400).json({ error: "The essay is too long. Please paste up to about 2,000 words." });
    const question = String(b.question || "").slice(0, 300).trim();
    const pool = curriculumPool(ks, b.subject, year);

    const raw = await callGemini(buildPrompt(ks.id, year, b.subject, rubric, question, essay, pool), { temperature: 0.3 });
    const onTopic = raw?.onTopic !== false;
    const got = Array.isArray(raw?.criteria) ? raw.criteria : [];
    const criteria = rubric.map((c, i) => {
      const g = got.find((x) => norm(x?.name) === norm(c.name)) || got[i] || {};
      let score = Math.max(0, Math.min(5, Math.round(Number(g.score) || 0)));
      if (!onTopic && c.content) score = Math.min(score, 1);
      return { name: c.name, score, reason: clean(g.reason) };
    });
    const highlights = [];
    (Array.isArray(raw?.highlights) ? raw.highlights : []).forEach((h) => {
      const exact = findInEssay(essay, h?.quote);
      if (!exact || highlights.some((x) => x.quote === exact)) return;
      highlights.push({ quote: exact, type: h.type === "strength" ? "strength" : "improve", comment: clean(h.comment) });
    });
    const sources = [];
    (Array.isArray(raw?.quotes) ? raw.quotes : []).forEach((q) => {
      const nq = norm(q); if (nq.length < 15) return;
      const hit = pool.find((s) => { const ns = norm(s.text); return ns === nq || ns.includes(nq) || (nq.includes(ns) && ns.length > 25); });
      if (hit && !sources.some((s) => s.text === hit.text)) sources.push({ topic: hit.topic, text: hit.text });
    });
    return res.status(200).json({
      onTopic, offTopicNote: onTopic ? "" : clean(raw?.offTopicNote) || "This essay does not answer the question.",
      criteria, highlights: highlights.slice(0, 8), summary: clean(raw?.summary), sources: sources.slice(0, 3),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

module.exports.config = { maxDuration: 60 };
