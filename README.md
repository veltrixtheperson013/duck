# Duck

Duck is a Node.js Discord AI chatbot with confirmation-gated moderation tools.

The important safety rule: Duck validates permissions, hierarchy, and targets before every moderation action. The guild's `/capibility` policy decides whether a validated action runs or waits for Administrator confirmation.

Duck uses OpenRouter, Ollama, or another OpenAI-compatible provider for normal chat and AI tool planning. For obvious moderation requests, Duck asks AI for a tool plan, validates it, and falls back to the built-in local parser only when AI is unavailable or fails.

The built-in website serves Duck's homepage at `/`, dashboard at `/dashboard`, live cluster status at `/clusters`, pricing at `/pricing`, development support at `/donate`, setup guide at `/guide`, privacy policy at `/privacy-policy`, refund policy at `/refunds`, terms at `/terms-of-service`, and a JSON health check at `/health`. It binds to `0.0.0.0` on `DUCK_KEEP_ALIVE_PORT` (`9584` by default) for Wispbyte deployments. Set `DUCK_KEEP_ALIVE=false` to disable it.

Duck's cluster system deterministically assigns Discord server IDs across `DUCK_CLUSTER_COUNT` logical isolation lanes. Each lane has its own bounded AI queue, status, uptime, and server count. Use `DUCK_CLUSTER_ASSIGNMENTS` only for explicit server-ID overrides, such as `123456789012345678=cluster-02`; names are rejected. Operations can set `DUCK_CLUSTER_STATUS` globally or use `DUCK_CLUSTER_STATUS_OVERRIDES`, such as `cluster-02=maintenance,cluster-04=offline`. Keep the cluster count stable after launch unless you intentionally want to rebalance servers.

The `child` branch adds Ubuntu worker nodes. The manager keeps the Discord connection, billing secrets, settings, assignments, and authoritative data; children connect outbound with Ed25519-signed requests and accept only fixed jobs. The manager runs 18 health checks every 30 minutes, marks sustained failures as outages, and falls back locally when a child is absent. Setup instructions are in `child/README.md`.

Dashboard login uses Discord OAuth scopes `identify` and `guilds`. Configure `DISCORD_CLIENT_SECRET` and register `https://duck.wispbyte.app/auth/discord/callback` in the Discord Developer Portal. Dashboard sessions and OAuth tokens are memory-only, use HttpOnly SameSite cookies, and expire after 12 hours. Guild changes require current Manage Server or Administrator permission and are rejected unless Duck is present in the target guild.

Duck Plus uses hosted Stripe Checkout. Configure `DUCK_PUBLIC_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PLUS_MONTHLY_PRICE_ID`, and `STRIPE_PLUS_YEARLY_PRICE_ID`. Create a Stripe webhook endpoint at `https://duck.wispbyte.app/api/billing/webhook` and subscribe to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, and `customer.subscription.resumed`. Enable the Stripe customer portal so server managers can update payment details, review invoices, or cancel. Duck verifies Stripe's raw-body signature, binds subscription metadata to the authenticated Discord server, rejects foreign Price IDs, rejects stale/replayed events, and provisions Plus only from verified subscription events. All Stripe credentials remain server-side; this flow does not need a publishable key.

The fixed one-time support amounts on `/donate` also use hosted Stripe Checkout when `STRIPE_SECRET_KEY` is configured. `DUCK_DONATION_CHECKOUT_URL` remains available as an optional HTTPS fallback and may include `{amount}`.

## Private Operator Deck

Duck includes a separate owner operations console for cluster status and assignments, maintenance scheduling, platform blocks, per-server Plus grants and loyalty tiers, website banners, bounded database inspection/export, profile deletion, write flushing, and an operator audit trail. It is not a route on the public website: when enabled, it always binds to `127.0.0.1` on `DUCK_ADMIN_PORT` (`9590` by default) and also requires a separate `DUCK_ADMIN_TOKEN` of at least 32 characters.

Generate a token and enable it:

```text
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
DUCK_ADMIN_ENABLED=true
DUCK_ADMIN_PORT=9590
DUCK_ADMIN_TOKEN=the_generated_value
```

