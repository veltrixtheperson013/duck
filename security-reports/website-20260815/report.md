# Security Review: Duck

## Scope

Repository-wide audit emphasizing the public browser-to-backend trust boundary.

- Scan mode: repository
- Target kind: git_revision
- Target ID: c116427097e9261dcde23fe5c1bada00c2ca5b37
- Revision: c116427097e9261dcde23fe5c1bada00c2ca5b37
- Inventory strategy: repository
- Included paths: src/, public/, scripts/, test/, package.json, config.example.json, index.js
- Excluded paths: node_modules/, .env, security-reports/
- Runtime or test status: not recorded
- Scan context: All frontend input is hostile; the server owns authorization, tenancy, entitlements, validation, and sensitive operations.

Limitations and exclusions:
- Excluded .env: Ignored live secrets were excluded from source review and were not printed or modified.
- Excluded node_modules/: Third-party source was covered through package audit rather than line-by-line product review.
- Excluded security-reports/: Prior generated scan artifacts are not product source.

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 7 |
| Severity mix | medium: 5, low: 2 |
| Confidence mix | high: 6, medium: 1 |
| Coverage | complete |
| Validation mode | static source validation with independent baseline and focused investigators |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Duck exposes a public Node HTTP service backed by Discord OAuth, Discord bot privileges, local per-guild persistence, third-party AI providers, and Stripe. Attackers include unauthenticated internet clients, authenticated Discord users, restricted guild managers, malicious guild members, and reordered but valid third-party events.

### Assets

- Discord OAuth sessions and tokens
- per-guild settings and channel metadata
- Discord bot moderation privileges
- Stripe subscription ownership and entitlement
- process memory and persistent JSON state

### Trust Boundaries

- internet browser to Duck HTTP server
- Duck server to Discord OAuth and REST
- Duck server to Stripe API and signed webhooks
- validated dashboard settings to Discord bot runtime
- guild tenant to guild tenant

### Attacker Capabilities

- send arbitrary HTTP methods, headers, cookies, URLs, and JSON
- authenticate with a Discord account
- hold Manage Server while being denied private channel access
- send repeated Discord messages
- trigger concurrent checkout flows

### Security Objectives

- make authorization and entitlement decisions only on the server
- prevent cross-guild and private-channel access
- bound attacker-controlled memory, disk, queues, and outbound work
- bind billing state to one canonical subscription
- prevent injection and arbitrary code execution

### Assumptions

