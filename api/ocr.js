// Turns a photo of handwritten or printed pupil work into editable text.
const { callGemini } = require("../lib/gemini.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const m = String(b.image || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: "Please upload a JPG, PNG or WebP photo." });
    if (m[2].length > 4_000_000) return res.status(400).json({ error: "The photo is too large. Please try a smaller one." });
    const prompt = `This is a photo of a pupil's written work from a school in England. Transcribe the pupil's writing exactly as written, including their spelling mistakes, punctuation and paragraph breaks. Do not correct anything. Do not add a title or comments. Leave out crossed-out words, page numbers and teacher marks. If there is no readable pupil writing, return an empty string.
Return only JSON: {"text": "the transcription"}`;
    const raw = await callGemini(prompt, { temperature: 0, image: { mime: m[1], data: m[2] } });
    const text = String(raw?.text || "").trim();
    if (!text) return res.status(422).json({ error: "I couldn't read any writing in this photo. Try a clearer, closer photo in good light." });
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Something went wrong" });
  }
};

module.exports.config = { maxDuration: 60 };
