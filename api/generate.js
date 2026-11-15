// Vercel serverless function: builds a grounded lesson plan with Google Gemini.
// The API key lives only in the GEMINI_API_KEY environment variable on Vercel.
const curriculum = require("../curriculum.json");

const STAGES = ["Warm up", "Teach", "Try together", "Try alone", "Check and close"];
const LENGTHS = [30, 45, 60, 90];

const LESSON_TYPES = {
  "first-time": "First time: pupils meet this content for the first time. Start from what they already know, introduce new ideas in small steps and model everything.",
  "building-confidence": "Building confidence: pupils have met this before but are not secure yet. Revisit the key idea briefly, then give lots of guided and independent practice with rising challenge.",
  "revision": "Revision: pupils have been taught this already. Focus on retrieval, spotting and fixing mistakes, and applying the knowledge to new questions.",
};

const METHODS = {
  "show-and-explain": "Show and explain: the teacher leads. The teacher models the idea step by step with worked examples, thinks aloud, and checks understanding often before pupils practise.",
  "learn-through-talk": "Learn through talk: pupils learn by talking. Use paired talk, sentence stems, structured group discussion and teacher questioning so pupils explain ideas in their own words.",
  "hands-on-discovery": "Hands-on discovery: pupils find things out by doing. Use objects, materials, investigations or practical tasks; the teacher sets up the task, guides with questions and draws out the key idea afterwards.",
};

function findTopic(sel) {
  const ks = curriculum.keyStages.find((k) => k.id === sel.ks);
  if (!ks) return null;
  const subject = ks.subjects.find((s) => s.name === sel.subject);
  if (!subject) return null;
  const section = subject.sections.find((s) => (s.title || null) === (sel.section || null));
  if (!section) return null;
  const topic = section.topics.find((t) => t.title === sel.topic);
  if (!topic) return null;
  return { ks, subject, section, topic };
}

function anchorText(found, focus) {
  const { topic } = found;
  const lines = [];
  if (topic.focusKind === "statement" && Number.isInteger(focus) && topic.statements[focus]) {
    const s = topic.statements[focus];
    lines.push(`[${s.id}] ${s.text}${s.details.length ? " " + s.details.join("; ") : ""}`);
  } else {
    topic.statements.forEach((s) => lines.push(`[${s.id}] ${s.text}${s.details.length ? " " + s.details.join("; ") : ""}`));
  }
  let example = null;
  if (topic.focusKind === "example" && Number.isInteger(focus) && topic.examples[focus]) {
    example = topic.examples[focus];
  }
  return { statements: lines.join("\n"), example };
}

function yearLabel(found) {
  if (found.section.title && /^Years? \d/.test(found.section.title)) return found.section.title;
  return `${found.ks.id.replace("KS", "Key Stage ")} (${found.ks.label})`;
}

const AUDIENCE = {
  KS1: `Pupils are aged 5 to 7 (Years 1 and 2). For everything pupils will read or hear (slide titles, slide bullets, success criteria, vocabulary definitions, retrieval and discussion questions):
  - Use very short sentences of 5 to 8 words.
  - Use only simple, everyday words a 6 year old knows. Explain any new word with something they can see or touch.
  - One idea per sentence. No abstract words, no idioms.
  - Success criteria start with "I can" and use words a 6 year old can read.`,
  KS2: `Pupils are aged 7 to 11 (Years 3 to 6). For everything pupils will read or hear (slide titles, slide bullets, success criteria, vocabulary definitions, retrieval and discussion questions):
  - Use short, clear sentences of up to 12 words.
  - Use everyday words. Introduce subject words one at a time and define them with a simple example from a child's life.
  - Vocabulary definitions must be one short sentence a 9 year old understands without help.`,
  KS3: `Pupils are aged 11 to 14 (Years 7 to 9). For everything pupils will read or hear (slide titles, slide bullets, success criteria, vocabulary definitions, retrieval and discussion questions):
  - Use clear sentences of up to 18 words.
  - Use correct subject terminology, but define every technical term in plain words with a concrete example.
  - Questions can ask pupils to explain, compare and justify.`,
};