Open `http://127.0.0.1:9590` on the computer running Duck. If Duck runs on a remote server, use an SSH local port-forward such as `ssh -L 9590:127.0.0.1:9590 your-server`, then open the same local URL. Do not expose or reverse-proxy port 9590. The console rejects non-loopback clients, unexpected Host headers, cross-origin mutations, weak or missing tokens, oversized JSON, prototype keys, and excessive changes. Secrets are never included in its database export.

For hosts that provide SFTP but no SSH tunnel, enable the hardened remote Operator Deck on Duck's existing HTTPS website. Keep the loopback controller enabled so persisted maintenance and cluster overrides are restored, then configure a private path and the one allowed Discord owner:

```text
DUCK_ADMIN_ENABLED=true
DUCK_REMOTE_ADMIN_ENABLED=true
DUCK_REMOTE_ADMIN_PATH=/pond-operations-use-a-long-random-value
DUCK_ADMIN_OWNER_ID=1138897388694687834
DUCK_ADMIN_SESSION_MINUTES=15
DUCK_ADMIN_ALLOWED_IPS=
```

If either Operator Deck is enabled with incomplete security settings, Duck logs which setting is invalid and keeps the bot and public website online with that deck disabled.

Sign in to Duck's normal dashboard with that Discord account first, then manually open `https://duck.wispbyte.app/<your-private-path>/`. The private path is not linked or advertised. Duck returns a normal 404 to other Discord accounts and signed-out visitors. Unlocking additionally requires the 64-or-more-character `DUCK_ADMIN_TOKEN`; Duck exchanges it for a short-lived HttpOnly, Secure, SameSite=Strict session bound to the current Discord session, client address, and browser. Every mutation requires a separate CSRF token and same-origin HTTPS request. Unlock attempts and operator changes have dedicated strict rate limits. `DUCK_ADMIN_ALLOWED_IPS` optionally accepts exact comma-separated client IPs, but should stay empty when the host's reverse proxy hides the real visitor IP.

The Operator Deck can stage a gradual release from GitHub when `DUCK_ADMIN_DEPLOY_ENABLED=true`. It accepts only the configured remote and branch, refuses tracked local changes and non-fast-forward history, notifies each server's configured log channel cluster-by-cluster, and records every stage in the admin audit log. Duck's current clusters are logical queues inside one Node process, so the release is applied once after cluster notifications and requires one process restart. Leave `DUCK_ADMIN_DEPLOY_AUTO_RESTART=false` unless Wispbyte is configured to restart Duck automatically after `SIGTERM`; otherwise restart from the Wispbyte panel when the Deck reports `restart required`.

## Features

