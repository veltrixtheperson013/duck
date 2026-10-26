window.installPresetEditor = async function ({ api, guildId, isAdministrator }) {
  const host = document.querySelector("[data-preset-editor]");
  const generation = {}; host.duckPresetGeneration = generation;
  const isCurrent = () => host.duckPresetGeneration === generation;
  host.replaceChildren();
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
  if (!isAdministrator) { host.append(node("p", "An Administrator can configure presets and holiday schedules.")); return; }
  const output = node("p", "Loading presets..."); output.setAttribute("role", "status"); host.append(output);
  const makeInput = (type, value = "") => { const e = node("input"); e.type = type; e.value = value; e.dataset.presetInput = ""; return e; };
  const makeSelect = choices => { const e = node("select"); e.dataset.presetInput = ""; for (const [value, label] of choices) { const o = node("option", label); o.value = value; e.append(o); } return e; };
  const label = (text, control) => { const e = node("label", "", "preset-field"); e.append(node("span", text), control); return e; };
  const button = (text, callback, className = "button secondary compact") => { const e = node("button", text, className); e.type = "button"; e.addEventListener("click", callback); return e; };
  let data; let channelData;
  try { [data, channelData] = await Promise.all([api(`/api/guilds/${guildId}/presets`), api(`/api/guilds/${guildId}/settings`)]); } catch (error) { if (!isCurrent()) return; output.textContent = error.message; host.append(button("Retry loading presets", () => window.installPresetEditor({ api, guildId, isAdministrator }))); return; }
  // A late response from a previous server must never replace the current editor.
  if (!isCurrent()) return;
  const choose = makeSelect([["", "New custom preset"], ...data.templates.map(p => [`template:${p.id}`, `Template: ${p.name}`]), ...data.presets.map(p => [`saved:${p.id}`, `Saved: ${p.name}`])]);
  const id = makeInput("text"); id.maxLength = 40; id.placeholder = "community-layout";
  const name = makeInput("text"); name.maxLength = 100; name.placeholder = "My community layout";
  const grid = node("div", "", "preset-grid"); grid.append(label("Start from", choose), label("Preset ID", id), label("Display name", name));
  const rows = node("div", "", "preset-operations"); let sequence = 0;
  const channels = [...channelData.channels, ...channelData.categories];
  const channelChoices = [["", "Choose target"], ...channels.map(c => [c.id, `${c.name} (${c.id})`])];
  const updateParents = () => {
    const choices = [["", "No category"], ...channelData.categories.map(c => [`id:${c.id}`, c.name]), ...[...rows.children].filter(row => row.kind.value === "create_category").map(row => [`key:${row.dataset.key}`, `New category: ${row.channelName.value || row.dataset.key}`])];
    for (const row of rows.children) { const current = row.parent.value; row.parent.replaceChildren(...choices.map(([value, text]) => { const o = node("option", text); o.value = value; return o; })); row.parent.value = choices.some(([v]) => v === current) ? current : ""; }
  };
  const addRow = (op = {}) => {
    if (rows.children.length >= 25) { output.textContent = "A preset supports up to 25 operations."; return; }
    const row = node("div", "", "preset-operation"); do { sequence++; } while ([...rows.children].some(item => item.dataset.key === `category-${sequence}`)); row.dataset.key = op.key || `category-${sequence}`;
    row.kind = makeSelect([["create_category", "Create category"], ["create_text", "Create text channel"], ["create_voice", "Create voice channel"], ["rename", "Rename channel/category"], ["delete", "Delete channel/category"]]); row.kind.value = op.kind || "create_text";
    row.target = makeSelect(channelChoices); row.target.value = op.channelId || "";
    row.channelName = makeInput("text", op.name); row.channelName.maxLength = 100;
    row.parent = makeSelect([]);
    const targetField = label("Target", row.target), nameField = label("Name", row.channelName), parentField = label("Parent category", row.parent);
    const sync = () => { const existing = ["rename", "delete"].includes(row.kind.value); targetField.hidden = !existing; nameField.hidden = row.kind.value === "delete"; parentField.hidden = !["create_text", "create_voice"].includes(row.kind.value); updateParents(); };
    row.append(label("Operation", row.kind), targetField, nameField, parentField, button("Remove", () => { row.remove(); updateParents(); })); rows.append(row); sync();
    if (op.parentId) row.parent.value = `id:${op.parentId}`; if (op.parentKey) row.parent.value = `key:${op.parentKey}`;
    row.kind.addEventListener("change", sync); row.channelName.addEventListener("input", updateParents);
  };
  const enabled = makeInput("checkbox"); const automatic = makeInput("checkbox");
  const holiday = makeSelect([["halloween", "Halloween · October 31"], ["christmas", "Christmas · December 25"], ["new-year", "New Year · January 1"], ["valentine", "Valentine's Day · February 14"], ["custom", "Custom annual date"]]);
  const monthDay = makeInput("text", "10-31"); monthDay.placeholder = "MM-DD"; monthDay.maxLength = 5;
  const days = makeInput("number", "7"); days.min = "1"; days.max = "30";
  const notification = makeSelect([["", "Choose notification channel"], ...channelData.channels.map(c => [c.id, c.name])]);
  const schedule = node("div", "", "preset-grid"); schedule.append(label("Enable annual schedule", enabled), label("Holiday (UTC)", holiday), label("Custom date (MM-DD)", monthDay), label("Duration in days", days), label("Notification / approval channel", notification), label("Approve this exact plan to run automatically each year", automatic));
  const load = preset => {
    id.value = preset?.id || ""; name.value = preset?.name || ""; rows.replaceChildren(); sequence = 0;
    for (const op of preset?.operations || [{ kind: "create_text" }]) addRow(op);
    enabled.checked = Boolean(preset?.schedule?.enabled); automatic.checked = Boolean(preset?.schedule?.automatic); days.value = preset?.schedule?.durationDays || 7; notification.value = preset?.schedule?.channelId || ""; holiday.value = preset?.schedule ? "custom" : ["halloween", "christmas", "new-year"].includes(preset?.id) ? preset.id : "halloween"; monthDay.value = preset?.schedule?.monthDay || "10-31";
  };
  choose.addEventListener("change", () => { const [source, selected] = choose.value.split(":"); load((source === "saved" ? data.presets : data.templates).find(p => p.id === selected)); });
  const read = () => ({ id: id.value.trim(), name: name.value.trim(), operations: [...rows.children].map(row => ({ kind: row.kind.value, ...(row.kind.value === "create_category" ? { key: row.dataset.key } : {}), ...(["rename", "delete"].includes(row.kind.value) ? { channelId: row.target.value } : {}), ...(row.kind.value !== "delete" ? { name: row.channelName.value } : {}), ...(["create_text", "create_voice"].includes(row.kind.value) && row.parent.value ? row.parent.value.startsWith("id:") ? { parentId: row.parent.value.slice(3) } : { parentKey: row.parent.value.slice(4) } : {}) })), schedule: { enabled: enabled.checked, automatic: automatic.checked, holiday: holiday.value, monthDay: monthDay.value, durationDays: Number(days.value), channelId: notification.value } });
  const review = node("div", "", "preset-review"); review.hidden = true;
  const preview = node("pre"); let token = null;
  const approve = button("Approve these changes", async () => {
    if (!token) return; approve.disabled = true;
    try { const result = await api(`/api/guilds/${guildId}/presets/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }); token = null; review.hidden = true; output.textContent = result.result; const updated = await api(`/api/guilds/${guildId}/presets`); data = updated; choose.replaceChildren(...[["", "New custom preset"], ...data.templates.map(p => [`template:${p.id}`, `Template: ${p.name}`]), ...data.presets.map(p => [`saved:${p.id}`, `Saved: ${p.name}`])].map(([value, text]) => { const o = node("option", text); o.value = value; return o; })); if (data.presets.some(p => p.id === id.value.trim())) choose.value = `saved:${id.value.trim()}`; }
    catch (error) { token = null; review.hidden = true; output.textContent = error.message + " Prepare a new preview before retrying."; }
    finally { approve.disabled = false; }
  }, "button primary compact");
  review.append(node("h4", "Review before approval"), preview, approve, button("Cancel", () => { token = null; review.hidden = true; }));
  const prepare = async tool => {
    token = null; review.hidden = true; output.textContent = "Preparing preview...";
    try { const payload = { tool, presetId: id.value.trim(), ...(tool === "save_server_preset" ? { preset: read() } : {}) }; const result = await api(`/api/guilds/${guildId}/presets/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); token = result.token; preview.textContent = result.preview; review.hidden = false; output.textContent = "No changes have run. Review all operations below. Approval expires after five minutes."; }
    catch (error) { output.textContent = error.message; }
  };
  const actions = node("div", "", "preset-actions");
  actions.append(button("Preview save / schedule", () => prepare("save_server_preset")), button("Preview applying saved preset", () => prepare("apply_server_preset")), button("Preview restoration", () => prepare("restore_server_preset")), button("Preview deleting saved preset", () => prepare("delete_server_preset")));
  host.append(grid, node("h4", "Channel and category operations"), rows, button("Add operation", () => addRow()), node("h4", "Holiday schedule"), schedule, node("p", "Deleting an existing channel permanently removes its messages. Holiday schedules cannot delete existing channels. Restoration only removes empty channels created by Duck and restores names that have not been changed afterward."), actions, review);
  output.textContent = "Preset changes always require approval. Saving does not apply a preset immediately." + Object.entries(data.runs).map(([id, run]) => ` Active run: ${id} (${run.status})${run.expiresAt ? ", expires " + new Date(run.expiresAt).toLocaleString() : ""}.`).join(""); load(null);
};
