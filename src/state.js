// Duck: shared in-memory runtime state (caches, pending actions, sessions).

const pendingActions = new Map();
const pendingByChannel = new Map();
const pendingExpiryTimers = new Map();
const serverContextCache = new Map();
const messageHistoryCache = new Map();
const resourceFetchCache = new Map();
const jsonFileCache = new Map();
const pendingJsonWrites = new Map();
const voiceSessions = new Map();
const voiceQuarantineExpiryTimers = new Map();
const voiceQuarantineMoves = new Set();
const commandCooldowns = new Map();

export {
  pendingActions,
  pendingByChannel,
  pendingExpiryTimers,
  serverContextCache,
  messageHistoryCache,
  resourceFetchCache,
  jsonFileCache,
  pendingJsonWrites,
  voiceSessions,
  voiceQuarantineExpiryTimers,
  voiceQuarantineMoves,
  commandCooldowns,
};