- `/setup channel:#channel` chooses the channel where Duck listens. `/setup quarantine-channel:<voice channel>` configures the Administrator-only voice quarantine destination.
- Duck responds to all user messages in the setup channel when AI is configured.
- Natural language moderation requests in the setup channel become confirmation-gated tool plans.
- AI chat can request moderation with hidden inline markers like `{{warn::member::reason}}`; Duck hides the marker, validates it locally, then shows an approval embed.
- Duck also responds when someone says `duck`, mentions `@Duck`, or replies to one of Duck's messages.
- Queue/thinking messages are posted while AI is working, then edited with the result. AI work uses a bounded fair queue so one busy server cannot starve the others.
- Server context and recent-message reads are cached briefly to reduce wait times.
- Confirmation buttons for every moderation action.
- Text confirmation with `I confirm` for the latest pending action in the channel.
- Pending confirmations are saved to disk so quick process/server restarts do not lose them.
- Discord status shows Duck is watching for `duck` / `@Duck`.
- Guild-configurable action approval through Administrator-only `/capibility` modes.
- Permission checks for the person requesting, the Administrator confirming, and Duck itself.
- OpenRouter-first chat for normal messages, with AI tool planning for moderation requests.
- The AI receives bounded server context: channel list, role list, mentioned users, and recent messages from readable text channels.
- User-facing error messages say when AI/OpenRouter failed instead of hiding it behind generic fallback text.
- Tools for ban, softban, kick, timeout, remove timeout, warn, nicknames, roles, voice moderation, channel creation/deletion, purge messages, slowmode, lock channel, and unlock channel.
- Extra voice tools include server voice mute/unmute and deafen/undeafen.
- Administrator-only voice quarantine can keep a member in one configured VC for 1-1440 minutes. Members can disconnect, but are moved back if they join another VC before release or expiry.
- Deterministic prefix commands support `!`, `!!`, and one server-specific prefix configured with `/prefix`.
- Structured slash commands cover moderation, warnings, utilities, announcements, diagnostics, and voice TTS. `/tool` exposes the remaining tool surface.
- Slash commands default to guild-only synchronization and stale global commands are removed, preventing Discord from showing each command twice. Set `DUCK_COMMAND_SCOPE=global` only when you intentionally want global propagation.
- `/bulk` or `!bulk` validates 2-10 actions and runs them behind one Administrator confirmation.
- Natural-language AI requests can also combine 2-10 validated tools into one ordered, Administrator-approved batch.
- Message context is allocated dynamically: explicitly targeted channels receive deeper history while unrelated channels use a smaller background sample.
- `!join` / `/join` streams short messages from the joined voice channel's built-in text chat through ElevenLabs without storing audio files. Duck uses the low-latency Flash model and a low-bitrate MP3 stream by default for small VMs.
- Background cache refreshes are bounded and non-overlapping, with conservative retention defaults for low-memory hosts.
- Voice DAVE encryption defaults on with `@discordjs/voice` 0.19.2. Voice sessions are isolated per guild, protected from cross-channel hijacking, and have per-user/per-guild TTS budgets.
- OpenRouter vision is model-aware. `tencent/hy3` is always treated as text-only in automatic mode.
- Pending actions re-check the original requester's current membership, permissions, target-channel access, and role hierarchy immediately before execution.
- Community Studio adds automatic join roles, spam-resistant Pond Levels, `/rank`, `/leaderboard`, `/suggest`, staff-reviewed proposals, Starboard highlights, and Plus scheduled posts.
- Reaction-role panels support 10 Free or 25 Plus options; Plus also adds exclusive/limited selection modes. Ticket panels support 5 Free or 10 Plus request types, with bounded close transcripts for Plus.
- Free TTS uses OpenRouter Flux with bounded audio reads, deadlines, content-type checks, and one retry for empty or transient responses. Plus ElevenLabs uses the same fail-loud retry behavior.
- The honeypot maintains a persistent Discord counter embed for total catches, first softbans, and permanent repeat bans.
- Color Dock provides safe exclusive name colors through select menus, `/color`, and `/colors`; it can create permissionless roles, require an access role, and gives Plus servers larger palettes and random join colors.

## Commands

Common moderation commands include `/ban`, `/softban`, `/unban`, `/kick`, `/timeout`, `/untimeout`, `/warn`, `/warnings`, `/clearwarnings`, `/clear`, `/slowmode`, `/lock`, `/unlock`, `/nickname`, `/addrole`, `/removerole`, `/disconnect`, `/voicemute`, `/voiceunmute`, `/deafen`, and `/undeafen`. Prefix forms use the same names, such as `!warn @member spam` or `!!clear 25`.

Administrator commands include `/sendrules`, `/announce`, `/bulk`, `/prefix`, `/capibility`, `/setup`, `/entry-setup`, `/voicequarantine`, `/voicerelease`, and `/synccommands`.

Voice quarantine setup and usage:

```text
/setup quarantine-channel:Voice Jail
/voicequarantine member:@user minutes:30 reason:Repeated voice disruption
/voicerelease member:@user reason:Issue resolved
```

Prefix and AI forms are `duck voice quarantine @user 30m reason` and `duck voice release @user`. Duck intentionally does not rapidly shuffle members through public voice channels.

`/capibility` controls how validated actions execute:

