const state = { me: null, guilds: [], catalog: null, activeGuild: null, activePlus: false, serverFilter: "all" };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const requestedGuildId = location.pathname.match(/^\/dashboard\/servers\/(\d{10,})\/?$/)?.[1] ?? new URLSearchParams(location.search).get("guild");
if (requestedGuildId) document.body.classList.add("settings-page-loading");

function notice(message, error = false) { const element = $("[data-notice]"); element.textContent = message; element.classList.toggle("is-error", error); element.hidden = !message; }
async function api(url, options = {}) { const headers = { Accept: "application/json", ...options.headers }; if (state.me?.csrf && !["GET", "HEAD"].includes(options.method || "GET")) headers["X-Duck-CSRF"] = state.me.csrf; const response = await fetch(url.startsWith("/") ? url : `/${url}`, { cache: "no-store", ...options, headers }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`); return body; }

function guildIcon(guild) {
  if (!guild.icon) { const fallback = document.createElement("span"); fallback.className = "server-fallback"; fallback.textContent = guild.name.slice(0, 2).toUpperCase(); return fallback; }
  const image = document.createElement("img"); image.src = `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.webp?size=128`; image.alt = ""; image.loading = "lazy"; image.decoding = "async"; return image;
}

function renderGuilds(search = $("[data-server-search]")?.value || "") {
  const term = search.trim().toLowerCase(); const list = $("[data-server-list]"); const fragment = document.createDocumentFragment(); list.replaceChildren();
  const visible = state.guilds.filter((guild) => guild.name.toLowerCase().includes(term) && (state.serverFilter === "all" || (state.serverFilter === "manageable" && guild.canManage) || (state.serverFilter === "installed" && guild.botPresent)));
  for (const [index, guild] of visible.entries()) {
    const card = document.createElement("article"); const details = document.createElement("div"); const heading = document.createElement("h3"); const copy = document.createElement("p"); const badges = document.createElement("div"); const button = document.createElement("button");
    card.className = `server-card is-entering${guild.botPresent ? " has-duck" : ""}`; card.style.setProperty("--card-delay", `${Math.min(index, 6) * 18}ms`); heading.textContent = guild.name; copy.textContent = guild.botPresent ? (guild.canManage ? "Ready for server-specific configuration" : "Ask an admin for Manage Server permission") : "Invite Duck before configuring this server";
    badges.className = "server-badges"; const role = document.createElement("span"); role.textContent = guild.owner ? "Owner" : guild.isAdministrator ? "Administrator" : guild.canManage ? "Manager" : "Member"; const presence = document.createElement("span"); presence.className = guild.botPresent ? "is-present" : "is-absent"; presence.textContent = guild.botPresent ? "Duck online" : "Duck absent"; badges.append(role, presence);
    button.className = `button ${guild.botPresent ? "secondary" : "primary"}`; button.textContent = guild.botPresent ? "Configure server" : "Invite Duck"; button.disabled = guild.botPresent && !guild.canManage; button.addEventListener("click", () => guild.botPresent ? location.assign(`/dashboard/servers/${encodeURIComponent(guild.id)}`) : location.assign(guild.inviteUrl));
    details.append(heading, copy, badges); card.append(guildIcon(guild), details, button); fragment.append(card);
  }
  list.append(fragment);
  if (!list.children.length) { const empty = document.createElement("div"); empty.className = "empty-state"; const bird = document.createElement("span"); const title = document.createElement("strong"); const copy = document.createElement("p"); bird.textContent = "🪿"; bird.setAttribute("aria-hidden", "true"); title.textContent = "No servers found"; copy.textContent = "Try another search or filter. That is a goose, so the duck is clearly elsewhere."; empty.append(bird, title, copy); list.append(empty); }
}

function selectTab(name) {
  $$("[data-settings-tab]").forEach((button) => { const active = button.dataset.settingsTab === name; button.classList.toggle("is-active", active); button.setAttribute("aria-selected", String(active)); });
  $$("[data-settings-panel]").forEach((panel) => { const active = panel.dataset.settingsPanel === name; panel.classList.toggle("is-active", active); panel.hidden = !active; });
}

function normalizeCatalog(catalog, settings) { const normalize = (items, selected, label) => Array.isArray(items) && items.length ? items : selected ? [{ id: selected, label, tier: "free", disclaimer: "Provider details are temporarily unavailable." }] : []; return { ai: normalize(catalog?.ai, settings.aiModel, "Current AI model"), tts: normalize(catalog?.tts, settings.ttsModel, "Current TTS model") }; }
function fillModelSelect(select, models = [], selected, plus) { select.replaceChildren(...models.map((model) => { const option = document.createElement("option"); option.value = model.id; option.textContent = `${model.label}${model.tier === "plus" ? " — Plus" : ""}`; option.disabled = model.tier === "plus" && !plus && model.id !== selected; option.selected = model.id === selected; return option; })); }
function fillChannelSelect(select, channels = [], selected) { const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Not configured"; const options = channels.map((channel) => { const option = document.createElement("option"); option.value = channel.id; option.textContent = `# ${channel.name}`; return option; }); select.replaceChildren(empty, ...options); select.value = selected || ""; }
function updateDisclaimers() { const form = $("[data-settings-form]"); $("[data-ai-disclaimer]").textContent = state.catalog?.ai?.find(({ id }) => id === form.aiModel.value)?.disclaimer || ""; $("[data-tts-disclaimer]").textContent = state.catalog?.tts?.find(({ id }) => id === form.ttsModel.value)?.disclaimer || ""; }
function formatBillingDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(date); }

async function openSettings(guild) {
  notice("");
  try {
    const data = await api(`api/guilds/${guild.id}/settings`); state.activeGuild = guild;
    const form = $("[data-settings-form]"); const settings = data.settings ?? {}; const subscription = settings.subscription ?? { tier: "free", status: "inactive", source: null, expiresAt: null, cancelAtPeriodEnd: false }; const plus = subscription.tier === "plus"; state.activePlus = plus;
    state.catalog = normalizeCatalog(data.models, settings);
    $("[data-dialog-title]").textContent = guild.name;
    for (const key of ["aiChatEnabled", "aiVisionEnabled", "ttsEnabled", "ttsAnnounceNames"]) form[key].checked = settings[key];
    for (const key of ["capabilityMode", "commandPrefix", "aiChannelMode", "aiContextMode", "aiResponseStyle", "aiPersonality", "welcomeMessage", "farewellMessage"]) form[key].value = settings[key];
    form.capabilityMode.disabled = !data.isAdministrator; form.commandPrefix.disabled = !data.isAdministrator;
    fillModelSelect(form.aiModel, state.catalog.ai, settings.aiModel, plus); fillModelSelect(form.ttsModel, state.catalog.tts, settings.ttsModel, plus);
    for (const select of $$('[data-channel-select]')) fillChannelSelect(select, data.channels ?? [], settings[select.name]);
    form.aiResponseStyle.querySelector('option[value="detailed"]').disabled = !plus; form.aiPersonality.disabled = !plus;
    $("[data-plan-pill]").textContent = plus ? "Plus plan" : "Free plan"; $("[data-plan-pill]").classList.toggle("is-plus", plus); $("[data-billing-title]").textContent = plus ? "Duck Plus" : "Duck Free";
    $("[data-plus-copy]").textContent = plus ? (subscription.cancelAtPeriodEnd ? "Your subscription is canceled and remains active until the date below." : subscription.source === "owner" ? "Complimentary owner Plus is active for this server." : "Your subscription is active. Thank you for supporting Duck!") : !data.plusEnabled ? "Duck Plus is currently unavailable." : data.billingConfigured ? "Unlock premium models, custom personality, larger limits, and priority processing." : "Plus checkout is being configured.";
    const billingDate = $("[data-billing-date]"); const formattedDate = formatBillingDate(subscription.expiresAt); billingDate.textContent = formattedDate ? `${subscription.cancelAtPeriodEnd ? "Access ends" : "Renews"} ${formattedDate}` : ""; billingDate.hidden = !formattedDate;
    $("[data-billing-help]").textContent = plus ? (subscription.source === "owner" ? "Complimentary owner access does not renew or require payment." : "Payment details, invoices, and cancellation are always available here.") : !data.plusEnabled ? "Free features remain available while Plus is offline." : "Subscriptions belong to this Discord server, not your entire account.";
    $("[data-upgrade-month]").hidden = plus || !data.billingConfigured; $("[data-upgrade-year]").hidden = plus || !data.billingConfigured; $("[data-manage-billing]").hidden = !data.canManageSubscription; $("[data-cancel-subscription]").hidden = !data.canCancelSubscription;
    updateDisclaimers(); selectTab("general"); document.title = `${guild.name} — Duck Dashboard`; document.body.classList.remove("settings-page-loading"); document.body.classList.add("settings-page-open"); const dialog = $("[data-settings-dialog]"); dialog.showModal(); dialog.classList.remove("is-opening"); requestAnimationFrame(() => dialog.classList.add("is-opening"));
  } catch (error) { document.body.classList.remove("settings-page-loading"); notice(error.message, true); }
}

async function startCheckout(period) { try { const data = await api(`api/guilds/${state.activeGuild.id}/billing/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period }) }); location.assign(data.url); } catch (error) { notice(error.message, true); } }
async function manageBilling() { try { const data = await api(`api/guilds/${state.activeGuild.id}/billing/portal`, { method: "POST" }); location.assign(data.url); } catch (error) { notice(error.message, true); } }
async function cancelSubscription() { try { const data = await api(`api/guilds/${state.activeGuild.id}/billing/cancel`, { method: "POST" }); location.assign(data.url); } catch (error) { notice(error.message, true); } }

async function initialize() {
  try {
    const [data, guildData] = await Promise.all([api("api/me"), api("api/guilds")]); state.me = data; const profile = $("[data-user-area]"); profile.replaceChildren(); const avatar = data.user.avatar ? document.createElement("img") : document.createElement("span");
    if (data.user.avatar) { avatar.src = `https://cdn.discordapp.com/avatars/${encodeURIComponent(data.user.id)}/${encodeURIComponent(data.user.avatar)}.webp?size=128`; avatar.alt = ""; } else { avatar.className = "profile-placeholder"; avatar.textContent = "🦆"; }
    const profileCopy = document.createElement("div"); const welcome = document.createElement("small"); const name = document.createElement("strong"); const logout = document.createElement("button"); welcome.textContent = data.isOwner ? "Duck owner" : "Signed in as"; name.textContent = data.user.globalName || data.user.username; logout.type = "button"; logout.textContent = "Log out"; logout.addEventListener("click", async () => { await api("auth/logout", { method: "POST" }); location.reload(); }); profileCopy.append(welcome, name); profile.append(avatar, profileCopy, logout);
    state.guilds = Array.isArray(guildData.guilds) ? guildData.guilds : []; $("[data-stat-total]").textContent = state.guilds.length; $("[data-stat-manage]").textContent = state.guilds.filter((guild) => guild.canManage).length; $("[data-stat-installed]").textContent = state.guilds.filter((guild) => guild.botPresent).length; $("[data-dashboard]").hidden = false; renderGuilds();
    if (requestedGuildId) { const guild = state.guilds.find(({ id }) => id === requestedGuildId); if (!guild?.botPresent || !guild.canManage) throw new Error("That server is unavailable or you do not have permission to configure it."); await openSettings(guild); }
  } catch (error) { document.body.classList.remove("settings-page-loading"); if (/sign in|session/i.test(error.message)) $("[data-login]").hidden = false; else notice(error.message, true); }
}

$("[data-server-search]").addEventListener("input", (event) => renderGuilds(event.target.value));
for (const button of $$("[data-server-filter]")) button.addEventListener("click", () => { state.serverFilter = button.dataset.serverFilter; $$("[data-server-filter]").forEach((item) => item.classList.toggle("is-active", item === button)); renderGuilds(); });
for (const button of $$("[data-settings-tab]")) button.addEventListener("click", () => selectTab(button.dataset.settingsTab));
for (const button of $$('[data-cancel], [data-back]')) button.addEventListener("click", () => location.assign("/dashboard")); $("[data-settings-form]").aiModel.addEventListener("change", updateDisclaimers); $("[data-settings-form]").ttsModel.addEventListener("change", updateDisclaimers);
$("[data-settings-form]").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = "Saving…"; const channelValue = (name) => form[name].value || null;
  try {
    await api(`api/guilds/${state.activeGuild.id}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiChatEnabled: form.aiChatEnabled.checked, aiVisionEnabled: form.aiVisionEnabled.checked, aiModel: form.aiModel.value, aiChannelMode: form.aiChannelMode.value, aiContextMode: form.aiContextMode.value, aiResponseStyle: form.aiResponseStyle.value, ...(state.activePlus ? { aiPersonality: form.aiPersonality.value } : {}), ttsEnabled: form.ttsEnabled.checked, ttsAnnounceNames: form.ttsAnnounceNames.checked, ttsModel: form.ttsModel.value, capabilityMode: form.capabilityMode.value, commandPrefix: form.commandPrefix.value, modChannelId: channelValue("modChannelId"), welcomeChannelId: channelValue("welcomeChannelId"), welcomeMessage: form.welcomeMessage.value, farewellMessage: form.farewellMessage.value, logChannelId: channelValue("logChannelId") }) });
    const saveState = $("[data-save-state]"); saveState.textContent = "Saved just now."; saveState.classList.remove("is-error");
  } catch (error) { const saveState = $("[data-save-state]"); saveState.textContent = error.message; saveState.classList.add("is-error"); } finally { submit.disabled = false; submit.textContent = "Save changes"; }
});
$("[data-upgrade-month]").addEventListener("click", () => startCheckout("month")); $("[data-upgrade-year]").addEventListener("click", () => startCheckout("year")); $("[data-manage-billing]").addEventListener("click", manageBilling); $("[data-cancel-subscription]").addEventListener("click", cancelSubscription);
initialize();