const YEAR_AGES = { 1: "5 to 6", 2: "6 to 7", 3: "7 to 8", 4: "8 to 9", 5: "9 to 10", 6: "10 to 11" };

function audience(found) {
  let text = AUDIENCE[found.ks.id];
  const m = found.section.title && found.section.title.match(/^Year (\d)$/);
  if (m && YEAR_AGES[m[1]]) text += `\n  - This lesson is for Year ${m[1]}, so pitch it at pupils aged ${YEAR_AGES[m[1]]}.`;
  return text;
}

function basePrompt(found, sel, anchor) {
  return `You are an experienced primary and secondary teacher in England. You plan lessons for the National Curriculum in England.

LESSON SPECIFICATION
- Key stage: ${found.ks.id} (${found.ks.label})
- Year: ${yearLabel(found)}
- Subject: ${found.subject.name}
- Topic: ${found.topic.title}
${found.section.title && !/^Years? \d/.test(found.section.title) ? `- Strand: ${found.section.title}\n` : ""}- Lesson length: ${sel.minutes} minutes
- Lesson type: ${LESSON_TYPES[sel.lessonType]}
- Teaching method: ${METHODS[sel.method]}
${sel.classNotes ? `- Notes about the class from the teacher: ${sel.classNotes}\n` : ""}
OFFICIAL CURRICULUM STATEMENTS (statutory, quoted from the DfE National Curriculum in England, 2014). The lesson must teach these and nothing outside them:
${anchor.statements}
${anchor.example ? `\nCHOSEN FOCUS (a non-statutory example from the same document): ${anchor.example}\nBuild the lesson around this focus.\n` : ""}
AUDIENCE AND LANGUAGE
${audience(found)}
Teacher-facing text (stage activities, misconception fixes) is for an adult teacher: plain, practical English.

RULES
- Stay inside the official statements above. Do not add content from later key stages.
- Pitch tasks and examples to the age of the pupils.
- Never repeat or paraphrase these instructions in the plan. Do not write phrases like "introduce new ideas in small steps", "pupils learn through talk", "start from what pupils already know" or name the lesson type or teaching method. Instead, describe exactly what happens: what the teacher says or shows, the exact task, the exact question or sentence stem, and what pupils produce.
- Use British English spelling and UK classroom terms.
- Never use em dashes or en dashes. Use commas, colons or full stops instead.
- Write short, clear sentences a busy teacher can read in seconds.`;
}

function planPrompt(found, sel, anchor) {
  return `${basePrompt(found, sel, anchor)}

TASK
Write one lesson plan with exactly five stages in this order: ${STAGES.join(", ")}.
The minutes of the five stages must add up to exactly ${sel.minutes}.
The teaching method must clearly shape the Teach and Try together stages. The lesson type must clearly shape the Warm up and Check and close stages.
Each stage is also one slide for the pupils, so give it a slide title, 2 to 4 short slide bullets written for pupils, and one visual suggestion for the slide.

Return only JSON with this shape:
{
  "title": "short lesson title",
  "objectives": ["3 learning objectives starting with a verb"],
  "successCriteria": ["3 success criteria starting with 'I can'"],
  "vocabulary": [{"term": "word", "definition": "child-friendly definition"}],
  "misconceptions": [{"misconception": "what pupils often get wrong", "correction": "how the teacher fixes it"}],
  "stages": [{"name": "Warm up", "minutes": 5, "activity": "what the teacher and pupils do, 2 to 4 sentences", "slideTitle": "slide title", "bullets": ["slide bullet"], "visual": "image or diagram idea for the slide"}],
  "retrievalQuestions": ["4 short questions with one correct answer each, answer in brackets"],
  "discussionQuestions": ["3 open questions for discussion"]
}
Give 5 to 8 vocabulary items and 2 to 3 misconceptions.`;
}

