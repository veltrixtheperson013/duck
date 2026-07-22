import path from "node:path";
import { PermissionsBitField } from "discord.js";

const dataDir = path.join(process.cwd(), "data");
const settingsPath = path.join(dataDir, "settings.json");
const pendingActionsPath = path.join(dataDir, "pending-actions.json");
const warningsPath = path.join(dataDir, "warnings.json");
const quotesPath = path.join(dataDir, "quotes.json");
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const TOOL_DEFINITIONS = [
  {
    name: "ban_member",
    risk: "high",
    description: "Ban a mentioned server member.",
  },
  {
    name: "kick_member",
    risk: "high",
    description: "Kick a mentioned server member.",
  },
  {
    name: "timeout_member",
    risk: "medium",
    description: "Temporarily timeout a mentioned server member.",
  },
  {
    name: "delete_channel",
    risk: "critical",
    description: "Delete a server channel only when the request explicitly mentions the channel, gives its ID, or uses its exact name. Administrator confirmation required.",
  },
  {
    name: "purge_messages",
    risk: "medium",
    description: "Bulk delete recent messages in the current channel.",
  },
  {
    name: "unban_user",
    risk: "high",
    description: "Unban a user by their exact Discord user ID.",
  },
  {
    name: "grep_messages",
    risk: "low",
    description: "Search recent readable messages in the current or mentioned text channel for keywords.",
  },
  {
    name: "warn_member",
    risk: "medium",
    description: "Warn a mentioned server member, store the warning, and direct message them when possible.",
  },
  {
    name: "view_warnings",
    risk: "low",
    description: "Show stored warnings for a mentioned server member.",
  },
  {
    name: "clear_warnings",
    risk: "medium",
    description: "Clear a requested number of stored warnings for a mentioned server member.",
  },
  {
    name: "untimeout_member",
    risk: "medium",
    description: "Remove timeout from a mentioned server member.",
  },
  {
    name: "set_slowmode",
    risk: "medium",
    description: "Set slowmode for the current or mentioned text channel.",
  },
  {
    name: "lock_channel",
    risk: "high",
    description: "Stop @everyone from sending messages in the current or mentioned channel.",
  },
  {
    name: "unlock_channel",
    risk: "high",
    description: "Allow @everyone to send messages again in the current or mentioned channel.",
  },
  {
    name: "softban_member",
    risk: "high",
    description: "Ban and immediately unban a mentioned member to remove recent messages.",
  },
  {
    name: "delete_user_messages",
    risk: "medium",
    description: "Delete recent messages by a mentioned member in the current channel.",
  },
  {
    name: "set_nickname",
    risk: "medium",
    description: "Change a mentioned member's server nickname.",
  },
  {
    name: "add_role",
    risk: "high",
    description: "Add a server role to a mentioned member.",
  },
  {
    name: "remove_role",
    risk: "high",
    description: "Remove a server role from a mentioned member.",
  },
  {
    name: "disconnect_member",
    risk: "medium",
    description: "Disconnect a mentioned member from voice.",
  },
  {
    name: "move_member",
    risk: "medium",
    description: "Move a mentioned member to a mentioned voice channel.",
  },
  {
    name: "voice_mute_member",
    risk: "medium",
    description: "Server-mute a mentioned member in voice.",
  },
  {
    name: "voice_unmute_member",
    risk: "medium",
    description: "Remove server voice mute from a mentioned member.",
  },
  {
    name: "deafen_member",
    risk: "medium",
    description: "Server-deafen a mentioned member in voice.",
  },
  {
    name: "undeafen_member",
    risk: "medium",
    description: "Remove server deafen from a mentioned member.",
  },
  {
    name: "create_text_channel",
    risk: "high",
    description: "Create a text channel.",
  },
  {
    name: "create_voice_channel",
    risk: "high",
    description: "Create a voice channel.",
  },
  {
    name: "rename_channel",
    risk: "high",
    description: "Rename a text or voice channel.",
  },
  {
    name: "set_channel_topic",
    risk: "medium",
    description: "Set a text channel topic.",
  },
  {
    name: "speak",
    risk: "medium",
    description: "Send an approved message as Duck in the current or mentioned text channel.",
  },
  {
    name: "pin_message",
    risk: "medium",
    description: "Pin a replied-to or specified message in a text channel.",
  },
  {
    name: "unpin_message",
    risk: "medium",
    description: "Unpin a replied-to or specified message in a text channel.",
  },
  {
    name: "create_thread",
    risk: "medium",
    description: "Create a public thread in the current or mentioned text channel.",
  },
  {
    name: "set_role_color",
    risk: "high",
    description: "Change an editable role color.",
  },
  {
    name: "create_poll",
    risk: "medium",
    description: "Create a simple reaction poll in a text channel.",
  },
  {
    name: "create_role",
    risk: "high",
    description: "Create a server role.",
  },
  {
    name: "delete_role",
    risk: "high",
    description: "Delete a server role.",
  },
];