- **Ask for approval:** every action waits for Administrator confirmation.
- **Approve for me (Recommended):** read-only low-risk actions run immediately; medium, high, and critical actions still wait for confirmation.
- **Agent mode:** Duck can iteratively request bounded channel history, search a channel, inspect a specific message, refresh member or role details, and check channel or voice state before preparing an ordered action plan. Every validated action then runs immediately. Enabling this mode requires a second Administrator confirmation. Requester permissions, role hierarchy, server isolation, exact-target validation, and Duck's Discord permissions still apply; the AI receives no shell, filesystem, arbitrary HTTP, database, or self-modification tool.

Utilities include `/commands`, `/ping`, `/test`, `/userinfo`, `/serverinfo`, `/channelinfo`, `/roleinfo`, `/avatar`, `/quote`, `/ship`, `/curse`, `/spinwheel`, `/roll`, `/coinflip`, `/eightball`, `/truth`, `/dare`, `/truthordare`, `/neverhaveiever`, `/hotseat`, `/vibecheck`, `/remind`, `/suggest`, `/rank`, `/leaderboard`, `/join`, `/tts`, and `/leave`.

Bulk syntax separates commands with semicolons or new lines:

```text
!bulk warn @member spam; timeout @member 10m continued spam; clear 20
```

Use `/tool request:<normal tool request>` for tools without a dedicated slash command.

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

Duck's AI never calls Discord APIs directly. It returns a JSON plan, Duck validates that plan, and the guild's `/capibility` policy decides whether to execute it or show an Administrator-only confirmation prompt.

OpenAI-compatible chat uses native structured function calls. The model receives six bounded read functions plus five proposal groups for member, message, voice, channel, and role actions. Each proposal is parsed by Duck, matched to the current server, and checked again against requester permissions, role hierarchy, and the guild approval policy. The model can request multiple explicitly requested actions in one ordered proposal, up to ten.

Hidden inline tool markers remain only as a compatibility fallback for providers that do not support native function calling. A fallback response can end with:

```text
{{warn::Ryzen 9 9950X3D2::testing purposes}}
```

Duck removes the marker from the visible response and turns it into a confirmation embed. For two-target tools, separate targets with `|`:

```text
{{add_role::Ryzen 9 9950X3D2|Member::testing purposes}}
{{move::Ryzen 9 9950X3D2|General Voice::testing purposes}}
```

Supported marker tool names include `ban`, `softban`, `kick`, `timeout`, `warn`, `untimeout`, `purge`, `delete_user_messages`, `slowmode`, `lock`, `unlock`, `nickname`, `add_role`, `remove_role`, `disconnect`, `move`, `voice_quarantine`, `voice_release`, `voice_mute`, `voice_unmute`, `deafen`, `undeafen`, `create_channel`, `create_voice_channel`, `rename_channel`, `set_topic`, `create_role`, `delete_role`, and `delete_channel`.

The planner is instructed to:

- Choose one proposal group and include every explicitly requested action in order.
- Return `{"tool":"none"}` when the request is vague, not moderation, or only a question.
- Use IDs from the provided server context for existing members, channels, and roles.
- Never invent IDs.
- Never target a member unless that member was mentioned in the request.
- Ask a short follow-up when a required target or value is missing instead of guessing.

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
- `voice_quarantine_member` / `release_voice_quarantine`: Administrator-only bounded voice quarantine in the configured channel.
- `voice_mute_member` / `voice_unmute_member`: server mute or unmute a member in voice.
- `deafen_member` / `undeafen_member`: server deafen or undeafen a member in voice.
- `create_text_channel`: create a text channel.
- `create_voice_channel`: create a voice channel.
- `rename_channel`: rename a text or voice channel.
- `set_channel_topic`: set a text channel topic.
- `create_role` / `delete_role`: create or delete server roles.
- `delete_channel`: delete an explicitly requested channel.

## Setup

1. Install Node.js 22.12 or newer. Current Discord voice channels use DAVE encryption, which requires Duck's current voice stack.

2. Install dependencies:

   ```powershell
   npm.cmd install
   ```

