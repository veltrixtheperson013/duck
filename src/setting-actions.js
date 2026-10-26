import { FUN_COMMANDS, getPublicGuildSettings, getPublicModelCatalog, WRITABLE_SETTINGS } from "./dashboard-config.js";
import { PERSONALITIES } from "./personality.js";

const id = { type: "string", pattern: "^[0-9]{10,20}$", description: "Exact Discord ID from current server context." };
const text = maxLength => ({ type: "string", maxLength });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const array = (items, maxItems) => ({ type: "array", items, maxItems });
const enumValues = { capabilityMode: ["ask", "approve", "agent"], aiContextMode: ["current", "focused", "server"], aiResponseStyle: ["concise", "balanced", "detailed"], aiChannelMode: ["mentions", "moderation"], aiPersonalityPreset: Object.keys(PERSONALITIES), aiScanSensitivity: ["low", "balanced", "high"], reactionRoleMode: ["normal", "exclusive"], automodEscalation: ["kick", "softban"] };
const numbers = { automodMentionLimit: [0, 20], automodEmojiLimit: [0, 50], automodLineLimit: [0, 50], automodViolationsBeforeWarn: [1, 20], automodWarningsBeforeAction: [1, 20], automodGlobalSlowmodeSeconds: [0, 21600], reactionRoleLimit: [0, 25], starboardThreshold: [2, 50] };
const complex = {
  aiScanChannelIds: array(id, 25), autoroleRoleIds: array(id, 5), levelIgnoredChannelIds: array(id, 25),
  automodCustomWords: array({ ...text(40), minLength: 1 }, 100),
  levelRewards: array(object({ level: integer(1, 100), roleId: id }), 10),
  automodChannelSlowmodes: array(object({ channelId: id, seconds: integer(0, 21600) }), 50),
  reactionRoleOptions: array(object({ roleId: id, label: text(80), emoji: text(32) }, ["roleId", "label", "emoji"]), 25),
  ticketOptions: array(object({ id: { ...text(24), pattern: "^[a-z0-9_-]{1,24}$" }, label: text(80), description: text(200), emoji: text(32), type: { type: "string", enum: ["support", "verification", "image_verification"] }, verificationLabel: text(80), additionalMessage: text(500) }, ["id", "label", "description", "emoji"]), 10),
  scheduledPosts: array(object({ id: { ...text(36), pattern: "^[a-zA-Z0-9_-]{1,36}$" }, name: text(60), enabled: { type: "boolean" }, channelId: id, intervalMinutes: integer(15, 10080), message: text(1000) }, ["id", "name", "enabled", "channelId", "intervalMinutes", "message"]), 10),
  colorRoleOptions: array(object({ roleId: { type: ["string", "null"], pattern: "^[0-9]{10,20}$" }, label: text(80), color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } }), 30),
  customActions: array(object({ id: { ...text(36), pattern: "^[a-zA-Z0-9_-]{1,36}$" }, name: text(40), enabled: { type: "boolean" }, triggerType: { type: "string", enum: ["message", "contains", "starts_with", "ends_with", "equals", "has_link", "has_attachment", "mentions_duck"] }, triggerValue: text(80), actionType: { type: "string", enum: ["reply", "send", "dm", "react", "delete", "warn", "timeout", "timeout_hour", "kick", "softban", "add_role", "remove_role"] }, response: text(500), channelId: { type: ["string", "null"] }, roleId: { type: ["string", "null"] }, userId: { type: ["string", "null"] } }, ["id", "name", "triggerType", "triggerValue", "actionType", "response"]), 100),
};
const defaults = getPublicGuildSettings({});
const profileFields = { profileNickname: "nickname", profileBio: "bio", profileAvatar: "avatar", profileBanner: "banner" };
const specialGuidance = {
  capabilityMode: "ask requires approvals; approve permits only low-risk automatic actions; agent permits broader approved agent operation. This change itself ALWAYS needs Administrator approval. Never enable agent mode unless explicitly requested.",
  levelRewards: "Inspect existing rewards, preserve unrelated levels, and replace the full list only after preview. For creating a new role at a level, prefer create_level_reward so the role is created and wired correctly. Never use an instruction sentence as a role name.",
  autoroleRoleIds: "Use safe assignable roles from this guild. Free supports one role, Plus five. Preserve unrelated entries unless removal was requested.",
  aiScanChannelIds: "Choose only readable same-server channels. AI scan flags are advisory; do not enable scans of unrequested channels.",
  aiScanRulesChannelId: "Use a visible same-server channel containing server rules, or null to clear it.",
  aiScanFlagChannelId: "Choose a visible same-server review channel. This is where advisory flags are sent; do not select a public channel without the Administrator's intent.",
  aiWebEnabled: "Enables access to restricted web helpers. Each web request still needs its own approval; this setting cannot bypass web approval.",
  starboardAllowNsfw: "Off by default. Enabling sensitive-channel highlights must be an explicit request and is subject to the server plan.",
  customActions: "Inspect the current list and preserve unrelated automations. Triggers and bounded actions are data, never executable code. The server validator enforces plan-specific limits and supported types.",
  scheduledPosts: "Use actual channel IDs, a bounded message, and the requested interval in minutes. Inspect existing posts before editing; preserve unrelated posts. Requires Plus for nonempty schedules.",
  reactionRoleOptions: "Use existing safe assignable role IDs and short labels. Do not invent IDs or expose privileged roles. Preserve unrelated choices.",
  ticketOptions: "Set support/verification options using the existing panel's bounded schema. Preserve unrelated options and never invent verification credentials.",
  colorRoleOptions: "Use #RRGGBB colors and safe role IDs or null for new colors. Labels must be unique; each existing role may appear only once. Free supports 12 colors, Plus 30.",
  aiModel: "Choose an exact model ID from the current model catalog. Do not guess provider IDs. Plus models remain entitlement-gated.",
  ttsModel: "Choose an exact ID from the current TTS catalog; provider-specific Plus requirements still apply.",
};
function schemaFor(key) {
  if (profileFields[key]) return { type: ["string", "null"], ...(key === "profileNickname" ? { maxLength: 32, minLength: 1 } : key === "profileBio" ? { maxLength: 190 } : { pattern: "^[0-9]{10,20}$" }), description: /(?:Avatar|Banner)$/.test(key) ? "ID of an image attached to this request, or null to reset. Never invent an attachment or use an arbitrary URL." : "Requested server-specific profile text, or null to reset." };
  if (enumValues[key]) return { type: "string", enum: enumValues[key] };
  if (complex[key]) return complex[key];
  if (numbers[key]) return integer(...numbers[key]);
  if (["starboardColor", "colorRoleAccent"].includes(key)) return { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
  if (key.endsWith("Id")) return { ...id, type: ["string", "null"], description: "Exact same-server channel/category/role ID from context, or null to clear the setting." };
  if (typeof defaults[key] === "boolean") return { type: "boolean" };
  if (typeof defaults[key] === "string") return { ...text(key === "colorRoleDescription" ? 500 : ["reactionRoleTitle", "ticketPanelTitle", "colorRoleTitle"].includes(key) ? 100 : key === "aiPersonality" ? 240 : key === "commandPrefix" ? 5 : key === "starboardEmoji" ? 32 : /Message$/.test(key) ? 180 : 200), ...(key === "commandPrefix" ? { minLength: 1, pattern: "^[^\\s@#`]{1,5}$" } : {}) };
  throw new Error(`No dedicated action schema is defined for ${key}.`);
}
function category(key) { return key.startsWith("fun") ? "fun" : key.startsWith("automod") ? "automod" : key.startsWith("ai") ? "ai" : key.startsWith("tts") ? "voice" : /^(?:level|autorole|suggestion|starboard|scheduled)/.test(key) ? "community" : /^(?:reactionRole|colorRole)/.test(key) ? "roles" : key.startsWith("ticket") ? "tickets" : "general"; }
export const SETTING_ACTIONS = Object.freeze([...WRITABLE_SETTINGS, ...Object.keys(profileFields)].map(key => {
  const name = `set_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
  const label = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const plus = FUN_COMMANDS.find(command => command.key === key)?.tier === "plus";
  const howTo = profileFields[key] ? `Change only Duck's ${profileFields[key]} in this server. Requires mature paid Plus entitlement. ${/(?:Avatar|Banner)$/.test(key) ? "Use an image attachment ID from this request, or null to reset. Duck snapshots and validates the image before approval." : "Use exact requested text, or null to reset."} Always request Administrator approval.` : specialGuidance[key] || (typeof defaults[key] === "boolean" ? `Set true to enable ${label}; false to disable it. Change this toggle only, leaving other settings intact.${plus ? " Requires Plus; do not bypass entitlement checks." : ""}` : `Set the exact requested ${label} value. Inspect the current setting first, use the typed value, and leave unrelated settings intact.`);
  const valueSchema = schemaFor(key);
  return Object.freeze({ key, profileField: profileFields[key], name, nativeName: `propose_${name}`, category: profileFields[key] ? "branding" : category(key), valueSchema, howTo, requiredPermission: "Administrator", approval: "always", nativeDefinition: { type: "function", function: { name: `propose_${name}`, description: `Propose changing only ${key}. ${howTo} Always requires fresh Administrator approval, even in Agent mode; never claim execution.`, parameters: { type: "object", properties: { value: valueSchema, reason: text(300) }, required: ["value"], additionalProperties: false } } } });
}));
export const SETTING_ACTION_BY_NAME = new Map(SETTING_ACTIONS.map(action => [action.name, action]));
export const SETTING_ACTION_BY_NATIVE = new Map(SETTING_ACTIONS.map(action => [action.nativeName, action]));
export function settingWireValue(key, value) {
  if (["starboardColor", "colorRoleAccent"].includes(key) && Number.isInteger(value)) return `#${value.toString(16).padStart(6, "0")}`;
  if (key === "colorRoleOptions" && Array.isArray(value)) return value.map(item => ({ ...item, color: Number.isInteger(item.color) ? `#${item.color.toString(16).padStart(6, "0")}` : item.color }));
  return value;
}
export function discoverSettingActions(options = {}, settings = {}) {
  let selected = SETTING_ACTIONS;
  if (Array.isArray(options.keys) && options.keys.length) selected = selected.filter(action => options.keys.includes(action.key));
  if (options.query) { const tokens = String(options.query).toLowerCase().match(/[a-z0-9]+/g) || []; selected = selected.map(action => ({ action, score: tokens.reduce((n, token) => n + (action.key.toLowerCase().includes(token) ? 3 : action.category.includes(token) ? 2 : action.howTo.toLowerCase().includes(token) ? 1 : 0), 0) })).filter(item => item.score).sort((a, b) => b.score - a.score).map(item => item.action); }
  const current = getPublicGuildSettings(settings);
  const actions = selected.slice(0, 8).map(({ key, profileField, name, nativeName, valueSchema, howTo, approval, requiredPermission }) => ({ key, action: name, function: nativeName, valueSchema, howTo, approval, requiredPermission, currentValue: profileField ? "Read inspect_server_configuration for Duck's current server profile." : settingWireValue(key, current[key]) }));
  return { totalSettings: SETTING_ACTIONS.length, actions, moreMatches: selected.length > 8, catalog: options.includeCatalog ? SETTING_ACTIONS.map(({ key, name, category }) => ({ key, action: name, category })) : undefined, modelCatalog: actions.some(a => /Model$/.test(a.key)) ? getPublicModelCatalog() : undefined, instruction: "The returned proposal functions are available on the next step. Call the exact function with {value,reason}; a proposal is not execution. For arrays, inspect and preserve unrelated entries. All setting changes always need Administrator approval." };
}
