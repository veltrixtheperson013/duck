import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDuckWebsiteServer } from "../src/web.js";

async function withWebsite(run) {
  const server = createDuckWebsiteServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("website serves the homepage, privacy policy, assets, and health route", async () => {
  await withWebsite(async (origin) => {
    const homepage = await fetch(`${origin}/`);
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /Add Duck to Discord/);
    assert.match(homepage.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(homepage.headers.get("etag"), /^".+"$/);

    const unchanged = await fetch(`${origin}/`, { headers: { "If-None-Match": homepage.headers.get("etag") } });
    assert.equal(unchanged.status, 304);

    const privacy = await fetch(`${origin}/privacy-policy`);
    assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /Third-party AI providers/);

    const guide = await fetch(`${origin}/guide`);
    assert.equal(guide.status, 200);
    const guideText = await guide.text();
    assert.match(guideText, /Set up your pond/);
    assert.match(guideText, /Commands and tools/);
    assert.doesNotMatch(guideText, /Configure the environment|Choose an AI provider|Configure voice and TTS|Troubleshooting/);
    assert.equal((await fetch(`${origin}/guide.html`)).status, 200);
    assert.equal((await fetch(`${origin}/privacy-policy.html`)).status, 200);

    const css = await fetch(`${origin}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/);

    const script = await fetch(`${origin}/site.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/);

    const health = await fetch(`${origin}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: "duck" });
  });
});

test("website rejects unsupported methods and unknown routes", async () => {
  await withWebsite(async (origin) => {
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    assert.equal((await fetch(`${origin}/`, { method: "POST" })).status, 405);
  });
});

test("public pages contain no GitHub references", async () => {
  const pages = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/privacy-policy.html", import.meta.url), "utf8"),
    readFile(new URL("../public/guide.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/site.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(pages.join("\n"), /github/i);
  assert.doesNotMatch(pages.slice(0, 3).join("\n"), /(?:href|src)="\/(?:styles\.css|site\.js)"/);
});