3. Copy `config.example.json` to `config.json` and fill in:

   ```json
   {
     "DISCORD_TOKEN": "...",
     "CLIENT_ID": "...",
     "AI_PROVIDER": "openrouter",
     "OPENROUTER_API_KEY": "your_openrouter_api_key_here",
     "OPENROUTER_MODEL": "tencent/hy3:free",
     "AI_CONTEXT_CHANNELS": "all",
     "AI_CONTEXT_MESSAGES_PER_CHANNEL": "10",
     "AI_CONTEXT_FOCUSED_MESSAGES": "50",
     "AI_CONTEXT_BACKGROUND_MESSAGES": "5",
     "AI_CONTEXT_MAX_MESSAGES": "500",
     "AI_CONTEXT_MAX_CHARS": "32000",
     "AI_CONTEXT_MESSAGE_CHARS": "160",
     "AI_CONTEXT_MEMBER_LIMIT": "500",
     "AI_CONTEXT_CHANNEL_LIMIT": "250",
     "AI_CONTEXT_ROLE_LIMIT": "250",
     "AI_CONTEXT_CACHE_TTL_MS": "15000",
     "AI_CHAT_MAX_TOKENS": "700",
     "AI_CHAT_MAX_ATTEMPTS": "3",
     "AI_EXCLUDE_REASONING": "true",
     "PENDING_ACTION_TTL_MS": "1800000",
     "DUCK_QUEUE_MESSAGE": "Duck is thinking...",
     "DUCK_DEBUG": "true",
     "DUCK_DEBUG_AI_BODY": "false"
   }
   ```

   AI config is optional. Leave it out if you want the completely local zero-cost rule planner.

   You can also copy `.env.template` to `.env` and fill that in instead. `.env` is ignored by Git and should not be uploaded publicly.

   To enable the dashboard's **Image CAPTCHA** ticket type, install KaggleHub and download the complete local dataset once on the Duck host:

   ```bash
   python3 -m pip install kagglehub
   npm run setup:captcha
   ```

   The installer uses `kagglehub.dataset_download("parsasam/captcha-dataset")`, copies the extracted dataset into `data/captcha-dataset`, and builds a bounded server-side manifest. Keep `DUCK_CAPTCHA_DATASET_PATH=data/captcha-dataset` unless persistent storage lives elsewhere. The downloaded images and answers are intentionally ignored by Git. If Kaggle requires authentication on the host, configure KaggleHub there and rerun the installer; never commit a Kaggle token.

   AI planner options:

   - OpenRouter hosted AI: set `AI_PROVIDER` to `openrouter`, set `OPENROUTER_API_KEY`, and choose an `OPENROUTER_MODEL`.
   - No account, uses your PC: set `AI_PROVIDER` to `ollama`, install Ollama, then run `ollama pull llama3.1:8b`.
   - Hosted, requires an account/API key: set `AI_PROVIDER` to `openai-compatible`, then set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`.
   - Groq is still supported with `AI_PROVIDER=groq`, `GROQ_API_KEY`, and `GROQ_MODEL`, but do not use it if Groq login is broken for you.

  AI server context is bounded by `AI_CONTEXT_CHANNELS`, `AI_CONTEXT_MESSAGES_PER_CHANNEL`, `AI_CONTEXT_FOCUSED_MESSAGES`, `AI_CONTEXT_BACKGROUND_MESSAGES`, `AI_CONTEXT_MAX_MESSAGES`, `AI_CONTEXT_MAX_CHARS`, `AI_CONTEXT_MESSAGE_CHARS`, `AI_CONTEXT_MEMBER_LIMIT`, `AI_CONTEXT_CHANNEL_LIMIT`, and `AI_CONTEXT_ROLE_LIMIT`. Explicitly targeted channels use the focused allocation; unrelated channels use the background allocation.
   Set `AI_CONTEXT_CHANNELS` to `all` to consider readable text channels; `AI_CONTEXT_ALL_CHANNEL_LIMIT` (default `25`) keeps each request bounded.
   Duck compacts context before model calls so large servers do not overload smaller/free models with too much prompt text.
   Private channel message history is only included when the requester has Administrator and Duck has permission to view/read that channel.
   Server context cache lifetime is controlled by `AI_CONTEXT_CACHE_TTL_MS`; the default is `15000` milliseconds.
   Chat response size is controlled by `AI_CHAT_MAX_TOKENS`; the default is `700`.
   Empty OpenRouter chat responses are retried up to `AI_CHAT_MAX_ATTEMPTS`; retries disable reasoning so a model cannot spend its entire completion budget without visible content.
   AI calls time out through `AI_REQUEST_TIMEOUT_MS`, retry transient transport failures through `AI_HTTP_MAX_ATTEMPTS`, and use `AI_MAX_CONCURRENT_GLOBAL`, `AI_MAX_CONCURRENT_PER_GUILD`, and `AI_MAX_QUEUE_PER_GUILD` for fair admission control.
   OpenRouter reasoning output is excluded by default with `AI_EXCLUDE_REASONING=true`; `AI_REASONING_EFFORT=low` preserves more of the completion budget for the visible answer.
   `AI_VISION_MODE=auto` enables attachments only for recognized vision models and always excludes `tencent/hy3`. Add exact model IDs to `AI_VISION_MODELS` when needed.
   Queue text is controlled by `DUCK_QUEUE_MESSAGE`. Presence is controlled by `DUCK_STATUS_TEXT`, `DUCK_STATUS_TYPE`, and `DUCK_STATUS_STATE`.
   Pending confirmation persistence is bounded by `PENDING_ACTION_TTL_MS`; the default is `1800000` milliseconds, or 30 minutes.
   Debug logging is on by default. Set `DUCK_DEBUG=false` only when you want quieter logs. `DUCK_DEBUG_AI_BODY` can log model output snippets, but should stay `false` unless you are actively debugging.

   Current OpenRouter free models can rotate. As of July 6, 2026, OpenRouter's public model API lists `tencent/hy3:free` with zero prompt and completion pricing.

4. In the Discord Developer Portal, enable these bot privileged gateway intents:

   - Server Members Intent
   - Server Voice States Intent
   - Message Content Intent

5. Invite the bot with these permissions as needed:

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
   - Mute Members
   - Deafen Members
   - Connect
   - Speak

6. Start the bot:

   ```powershell
   npm.cmd start
   ```

7. In Discord, run:

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
  "AI_CONTEXT_CHANNELS": "all",
  "AI_CONTEXT_MESSAGES_PER_CHANNEL": "10",
  "AI_CONTEXT_FOCUSED_MESSAGES": "50",
  "AI_CONTEXT_BACKGROUND_MESSAGES": "5",
  "AI_CONTEXT_MAX_MESSAGES": "500",
  "AI_CONTEXT_MAX_CHARS": "32000",
  "AI_CONTEXT_MESSAGE_CHARS": "160",
  "AI_CONTEXT_MEMBER_LIMIT": "500",
  "AI_CONTEXT_CHANNEL_LIMIT": "250",
  "AI_CONTEXT_ROLE_LIMIT": "250",
  "AI_CONTEXT_CACHE_TTL_MS": "15000",
  "AI_CHAT_MAX_TOKENS": "700",
  "AI_CHAT_MAX_ATTEMPTS": "3",
  "AI_EXCLUDE_REASONING": "true",
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

Debug logging is on by default. Set `DUCK_DEBUG=false` to quiet it down.

Startup logs include package version, commit hash, commit name, branch, selected AI provider/model, and redacted API key information. Debug logs include context cache hits/misses, OpenRouter/Ollama HTTP status codes, slow/failing AI requests, planner results, queue timing, confirmation lifecycle, and moderation execution results.

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
- `voice mute @user reason`
- `voice unmute @user reason`
- `deafen @user reason`
- `undeafen @user reason`
- `delete 10 messages from @user`
- `create text channel "mod-log"`
- `create voice channel "General Voice"`
- `rename channel #general "main-chat"`
- `set topic #general "Main server chat"`
- `create role "Helper"`
- `delete role "Old Role"`
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
