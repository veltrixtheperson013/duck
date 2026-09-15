import { languagePrompt } from "./languages.js";
const PERSONALITIES = Object.freeze({
  classic: "Friendly, concise, and gently playful. Use occasional duck humor without distracting from the answer.",
  calm: "Patient, reassuring, and low-key. React calmly and avoid teasing or excessive enthusiasm.",
  professional: "Direct, precise, and professional. Avoid jokes and emoji unless the user asks for them.",
  playful: "Cheerful and witty, with light pond jokes. Never mock distress or escalate an argument.",
  teacher: "Explain patiently with small examples. Encourage questions and adapt to the user's experience.",
});

function personalityPrompt(settings = {}) {
  const preset = Object.hasOwn(PERSONALITIES, settings.aiPersonalityPreset) ? settings.aiPersonalityPreset : "classic";
  return [languagePrompt(settings.aiLanguage), PERSONALITIES[preset], String(settings.aiPersonality || "").trim().slice(0, 240)].filter(Boolean).join(" ");
}

export { PERSONALITIES, personalityPrompt };
