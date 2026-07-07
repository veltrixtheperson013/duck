# Duck

Duck is a Node.js Discord AI chatbot with confirmation-gated moderation tools.

The important safety rule: Duck never runs a moderation tool immediately. It always creates a confirmation prompt first.

Duck uses OpenRouter, Ollama, or another OpenAI-compatible provider for normal chat and AI tool planning. For obvious moderation requests, Duck asks AI for a tool plan, validates it, and falls back to the built-in local parser only when AI is unavailable or fails.

## Features

- `/setup channel:#channel` chooses the channel where Duck listens.
- Duck responds to all user messages in the setup channel when AI is configured.
- Natural language moderation requests in the setup channel become confirmation-gated tool plans.
- Duck also responds when someone says `duck`, mentions `@Duck`, or replies to one of Duck's messages.
- Queue/thinking messages are posted while AI is working, then edited with the result.
- Server context and recent-message reads are cached briefly to reduce wait times.
- Confirmation buttons for every moderation action.
- Text confirmation with `I confirm` for the latest pending action in the channel.
- Pending confirmations are saved to disk so quick process/server restarts do not lose them.
- Discord status shows Duck is watching for `duck` / `@Duck`.
- Administrator approval required for every action.
- Permission checks for the person requesting, the Administrator confirming, and Duck itself.
- OpenRouter-first chat for normal messages, with AI tool planning for moderation requests.
- The AI receives bounded server context: channel list, role list, mentioned users, and recent messages from readable text channels.
- User-facing error messages say when AI/OpenRouter failed instead of hiding it behind generic fallback text.
- Tools for ban, softban, kick, timeout, remove timeout, warn, nicknames, roles, voice moderation, channel creation/deletion, purge messages, slowmode, lock channel, and unlock channel.

## Examples

```text
duck
```

Duck replies with usage examples.

```text
@Duck warn @BadUser spam
```

Duck prepares a warning even outside the setup channel because it was mentioned.

In the setup channel, normal chat also gets an AI response:

```text
how is chat looking?
```

Duck replies conversationally using recent server context.

You can also reply to one of Duck's messages:

```text
timeout @BadUser 10m spam
```

```text
Ban @BadUser spam
```

Duck replies with a confirmation prompt. After an authorized person confirms:

```text
I have banned BadUser, baduser.
```

```text
Delete channel "General"
```

Duck replies:

```text
I'm sorry, I need approval from a person that has Administrator.
```

After an Administrator clicks Confirm or replies `I confirm`:

```text
I have deleted the channel "General".
```

## AI Tool Calling

Duck's AI never executes tools directly. It only returns a JSON plan for moderation requests, then Duck validates that plan and shows an Administrator-only confirmation prompt.

The planner is instructed to:

- Choose exactly one tool for the user's moderation request.
- Return `{"tool":"none"}` when the request is vague, not moderation, or only a question.
- Use IDs from the provided server context for existing members, channels, and roles.
- Never invent IDs.
- Never target a member unless that member was mentioned in the request.
- Never chain multiple moderation actions in one plan.

Tool fields:

```json
{
  "tool": "timeout_member",
  "targetId": "mentioned_member_id",
  "durationMs": 600000,
  "reason": "spam"
}
```

Common tool choices:

- `ban_member`: permanent ban.
- `softban_member`: ban and immediately unban to clean recent messages.
- `kick_member`: remove from server without banning.
- `timeout_member`: temporary mute/timeout.
- `untimeout_member`: clear timeout.
- `warn_member`: DM a warning when possible.
- `purge_messages`: delete recent messages in the current channel.
- `delete_user_messages`: delete recent messages from one mentioned user in the current channel.
- `set_slowmode`: set channel rate limit.
- `lock_channel` / `unlock_channel`: change @everyone send permissions.
- `set_nickname`: change a mentioned member's nickname.
- `add_role` / `remove_role`: edit a mentioned member's role.
- `disconnect_member` / `move_member`: voice moderation.
- `create_text_channel`: create a text channel.
- `delete_channel`: delete an explicitly requested channel.

## Setup

1. Install dependencies:

   ```powershell
   npm.cmd install
   ```