const UTILITY_COMMANDS = [
  "`duck userinfo @user` / `duck whois @user`",
  "`duck avatar @user`",
  "`duck serverinfo`",
  "`duck channelinfo #channel`",
  "`duck roleinfo @role`",
  "`duck warnings @user`",
  "`duck poll \"Question\" \"Option A\" \"Option B\"`",
  "Reply with `duck pin this` / `duck unpin this`",
  "`duck create thread \"topic\" in #channel`",
  "`duck set @role color #3B82F6`",
  "`duck quote` / `duck quote add <text>` / `duck quote list`",
  "`duck ship @user [@user]`",
  "`duck curse [@user]`",
  "`duck spinwheel pizza, tacos, sushi`",
  "`duck roll 2d20` / `duck coinflip` / `duck eightball <question>`",
  "`duck remind 10m check the logs`",
  "`duck test`",
  "`duck join` / `duck leave`",
  "`duck tts hello from Duck` (while joined)",
  "`duck bulk warn @user spam; timeout @user 10m flooding`",
  "`duck rules`",
  "`duck ping`",
  "`duck botinfo`",
];

const DEFAULT_QUOTES = [
  "Silence is golden. Duct tape is silver.",
  "I'm not arguing, I'm just explaining why I'm right.",
  "Common sense is not a super power. It's just not common.",
];

const CURSES = [
  "may your next click always land 1px off the button you meant.",
  "may your chat always say 'typing...' right when you have nothing left to say.",
  "may your food always be one bite too hot.",
  "may you forever queue behind the slowest walker in every hallway.",
  "may your phone always be at 12% with no charger in sight.",
];

const BLESSINGS = [
  "may every green light be in your favor today.",
  "may your snacks always be perfectly portioned.",
  "may your wifi never lag mid-clutch.",
  "may your favorite song always play at the right moment.",
];

const EIGHT_BALL_ANSWERS = [
  "It is certain.",
  "Signs point to yes.",
  "Most likely.",
  "Ask again later.",
  "Cannot predict now.",
  "Do not count on it.",
  "My sources say no.",
  "Very doubtful.",
];
const TOOL_REQUIREMENTS = {
  ban_member: PermissionsBitField.Flags.BanMembers,
  unban_user: PermissionsBitField.Flags.BanMembers,
  kick_member: PermissionsBitField.Flags.KickMembers,
  timeout_member: PermissionsBitField.Flags.ModerateMembers,
  delete_channel: PermissionsBitField.Flags.ManageChannels,
  purge_messages: PermissionsBitField.Flags.ManageMessages,
  grep_messages: PermissionsBitField.Flags.ReadMessageHistory,
  warn_member: PermissionsBitField.Flags.ModerateMembers,
  view_warnings: PermissionsBitField.Flags.ModerateMembers,
  clear_warnings: PermissionsBitField.Flags.ModerateMembers,
  untimeout_member: PermissionsBitField.Flags.ModerateMembers,
  set_slowmode: PermissionsBitField.Flags.ManageChannels,
  lock_channel: PermissionsBitField.Flags.ManageChannels,
  unlock_channel: PermissionsBitField.Flags.ManageChannels,
  softban_member: PermissionsBitField.Flags.BanMembers,
  delete_user_messages: PermissionsBitField.Flags.ManageMessages,
  set_nickname: PermissionsBitField.Flags.ManageNicknames,
  add_role: PermissionsBitField.Flags.ManageRoles,
  remove_role: PermissionsBitField.Flags.ManageRoles,
  disconnect_member: PermissionsBitField.Flags.MoveMembers,
  move_member: PermissionsBitField.Flags.MoveMembers,
  voice_mute_member: PermissionsBitField.Flags.MuteMembers,
  voice_unmute_member: PermissionsBitField.Flags.MuteMembers,
  deafen_member: PermissionsBitField.Flags.DeafenMembers,
  undeafen_member: PermissionsBitField.Flags.DeafenMembers,
  create_text_channel: PermissionsBitField.Flags.ManageChannels,
  create_voice_channel: PermissionsBitField.Flags.ManageChannels,
  rename_channel: PermissionsBitField.Flags.ManageChannels,
  set_channel_topic: PermissionsBitField.Flags.ManageChannels,
  speak: PermissionsBitField.Flags.SendMessages,
  pin_message: PermissionsBitField.Flags.ManageMessages,
  unpin_message: PermissionsBitField.Flags.ManageMessages,
  create_thread: [PermissionsBitField.Flags.CreatePublicThreads, PermissionsBitField.Flags.SendMessages],
  set_role_color: PermissionsBitField.Flags.ManageRoles,
  create_poll: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AddReactions],
  announce: PermissionsBitField.Flags.SendMessages,
  create_role: PermissionsBitField.Flags.ManageRoles,
  delete_role: PermissionsBitField.Flags.ManageRoles,
};

