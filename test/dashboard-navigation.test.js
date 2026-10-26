import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/dashboard.js", import.meta.url), "utf8");
const navigation = source.slice(source.indexOf("// Keep server navigation"), source.indexOf("async function startCheckout"));
const guild = { id: "123456789012345678", botPresent: true, canManage: true };
function fixture(path = "/dashboard") {
  const nodes = new Map(); const events = {}; const visits = []; const notices = [];
  const location = { origin: "https://duck.example", pathname: path, search: "", reload() { visits.push("reload"); } };
  const update = value => { const url = new URL(value, location.origin); location.pathname = url.pathname; location.search = url.search; };
  const context = vm.createContext({ URL, location, settingsNavigationId: 0, dashboardRoute: path, savedSettingsSnapshot: "saved", state: { me: {}, guilds: [guild], activeGuild: guild },
    history: { pushState: (_, __, value) => { visits.push(["push", value]); update(value); }, replaceState: (_, __, value) => { visits.push(["replace", value]); update(value); } },
    window: { addEventListener: (name, fn) => { events[name] = fn; } },
    document: { title: "Dashboard", body: { classList: { remove() {} } } },
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, { hidden: false, inert: false }); return nodes.get(selector); },
    notice: (...args) => notices.push(args), refreshGuilds: async () => {}, canLeaveSettings: () => true,
  });
  context.openSettings = async requested => { context.settingsNavigationId++; context.state.activeGuild = requested; return true; };
  vm.runInContext(navigation, context);
  return { context, location, visits, notices, nodes, events, navigate: (value, mode) => context.navigateDashboard(value, mode) };
}

test("server selection updates history inside Duck and returning to the list needs no server request", async () => {
  const f = fixture();
  assert.equal(await f.navigate(`/dashboard/servers/${guild.id}`), true);
  assert.deepEqual(f.visits, [["push", `/dashboard/servers/${guild.id}`]]);
  f.context.openSettings = () => { throw Error("List navigation must use loaded data."); };
  assert.equal(await f.navigate("/dashboard"), true);
  assert.equal(f.location.pathname, "/dashboard"); assert.equal(f.context.state.activeGuild, null);
  assert.equal(f.nodes.get("[data-settings-page]").hidden, true);
  assert.ok(!f.visits.includes("reload"));
});

test("unavailable settings leave the current dashboard URL intact without reloading", async () => {
  const f = fixture(); f.context.openSettings = async () => { f.context.settingsNavigationId++; return false; };
  assert.equal(await f.navigate(`/dashboard/servers/${guild.id}`), false);
  assert.equal(f.location.pathname, "/dashboard"); assert.deepEqual(f.visits, []);
});

test("browser back and forward use cached list state and preserve unsaved settings when canceled", async () => {
  const path = `/dashboard/servers/${guild.id}`; const f = fixture(path);
  f.location.pathname = "/dashboard"; await f.events.popstate();
  assert.equal(f.context.state.activeGuild, null); assert.equal(f.context.dashboardRoute, "/dashboard");
  f.location.pathname = path; await f.context.navigateDashboard(path, "none");
  f.context.savedSettingsSnapshot = "saved";
  f.context.canLeaveSettings = discard => { assert.equal(discard, false); return false; };
  f.location.pathname = "/dashboard"; await f.events.popstate();
  assert.equal(f.location.pathname, path); assert.equal(f.context.savedSettingsSnapshot, "saved");
  assert.ok(!f.visits.includes("reload"));
});

test("late navigation failures cannot replace a newer successful route", async () => {
  const f = fixture(); let complete;
  f.context.openSettings = () => { f.context.settingsNavigationId++; return new Promise(resolve => { complete = resolve; }); };
  f.location.pathname = `/dashboard/servers/${guild.id}`;
  const pending = f.navigate(f.location.pathname, "none");
  await f.navigate("/dashboard"); complete(false); await pending;
  assert.equal(f.location.pathname, "/dashboard"); assert.deepEqual(f.visits.at(-1), ["push", "/dashboard"]);
});

test("server navigation rejects external URLs and unauthorized servers and supports old guild links", async () => {
  const f = fixture(); let loads = 0;
  f.context.openSettings = async () => { loads++; f.context.settingsNavigationId++; return true; };
  assert.equal(await f.navigate(`https://evil.example/dashboard/servers/${guild.id}`), false);
  assert.equal(await f.navigate("/dashboard/servers/999999999999999999"), false);
  assert.equal(loads, 0); assert.equal(f.location.pathname, "/dashboard");
  assert.equal(await f.navigate(`/dashboard?guild=${guild.id}`), true);
  assert.equal(loads, 1); assert.equal(f.location.pathname, `/dashboard/servers/${guild.id}`);
});

test("an HTML host outage stays a retryable API error and never repeats a settings save", async () => {
  const apiSource = source.slice(source.indexOf("async function api("), source.indexOf("function guildIcon("));
  for (const method of ["GET", "PUT"]) {
    let calls = 0; let loading = 0;
    const context = vm.createContext({ AbortController, setTimeout, clearTimeout, Error, TypeError, SyntaxError, state: { me: null }, setLoading: active => { loading += active ? 1 : -1; }, fetch: async () => { calls++; return new Response("<html>Web server isn't running</html>", { status: 502, headers: { "content-type": "text/html" } }); } });
    vm.runInContext(apiSource, context);
    await assert.rejects(context.api(`/api/guilds/${guild.id}/settings`, { method }), /website is temporarily unavailable/);
    assert.equal(calls, 1); assert.equal(loading, 0);
  }
});

test("a previous server's preset success or failure cannot overwrite a newer editor", async () => {
  const presetSource = await readFile(new URL("../public/presets.js", import.meta.url), "utf8");
  for (const fail of [false, true]) {
    const host = { children: [], replaceChildren() { this.children = []; }, append(...nodes) { this.children.push(...nodes); } };
    const context = vm.createContext({ window: {}, document: { querySelector: () => host, createElement: tag => ({ tag, textContent: "", append() {}, setAttribute() {}, addEventListener() {} }) } });
    vm.runInContext(presetSource, context); let finish;
    const response = new Promise((resolve, reject) => { finish = fail ? () => reject(Error("Old server offline")) : () => resolve({}); });
    const pending = context.window.installPresetEditor({ api: () => response, guildId: guild.id, isAdministrator: true });
    await context.window.installPresetEditor({ api: async () => ({}), guildId: "223456789012345678", isAdministrator: false });
    const visible = host.children[0]; finish(); await pending;
    assert.equal(host.children.length, 1); assert.equal(host.children[0], visible);
    assert.match(visible.textContent, /Administrator/);
  }
});
