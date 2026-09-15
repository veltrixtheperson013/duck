import assert from "node:assert/strict";
import test from "node:test";
import { LANGUAGES, MULTILINGUAL_RELEASE_AT, multilingualEnabled, requireMultilingual, resolveLanguage, languageChoices, languagePrompt } from "../src/languages.js";
import { personalAnswer } from "../src/personal-app.js";

test("multilingual rollout is closed before the release and opens at the exact boundary", () => {
  assert.equal(multilingualEnabled(MULTILINGUAL_RELEASE_AT - 1), false);
  assert.throws(() => requireMultilingual(MULTILINGUAL_RELEASE_AT - 1), /September 22/);
  assert.equal(languagePrompt("fr", MULTILINGUAL_RELEASE_AT - 1), "");
  assert.equal(multilingualEnabled(MULTILINGUAL_RELEASE_AT), true);
  assert.match(languagePrompt("fr", MULTILINGUAL_RELEASE_AT), /French/);
  assert.match(languagePrompt(null, MULTILINGUAL_RELEASE_AT), /latest request/);
});

test("language lookup supports 100+ choices without exceeding Discord autocomplete limits", () => {
  assert.ok(LANGUAGES.length >= 100);
  assert.equal(new Set(LANGUAGES.map((item) => item.code)).size, LANGUAGES.length);
  assert.equal(resolveLanguage("French").code, "fr");
  assert.equal(resolveLanguage("français").code, "fr");
  assert.equal(resolveLanguage("unsupported-language"), null);
  assert.ok(languageChoices().length <= 25);
  assert.ok(languageChoices("japanese").some((item) => item.value === "ja"));
});

test("translation is gated before network access and sends no tools after release", async () => {
  const previousNow = Date.now;
  const previousKey = process.env.OPENROUTER_API_KEY;
  let calls = 0;
  const context = { userId: "translation-test", translationTarget: "fr", webEnabled: true };
  const fetchImpl = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content, /Translate the user message into French/);
    assert.equal(body.messages[1].content, "Hello");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Bonjour" } }] });
  };
  try {
    Date.now = () => MULTILINGUAL_RELEASE_AT - 1;
    await assert.rejects(personalAnswer("Hello", "professional", context, fetchImpl), /scheduled/);
    assert.equal(calls, 0);
    Date.now = () => MULTILINGUAL_RELEASE_AT;
    process.env.OPENROUTER_API_KEY = "test-only";
    assert.equal(await personalAnswer("Hello", "professional", context, fetchImpl), "Bonjour");
    assert.equal(calls, 1);
  } finally {
    Date.now = previousNow;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
  }
});