const DUCK_COLORS = Object.freeze({
  brand: 0x4f9ddf,
  success: 0x57f287,
  warning: 0xfee75c,
  danger: 0xed4245,
  neutral: 0x5865f2,
  fun: 0xeb459e,
  voice: 0x9b59b6,
});

const COMMAND_PRESENTATION = Object.freeze({
  commands: ["Duck Command Center", DUCK_COLORS.brand],
  help: ["Duck Command Center", DUCK_COLORS.brand],
  ping: ["Gateway Latency", DUCK_COLORS.success],
  latency: ["Gateway Latency", DUCK_COLORS.success],
  test: ["Duck Diagnostics", DUCK_COLORS.neutral],
  userinfo: ["Member Profile", DUCK_COLORS.brand],
  whois: ["Member Profile", DUCK_COLORS.brand],
  avatar: ["Member Avatar", DUCK_COLORS.brand],
  serverinfo: ["Server Overview", DUCK_COLORS.brand],
  channelinfo: ["Channel Details", DUCK_COLORS.brand],
  roleinfo: ["Role Details", DUCK_COLORS.brand],
  warnings: ["Warning History", DUCK_COLORS.warning],
  warns: ["Warning History", DUCK_COLORS.warning],
  quote: ["Duck Quotes", DUCK_COLORS.fun],
  ship: ["Compatibility Check", DUCK_COLORS.fun],
  curse: ["Duck's Fortune", DUCK_COLORS.fun],
  spinwheel: ["Wheel Result", DUCK_COLORS.fun],
  roll: ["Dice Roll", DUCK_COLORS.fun],
  coinflip: ["Coin Flip", DUCK_COLORS.fun],
  eightball: ["Magic 8-Ball", DUCK_COLORS.fun],
  tts: ["Voice Reader", DUCK_COLORS.voice],
  remind: ["Reminder", DUCK_COLORS.success],
  join: ["Voice Reader", DUCK_COLORS.voice],
  leave: ["Voice Reader", DUCK_COLORS.voice],
  prefix: ["Command Prefix", DUCK_COLORS.success],
  sendrules: ["Server Rules", DUCK_COLORS.brand],
});

const RISK_COPY = {
  low: "This read-only action is low risk.",
  medium: "This action needs Administrator confirmation before I do anything.",
  high: "This moderation action needs Administrator confirmation before I do anything.",
  critical: "I'm sorry, I need approval from a person that has Administrator.",
};

const CAPABILITY_MODES = Object.freeze({
  ask: "ask",
  approve: "approve",
  agent: "agent",
});

const CAPABILITY_MODE_LABELS = Object.freeze({
  ask: "Ask for approval",
  approve: "Approve for me",
  agent: "Agent mode",
});

export {
  dataDir,
  settingsPath,
  pendingActionsPath,
  warningsPath,
  quotesPath,
  MAX_TIMER_DELAY_MS,
  TOOL_DEFINITIONS,
  UTILITY_COMMANDS,
  DEFAULT_QUOTES,
  CURSES,
  BLESSINGS,
  EIGHT_BALL_ANSWERS,
  TOOL_REQUIREMENTS,
  DUCK_COLORS,
  COMMAND_PRESENTATION,
  RISK_COPY,
  CAPABILITY_MODES,
  CAPABILITY_MODE_LABELS,
};