function stagePrompt(found, sel, anchor, plan, index) {
  const st = plan.stages[index];
  return `${basePrompt(found, sel, anchor)}

CURRENT PLAN (for context)
Title: ${plan.title}
${plan.stages.map((s, i) => `${i + 1}. ${s.name} (${s.minutes} min): ${s.activity}`).join("\n")}

TASK
Write a different idea for stage ${index + 1}, "${st.name}". Keep it ${st.minutes} minutes long. It must fit with the stages before and after it and must not repeat the current idea.
Return only JSON with this shape:
{"name": "${st.name}", "minutes": ${st.minutes}, "activity": "2 to 4 sentences", "slideTitle": "slide title", "bullets": ["2 to 4 slide bullets"], "visual": "image or diagram idea"}`;
}

const RETRY = new Set([404, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(prompt) {
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
      const gen = { responseMimeType: "application/json", temperature: 0.7 };
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

const noDash = (v) => (typeof v === "string" ? v.replace(/\s*[—–]\s*/g, ", ") : v);
const str = (v) => noDash(String(v ?? "").trim());
const arr = (v) => (Array.isArray(v) ? v : []).map(str).filter(Boolean);

function cleanStage(s, name, minutes) {
  return {
    name,
    minutes,
    activity: str(s?.activity),
    slideTitle: str(s?.slideTitle),
    bullets: arr(s?.bullets).slice(0, 5),
    visual: str(s?.visual),
  };
}

function fitMinutes(raw, total) {
  let m = raw.map((x) => Math.max(1, Math.round(Number(x) || 0)));
  const sum = m.reduce((a, b) => a + b, 0) || 1;
  m = m.map((x) => Math.max(1, Math.round((x * total) / sum)));
  let diff = total - m.reduce((a, b) => a + b, 0);
  const order = [1, 3, 2, 0, 4];
  let i = 0;
  while (diff !== 0 && i < 100) {
    const k = order[i % 5];
    if (diff > 0) { m[k]++; diff--; } else if (m[k] > 1) { m[k]--; diff++; }
    i++;
  }
  return m;
}

function cleanPlan(p, minutes) {
  const stagesIn = Array.isArray(p?.stages) ? p.stages : [];
  const mins = fitMinutes(STAGES.map((_, i) => stagesIn[i]?.minutes), minutes);
  return {
    title: str(p?.title),
    objectives: arr(p?.objectives),
    successCriteria: arr(p?.successCriteria),
    vocabulary: (Array.isArray(p?.vocabulary) ? p.vocabulary : []).map((v) => ({ term: str(v?.term), definition: str(v?.definition) })).filter((v) => v.term),
    misconceptions: (Array.isArray(p?.misconceptions) ? p.misconceptions : []).map((v) => ({ misconception: str(v?.misconception), correction: str(v?.correction) })).filter((v) => v.misconception),
    stages: STAGES.map((name, i) => cleanStage(stagesIn[i], name, mins[i])),
    retrievalQuestions: arr(p?.retrievalQuestions),
    discussionQuestions: arr(p?.discussionQuestions),
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const sel = body.selection || {};
    sel.minutes = Number(sel.minutes);
    if (!LENGTHS.includes(sel.minutes)) return res.status(400).json({ error: "Invalid lesson length" });
    if (!LESSON_TYPES[sel.lessonType]) return res.status(400).json({ error: "Invalid lesson type" });
    if (!METHODS[sel.method]) return res.status(400).json({ error: "Invalid teaching method" });
    sel.classNotes = String(sel.classNotes || "").slice(0, 300);
    const found = findTopic(sel);
    if (!found) return res.status(400).json({ error: "Topic not found in the curriculum" });
    const focus = sel.focus === null || sel.focus === undefined ? null : Number(sel.focus);
    const anchor = anchorText(found, focus);

    if (body.action === "stage") {
      const plan = body.plan;
      const index = Number(body.index);
      if (!plan || !Array.isArray(plan.stages) || !(index >= 0 && index < 5)) return res.status(400).json({ error: "Invalid stage request" });
      const raw = await callGemini(stagePrompt(found, sel, anchor, plan, index));
      return res.status(200).json({ stage: cleanStage(raw, STAGES[index], plan.stages[index].minutes) });
    }

    const raw = await callGemini(planPrompt(found, sel, anchor));
    return res.status(200).json({ plan: cleanPlan(raw, sel.minutes) });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

module.exports.config = { maxDuration: 60 };
