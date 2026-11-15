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
RULES
- Stay inside the official statements above. Do not add content from later key stages.
- Pitch language, tasks and examples to the age of the pupils.
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

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set on the server.");
  const models = [process.env.GEMINI_MODEL, "gemini-2.5-flash", "gemini-flash-latest"].filter(Boolean);
  let lastErr;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
      }),
    });
    if (r.status === 404) { lastErr = new Error(`Model ${model} not found`); continue; }
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Gemini error ${r.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const clean = text.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(clean);
  }
  throw lastErr || new Error("No Gemini model available");
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
