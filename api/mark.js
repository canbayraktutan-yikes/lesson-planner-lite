// Essay Marker: marks against the year's official writing expectations
// (English programmes of study + English Appendix 2), with verified in-text highlights.
const writing = require("../writing.json");
const { callGemini } = require("../lib/gemini.js");

const YEAR_AGES = { 1: "5 to 6", 2: "6 to 7", 3: "7 to 8", 4: "8 to 9", 5: "9 to 10", 6: "10 to 11", 7: "11 to 12", 8: "12 to 13", 9: "13 to 14" };
const KS_YEARS = { KS1: [1, 2], KS2: [3, 4, 5, 6], KS3: [7, 8, 9] };

const CRITERIA = [
  { name: "Argument and ideas", content: true, desc: "answers the task, ideas suit the purpose and reader, points are developed and supported" },
  { name: "Structure", desc: "clear opening and ending, paragraphs, logical order, cohesion within and across paragraphs" },
  { name: "Clarity and grammar", desc: "clear sentences and the grammar expected for this year (word and sentence level)" },
  { name: "Punctuation and spelling", desc: "the punctuation and spelling expected for this year" },
];

const APPROACH = {
  strict: "Strict: hold the writing firmly to the year's expectations. Comments are direct and precise, and name every important error.",
  balanced: "Balanced: fair and even. Give equal weight to what works and what needs improving.",
  encouraging: "Encouraging: warm and growth focused. Lead with strengths, keep next steps few and achievable. Scores stay fair; only the tone of comments changes.",
};

const clean = (v) => String(v || "").replace(/\s*[\u2014\u2013]\s*/g, ", ").trim();

function findInEssay(essay, quote) {
  const q = String(quote || "").trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  if (q.length < 6) return null;
  const i = essay.indexOf(q);
  if (i >= 0) return essay.slice(i, i + q.length);
  const pat = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+").replace(/['’‘]/g, "['’‘]").replace(/["“”]/g, "[\"“”]");
  const m = essay.match(new RegExp(pat));
  return m ? m[0] : null;
}

function expectationList(fw) {
  const list = [];
  fw.composition.forEach((t, i) => list.push({ id: "C" + (i + 1), group: "Composition", text: t }));
  fw.grammar.forEach((t, i) => list.push({ id: "G" + (i + 1), group: "Grammar", text: t }));
  fw.punctuationSpelling.forEach((t, i) => list.push({ id: "P" + (i + 1), group: "Punctuation and spelling", text: t }));
  return list;
}

function buildPrompt(year, fw, list, approach, task, essay) {
  return `You are an experienced teacher in England marking a pupil's extended writing. The writing may come from any subject (for example English, history or science).

PUPIL
- Year ${year} (aged ${YEAR_AGES[year]}), ${fw.ks}
- Task set by the teacher: ${task || "Not given. Judge the writing against its own purpose."}

THE YEAR'S WRITING EXPECTATIONS (statutory, from The national curriculum in England, DfE 2014: English programmes of study and English Appendix 2). ${fw.ks === "KS3" ? "Key stage 3 is not split by year, so these apply to Years 7 to 9." : `Pupils are also expected to keep using what was introduced in earlier years.`}
${list.map((e) => `${e.id} [${e.group}] ${e.text}`).join("\n")}

CRITERIA (score 0 to 5 against what is expected for Year ${year}: 3 = secure for Year ${year}, 5 = well above, 1 = well below)
${CRITERIA.map((c, i) => `${i + 1}. ${c.name}: ${c.desc}`).join("\n")}

FEEDBACK APPROACH
${APPROACH[approach]}

RULES
- Mark against Year ${year} expectations, never against an older or younger year.
- For each criterion, list 2 to 5 checks: the IDs of the expectations above that matter most for this piece, with "met": true only if there is clear evidence in the writing (more than one example for anything described as "a range" or "a wider range"), and false if the writing should show it but does not.
- Read the writing line by line for errors against this year's expectations and everything introduced in earlier years (for example capital letters, full stops, commas after fronted adverbials or before conjunctions where needed, apostrophes for possession and contraction, tense, spelling). Every clear error type must be either highlighted or named in a reason.
- If the writing does not answer the task or is about something else, set "onTopic" to false and explain in "offTopicNote".
- Highlights: 4 to 7 short passages copied EXACTLY, character for character, from the writing (5 to 25 words each). Type "strength" or "improve". If the writing has errors, include at least 2 "improve" highlights, each on a different error. Each comment speaks to the pupil ("You...") in words a Year ${year} pupil understands; for "improve" give a concrete better version.
- "reason" for each score is for the teacher: one or two plain sentences pointing to the writing.
- "summary": 2 or 3 sentences to the pupil, in words a Year ${year} pupil understands: strengths and one clear next step.
- British English. Never use em dashes or en dashes.

PUPIL'S WRITING
"""
${essay}
"""

Return only JSON:
{"onTopic": true, "offTopicNote": "", "criteria": [{"name": "Argument and ideas", "score": 3, "reason": "...", "checks": [{"id": "C1", "met": true}]}], "highlights": [{"quote": "exact text", "type": "strength", "comment": "..."}], "summary": "..."}`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const year = Number(b.year);
    if (!KS_YEARS[b.ks] || !KS_YEARS[b.ks].includes(year)) return res.status(400).json({ error: "Choose a key stage and year" });
    const fw = writing.years[year];
    const approach = APPROACH[b.approach] ? b.approach : "balanced";
    const essay = String(b.essay || "").replace(/\r\n/g, "\n").trim();
    const words = essay.split(/\s+/).filter(Boolean).length;
    if (words < 30) return res.status(400).json({ error: "Please add a piece of writing of at least 30 words." });
    if (essay.length > 12000) return res.status(400).json({ error: "The writing is too long. Please use up to about 2,000 words." });
    const task = String(b.task || "").slice(0, 300).trim();
    const list = expectationList(fw);
    const byId = Object.fromEntries(list.map((e) => [e.id, e]));

    const raw = await callGemini(buildPrompt(year, fw, list, approach, task, essay), { temperature: 0.3 });
    const onTopic = raw?.onTopic !== false;
    const got = Array.isArray(raw?.criteria) ? raw.criteria : [];
    const criteria = CRITERIA.map((c, i) => {
      const g = got.find((x) => String(x?.name || "").toLowerCase() === c.name.toLowerCase()) || got[i] || {};
      let score = Math.max(0, Math.min(5, Math.round(Number(g.score) || 0)));
      if (!onTopic && c.content) score = Math.min(score, 1);
      const checks = [];
      (Array.isArray(g.checks) ? g.checks : []).forEach((k) => {
        const e = byId[String(k?.id || "").trim().toUpperCase()];
        if (e && !checks.some((x) => x.text === e.text)) checks.push({ text: e.text, met: Boolean(k.met) });
      });
      return { name: c.name, score, reason: clean(g.reason), checks: checks.slice(0, 5) };
    });
    const highlights = [];
    (Array.isArray(raw?.highlights) ? raw.highlights : []).forEach((h) => {
      const exact = findInEssay(essay, h?.quote);
      if (!exact || highlights.some((x) => x.quote === exact)) return;
      highlights.push({ quote: exact, type: h.type === "strength" ? "strength" : "improve", comment: clean(h.comment) });
    });
    return res.status(200).json({
      onTopic, offTopicNote: onTopic ? "" : clean(raw?.offTopicNote) || "This writing does not answer the task.",
      criteria, highlights: highlights.slice(0, 8), summary: clean(raw?.summary),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

module.exports.config = { maxDuration: 60 };
