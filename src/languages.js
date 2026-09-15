// September 22, 2026, midnight America/Los_Angeles. Evaluate per request so
// already-running deployments unlock without another restart or command sync.
export const MULTILINGUAL_RELEASE_AT = Date.parse("2026-09-22T07:00:00Z");
export const MULTILINGUAL_RELEASE_LABEL = "September 22, 2026 (00:00 Pacific)";
const codes = "af sq am ar hy as ay az bm eu be bn bho bs bg ca ceb ny zh-CN zh-TW co hr cs da dv doi nl en eo et ee fil fi fr fy gl ka de el gn gu ht ha haw he hi hmn hu is ig ilo id ga it ja jv kn kk km rw gom ko kri ku ckb ky lo la lv ln lt lb mk mai mg ms ml mt mi mr mni-Mtei lus mn my ne no or om ps fa pl pt pa qu ro ru sm sa gd nso sr st sn sd si sk sl so es su sw sv tl tg ta tt te th ti ts tr tk ak uk ur ug uz vi cy xh yi yo zu".split(" ");
const names = new Intl.DisplayNames(["en"], { type: "language" });
const nativeNames = (code) => {
  try { return new Intl.DisplayNames([code], { type: "language" }).of(code); } catch { return names.of(code); }
};
export const LANGUAGES = Object.freeze(codes.map((code) => Object.freeze({ code, name: names.of(code), nativeName: nativeNames(code) })));
export function multilingualEnabled(now = Date.now()) { return now >= MULTILINGUAL_RELEASE_AT; }
export function requireMultilingual(now = Date.now()) {
  if (!multilingualEnabled(now)) throw new Error(`Multilingual chat and translation are scheduled for ${MULTILINGUAL_RELEASE_LABEL}.`);
}
export function resolveLanguage(value) {
  const input = String(value || "").trim().toLowerCase();
  return LANGUAGES.find((item) => [item.code, item.name, item.nativeName].some((label) => label.toLowerCase() === input)) || null;
}
export function languageChoices(query = "") {
  const input = String(query).trim().toLowerCase();
  return LANGUAGES.filter((item) => `${item.code} ${item.name} ${item.nativeName}`.toLowerCase().includes(input)).slice(0, 25).map((item) => ({ name: `${item.name} · ${item.nativeName} (${item.code})`.slice(0, 100), value: item.code }));
}
export function languagePrompt(language, now = Date.now()) {
  if (!multilingualEnabled(now)) return "";
  const selected = resolveLanguage(language);
  return `${selected ? `Reply in ${selected.name} (${selected.code}).` : "Reply in the language of the user's latest request unless they explicitly request another language."} Preserve code, URLs, Discord mentions, command names and tool identifiers exactly. Language preferences do not change permissions or approval requirements. If you cannot reliably use the requested language, say so instead of inventing a translation.`;
}
