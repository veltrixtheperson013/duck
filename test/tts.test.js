import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeVoiceAudio } from "../src/core.js";

test("Free Flux TTS uses OpenRouter speech with the Cole voice", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousSite = process.env.OPENROUTER_SITE_URL;
  const previousName = process.env.OPENROUTER_APP_NAME;
  let request;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.OPENROUTER_SITE_URL = "https://duck.example";
  process.env.OPENROUTER_APP_NAME = "Duck Test";
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  try {
    const audio = await synthesizeVoiceAudio("hello pond");
    assert.deepEqual([...audio], [1, 2, 3]);
    assert.equal(request.url, "https://openrouter.ai/api/v1/audio/speech");
    assert.equal(request.options.headers.Authorization, "Bearer test-openrouter-key");
    assert.equal(request.options.headers["X-OpenRouter-Title"], "Duck Test");
    assert.deepEqual(request.body, { model: "deepgram/flux-tts:free", input: "hello pond", voice: "flux-cole-en", response_format: "mp3" });
  } finally {
    globalThis.fetch = previousFetch;
    previousKey == null ? delete process.env.OPENROUTER_API_KEY : process.env.OPENROUTER_API_KEY = previousKey;
    previousSite == null ? delete process.env.OPENROUTER_SITE_URL : process.env.OPENROUTER_SITE_URL = previousSite;
    previousName == null ? delete process.env.OPENROUTER_APP_NAME : process.env.OPENROUTER_APP_NAME = previousName;
  }
});

test("Flux TTS retries one empty successful response instead of silently returning nothing", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(calls === 1 ? new Uint8Array() : Uint8Array.from([9, 8, 7]), { status: 200, headers: { "Content-Type": "audio/mpeg", "X-Generation-Id": `gen_${calls}` } });
  };
  try {
    assert.deepEqual([...(await synthesizeVoiceAudio("retry the quack"))], [9, 8, 7]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    previousKey == null ? delete process.env.OPENROUTER_API_KEY : process.env.OPENROUTER_API_KEY = previousKey;
  }
});