2. Copy `config.example.json` to `config.json` and fill in:

   ```json
   {
     "DISCORD_TOKEN": "...",
     "CLIENT_ID": "...",
     "AI_PROVIDER": "openrouter",
     "OPENROUTER_API_KEY": "your_openrouter_api_key_here",
     "OPENROUTER_MODEL": "tencent/hy3:free",
     "AI_CONTEXT_CHANNELS": "5",
     "AI_CONTEXT_MESSAGES_PER_CHANNEL": "8",
     "AI_CONTEXT_MAX_MESSAGES": "40",
     "AI_CONTEXT_CACHE_TTL_MS": "15000",
     "PENDING_ACTION_TTL_MS": "1800000",
     "DUCK_QUEUE_MESSAGE": "Duck is thinking...",
     "DUCK_DEBUG": "true",
     "DUCK_DEBUG_AI_BODY": "false"
   }
   ```

   AI config is optional. Leave it out if you want the completely local zero-cost rule planner.

   You can also copy `.env.template` to `.env` and fill that in instead. `.env` is ignored by Git and should not be uploaded publicly.

   AI planner options:

   - OpenRouter hosted AI: set `AI_PROVIDER` to `openrouter`, set `OPENROUTER_API_KEY`, and choose an `OPENROUTER_MODEL`.
   - No account, uses your PC: set `AI_PROVIDER` to `ollama`, install Ollama, then run `ollama pull llama3.1:8b`.
   - Hosted, requires an account/API key: set `AI_PROVIDER` to `openai-compatible`, then set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`.
   - Groq is still supported with `AI_PROVIDER=groq`, `GROQ_API_KEY`, and `GROQ_MODEL`, but do not use it if Groq login is broken for you.

   AI server context is bounded by `AI_CONTEXT_CHANNELS`, `AI_CONTEXT_MESSAGES_PER_CHANNEL`, and `AI_CONTEXT_MAX_MESSAGES`.
   Server context cache lifetime is controlled by `AI_CONTEXT_CACHE_TTL_MS`; the default is `15000` milliseconds.
   Queue text is controlled by `DUCK_QUEUE_MESSAGE`.
   Pending confirmation persistence is bounded by `PENDING_ACTION_TTL_MS`; the default is `1800000` milliseconds, or 30 minutes.
   Debug logging is controlled by `DUCK_DEBUG`. `DUCK_DEBUG_AI_BODY` can log model output snippets, but should stay `false` unless you are actively debugging.

   Current OpenRouter free models can rotate. As of July 6, 2026, OpenRouter's public model API lists `tencent/hy3:free` with zero prompt and completion pricing.

3. In the Discord Developer Portal, enable these bot privileged gateway intents:

   - Server Members Intent
   - Server Voice States Intent
   - Message Content Intent

4. Invite the bot with these permissions as needed:

   - Send Messages
   - Read Message History
   - Ban Members
   - Kick Members
   - Moderate Members
   - Manage Channels
   - Manage Messages
   - Manage Nicknames
   - Manage Roles
   - Move Members

5. Start the bot:

   ```powershell
   npm.cmd start
   ```

6. In Discord, run:

   ```text
   /setup channel:#your-mod-channel
   ```

## Wispbyte Hosting

Upload the contents of this `Duck` folder to your Wispbyte bot server.

Use this startup command:

```text
npm start
```

If the panel asks for the main file instead, use:

```text
index.js
```

If your Wispbyte panel does not have environment variables, copy `config.example.json` to `config.json` and put your bot values there:

```json
{
  "DISCORD_TOKEN": "your_bot_token_here",
  "CLIENT_ID": "your_application_client_id_here",
  "AI_PROVIDER": "openrouter",
  "OPENROUTER_API_KEY": "your_openrouter_api_key_here",
  "OPENROUTER_MODEL": "tencent/hy3:free",
  "OPENROUTER_SITE_URL": "https://duck.local",
  "OPENROUTER_APP_NAME": "Duck Discord Bot",
  "AI_CONTEXT_CHANNELS": "5",
  "AI_CONTEXT_MESSAGES_PER_CHANNEL": "8",
  "AI_CONTEXT_MAX_MESSAGES": "40",
  "AI_CONTEXT_CACHE_TTL_MS": "15000",
  "PENDING_ACTION_TTL_MS": "1800000",
  "DUCK_QUEUE_MESSAGE": "Duck is thinking...",
  "DUCK_DEBUG": "true",
  "DUCK_DEBUG_AI_BODY": "false",
  "OLLAMA_MODEL": "llama3.1:8b",
  "OLLAMA_BASE_URL": "http://localhost:11434",
  "AI_API_KEY": "optional_hosted_ai_key_here",
  "AI_BASE_URL": "https://openrouter.ai/api/v1",
  "AI_MODEL": "optional_model_id_here",
  "GROQ_API_KEY": "optional_groq_api_key_here",
  "GROQ_MODEL": "llama-3.3-70b-versatile"
}
```

Upload `config.json` with the rest of the bot files. Keep it private because it contains your bot token.

Duck also supports normal environment variables if your host adds them later.

## Debug Logs

Set `DUCK_DEBUG=true` to log startup config, version, selected AI provider/model, context cache hits/misses, OpenRouter/Ollama HTTP status codes, slow/failing AI requests, planner results, queue timing, confirmation lifecycle, and moderation execution results.

Set `DUCK_DEBUG_AI_BODY=true` only when needed. It logs short AI response snippets and may include message content from your server.

## Supported Requests

- `ban @user reason`
- `softban @user reason`
- `kick @user reason`
- `timeout @user 10m reason`
- `mute @user 1h reason`
- `untimeout @user reason`
- `warn @user reason`
- `nick @user "new nickname"`
- `add role @user "Member"`
- `remove role @user "Muted"`
- `disconnect @user`
- `move @user "General Voice"`
- `delete 10 messages from @user`
- `create text channel "mod-log"`
- `delete channel "General"`
- `purge 25`
- `delete 10 messages`
- `slowmode 10s`
- `slowmode #general 1m`
- `lock`
- `lock #general`
- `unlock`
- `unlock #general`

Timeout duration supports `s`, `m`, `h`, and `d`. Slowmode supports `s`, `m`, and `h`.
