import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { statusTitle } from "./status-emojis.js";

const records = new Map();
const pending = new Map();
const labels = { search_web: "Searching the web", read_web_page: "Reading a webpage", calculate: "Calculating", file_metadata: "Checking file metadata", reverse_image_search: "Preparing an image search link" };
const row = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

export function createChatActivity(userId, publish, now = Date.now) {
  const started = now();
  const id = randomUUID();
  const events = [];
  let lastUpdate = -Infinity;
  let finished = false;
  let suspended = false;
  let waitingForApproval = false;
  let timer = null;
  let currentName = "thinking";
  let currentLabel = "Thinking";
  let publishing = Promise.resolve();
  const enqueueProgress = () => {
    publishing = publishing.then(async () => {
      if (finished || suspended || waitingForApproval) return;
      await publish({ content: null, embeds: [{ title: statusTitle(currentLabel, currentName === "thinking" ? "thinking" : "loading"), description: [...events.slice(-3).map(line => `\u2713 ${line}`), `-# Working \u00b7 ${seconds()}s`].join("\n"), color: 0x718096 }], components: [], allowedMentions: { parse: [] } });
    }).catch(() => {});
    return publishing;
  };
  const seconds = () => Math.max(1, Math.round((now() - started) / 1000));
  const activity = {
    async start() { suspended = false; if (!timer && !finished) { timer = setInterval(enqueueProgress, 2500); timer.unref?.(); } await activity.update("thinking"); },
    async stop() { suspended = true; clearInterval(timer); timer = null; await publishing; },
    async update(name, result) {
      if (finished) return;
      const label = name === "thinking" ? "Thinking" : name === "context" ? "Reading server context" : labels[name] || "Checking server information";
      currentName = name; currentLabel = label;
      if (result !== undefined) {
        const completed = result?.error ? `${label} — unsuccessful` : name === "search_web" ? `Found ${result?.results?.length || 0} search results` : name === "read_web_page" ? "Read a webpage" : name === "reverse_image_search" ? "Prepared an image search link" : result?.accepted ? "Prepared an action proposal (not executed)" : `${label} — complete`;
        events.push(completed);
        if (events.length > 24) events.shift();
      }
      if (name !== "thinking" && now() - lastUpdate < 1200) return;
      lastUpdate = now();
      await enqueueProgress();
    },
    finish(payload) {
      finished = true;
      clearInterval(timer); timer = null;
      const label = `Worked for ${seconds()}s`;
      for (const [key, value] of records) if (value.until < now()) records.delete(key);
      if (records.size >= 1000) records.delete(records.keys().next().value);
      records.set(id, { userId, label, events: [...events], until: now() + 15 * 60_000 });
      return { ...payload, components: [...(payload.components || []), new ActionRowBuilder().addComponents(row(`duck_activity:${id}`, `${label} ▾`))] };
    },
    async approveWeb(url) {
      if (pending.size >= 100) throw new Error("Too many web approvals are pending.");
      const requestId = randomUUID();
      let settle;
      const decision = new Promise((resolve) => { settle = resolve; });
      const timer = setTimeout(() => { pending.delete(requestId); settle(false); }, 60_000);
      timer.unref?.();
      pending.set(requestId, { userId, settle, timer });
      try {
        waitingForApproval = true; await publishing;
        await publish({ content: null, embeds: [{ title: statusTitle("Approve web access", "loading"), description: `Duck wants to send a GET request to:\n${url}\n\nThe URL, including any search query, will be sent to this website. Approve this request? Expires in 60 seconds.`, color: 0xd6a648 }], components: [new ActionRowBuilder().addComponents(row(`duck_web:yes:${requestId}`, "Approve once", ButtonStyle.Success), row(`duck_web:no:${requestId}`, "Deny", ButtonStyle.Secondary))], allowedMentions: { parse: [] } });
        const approved = await decision;
        events.push(approved ? "Web request approved" : "Web request denied or expired");
        return approved;
      } finally { waitingForApproval = false; clearTimeout(timer); pending.delete(requestId); }
    },
  };
  return activity;
}

export async function handleChatActivity(interaction) {
  if (interaction.customId.startsWith("duck_activity:")) {
    const record = records.get(interaction.customId.slice(14));
    const content = !record || record.until < Date.now() ? "This activity summary expired. Summaries last 15 minutes." : record.userId !== interaction.user.id ? "Only the person who asked Duck can view this activity summary." : `**${record.label}**\n${record.events.join("\n") || "Generated a response without calling tools."}`;
    await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return true;
  }
  if (!interaction.customId.startsWith("duck_web:")) return false;
  const [, choice, id] = interaction.customId.split(":");
  const request = pending.get(id);
  if (!request || request.userId !== interaction.user.id) {
    await interaction.reply({ content: request ? "Only the requester can approve this web request." : "This approval expired or was already used.", flags: MessageFlags.Ephemeral });
    return true;
  }
  pending.delete(id);
  clearTimeout(request.timer);
  try { await interaction.update({ components: [] }); } finally { request.settle(choice === "yes"); }
  return true;
}