- Discord and Stripe TLS endpoints are authentic
- Stripe webhook secrets and Discord OAuth credentials remain secret
- Wispbyte forwards traffic to the configured local listener

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Manage Server users can enumerate and target channels they cannot view](#finding-1) | medium | high | inline below |
| [Persistent warning histories grow without a retention bound](#finding-2) | medium | high | inline below |
| [Rate-limit state grows without bound for new source addresses](#finding-3) | medium | high | inline below |
| [Discord API calls lack application deadlines and concurrency bounds](#finding-4) | medium | high | inline below |
| [Competing Stripe subscriptions can overwrite one guild entitlement](#finding-5) | medium | medium | inline below |
| [Recently revoked managers retain a brief settings-read window](#finding-6) | low | high | inline below |
| [Public GET requests create Stripe Checkout sessions](#finding-7) | low | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Manage Server users can enumerate and target channels they cannot view

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The GET and PUT routes share a helper that only checks bot-visible channels. |
| Category | broken-access-control |
| CWE | CWE-862 |
| Affected lines | src/web.js:43, src/web.js:112-113, src/core.js:6570-6659 |

#### Summary

Dashboard channel lists and destination validation use Duck's visibility but omit the requester's effective View Channel permission.

#### Root Cause

Guild-level Manage Server authorization was treated as permission to see and target every channel visible to the bot.

#### Validation

Validated by tracing settings GET/PUT from OAuth guild permission checks through getGuildTextChannels to stored welcome and logging destinations.

#### Dataflow

Restricted manager -\> settings route -\> bot-visible channel list -\> persisted destination -\> Discord send.

#### Reachability

Reachable with Manage Server and an explicit private-channel View Channel denial.

#### Severity

**Medium** — An authenticated restricted manager can discover private channels and cause Duck to publish configured content or logs there.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Resolve the authenticated guild member and require their effective ViewChannel permission for every returned and submitted channel.

<a id="finding-2"></a>

### [2] Persistent warning histories grow without a retention bound

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The mutation is an unconditional array push and all existing limits apply only to separate runtime maps. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | src/config.js:162-173, src/automod.js:81-150, src/core.js:3994-4007 |

#### Summary

AutoMod and custom actions append warnings indefinitely and rewrite or display the full history.

#### Root Cause

Persistent warning arrays have no per-member, per-guild, or global retention policy.

#### Validation

Repeated automatic warnings reach addMemberWarning even when Discord hierarchy prevents the configured escalation from removing the sender.

#### Dataflow

Repeated violating messages -\> warning push -\> full JSON rewrite and full-history formatting.

#### Reachability

Reachable by non-exempt guild members when AutoMod or a custom warn action is enabled.

#### Severity

**Medium** — An unmanageable guild member can drive persistent disk, serialization, and response amplification over time.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Retain a bounded number of warnings per member and bounded warned-member counts per guild and globally; normalize legacy data during load.

<a id="finding-3"></a>

### [3] Rate-limit state grows without bound for new source addresses

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | The early return directly bypasses every eviction branch. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | src/web.js:80, src/web.js:89, src/web.js:100-101 |

#### Summary

The limiter returns immediately after inserting a new key, skipping its own pruning and 10,000-entry cap.

#### Root Cause

Attacker-keyed state is bounded only on the repeated-key path, not before every insertion.

#### Validation

A unique remoteAddress and route bucket always executes set followed by return while map size is unchecked.

#### Dataflow

Rotating public addresses -\> request key insertion -\> process-lifetime Map growth.

#### Reachability

All public routes reach the limiter before authentication.

#### Severity

**Medium** — Unauthenticated rotated source addresses can grow process memory until service degradation.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Prune and cap the map on every path before returning, and add a global request ceiling independent of client identity.

<a id="finding-4"></a>

### [4] Discord API calls lack application deadlines and concurrency bounds

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Every reviewed Discord fetch lacks AbortSignal, bounded response reads, and in-flight accounting. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | src/web.js:90-91, src/web.js:106, src/web.js:110 |

#### Summary

OAuth and authenticated guild requests can accumulate unbounded pending outbound fetches and JSON response work.

#### Root Cause

Inbound socket limits were present, but dependency work had no corresponding deadline, response-size, or concurrency policy.

#### Validation

Authenticated /api/guilds calls each start a fresh fetch and response.json without application bounds.

#### Dataflow

Authenticated requests -\> Discord fetch -\> pending handlers and response buffers.

#### Reachability

Reachable after normal Discord OAuth authentication, especially during upstream degradation.

#### Severity

**Medium** — A malicious authenticated user can amplify Discord latency into process exhaustion.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Add abort deadlines, byte-limited JSON reads, refresh deduplication, and global/per-session in-flight limits.

<a id="finding-5"></a>

### [5] Competing Stripe subscriptions can overwrite one guild entitlement

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | medium |
| Confidence rationale | The source establishes the race; practical impact depends on checkout completion and Stripe delivery order. |
| Category | race-condition |
| CWE | CWE-367 |
| Affected lines | src/web.js:117, src/web.js:122, src/stripe.js:115-143 |

#### Summary

Concurrent pre-activation checkouts and equal-second webhook delivery are not bound to one canonical subscription identity.

#### Root Cause

Checkout has no pending lock, while webhook state accepts any supported subscription for the guild and compares only second-resolution event times.

#### Validation

Multiple sessions can be created before any webhook marks the guild active; later valid events overwrite subscriptionId and customerId.

#### Dataflow

Concurrent manager checkouts -\> multiple Stripe subscriptions -\> signed events -\> last accepted guild subscription record.

#### Reachability

Requires fresh Manage Server authorization and completing competing Stripe subscription flows.

#### Severity

**Medium** — A guild manager can create competing flows whose valid events corrupt entitlement and portal ownership.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Persist and lock pending checkout ownership, bind a guild to one subscription ID, and reconcile webhook state against Stripe's canonical subscription snapshot.

<a id="finding-6"></a>

### [6] Recently revoked managers retain a brief settings-read window

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | The GET route explicitly uses guildAccess's non-fresh default. |
| Category | incorrect-authorization |
| CWE | CWE-863 |
| Affected lines | src/web.js:93, src/web.js:112 |

#### Summary

Settings GET reuses a 30-second cached Discord guild permission snapshot.

#### Root Cause

A latency cache for guild lists doubles as the authorization source for tenant-sensitive reads.

#### Validation

After /api/guilds populates the cache, settings GET does not call Discord again for up to 30 seconds.

#### Dataflow

Cached former permission -\> settings GET -\> per-guild settings and metadata response.

#### Reachability

Requires membership or permission revocation within the cache window.

#### Severity

**Low** — Revoked users can briefly read tenant settings and metadata but all writes already refresh authorization.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Refresh Discord authorization for tenant-scoped settings reads.

<a id="finding-7"></a>

### [7] Public GET requests create Stripe Checkout sessions

| Field | Value |
| --- | --- |
| Severity | low |
| Confidence | high |
| Confidence rationale | Static donation links directly target the GET side-effect route. |
| Category | resource-exhaustion |
| CWE | CWE-400 |
| Affected lines | public/donate.html:9, src/web.js:109 |

#### Summary

Donation links expose provider-side resource creation through an unauthenticated safe-method route in the broad web rate bucket.

#### Root Cause

A resource-creating operation was modeled as a crawlable GET and given the generic public rate limit.

#### Validation

Any GET with one of six allowed amounts immediately invokes stripe.checkout.sessions.create.

#### Dataflow

Cross-site navigation or crawler -\> GET donation route -\> Stripe session creation.

#### Reachability

Unauthenticated and publicly linked.

#### Severity

**Low** — Cross-site pages and crawlers can create abandoned sessions and consume outbound/provider capacity, but cannot charge users.

Additional runtime or deployment evidence could raise or lower this severity.

#### Remediation

Use a same-origin POST interaction and a strict billing-specific plus global creation limit.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Public HTTP parsing, rate limiting, sessions, and OAuth | availability and authentication | Reported | No additional canonical notes were recorded. |
| Guild tenancy and channel authorization | broken access control | Reported | No additional canonical notes were recorded. |
| Dashboard JSON validation and persistence | injection and tenant integrity | No issue found | No additional canonical notes were recorded. |
| Stripe checkout, portal, cancellation, and webhooks | billing integrity and availability | Reported | No additional canonical notes were recorded. |
| Server branding image uploads | unrestricted upload | No issue found | No additional canonical notes were recorded. |
| CSP, DOM sinks, redirects, and data exposure | XSS and information disclosure | No issue found | No additional canonical notes were recorded. |
| Persisted settings, AutoMod, AI tools, and Discord side effects | authorization and resource exhaustion | Reported | No additional canonical notes were recorded. |
