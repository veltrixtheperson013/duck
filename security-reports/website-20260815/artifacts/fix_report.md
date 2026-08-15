# Website Security Fix Report

## Outcome

All seven findings in this scan were remediated in the working tree and covered by automated regression tests.

## Fixes

1. Private channel exposure: settings reads and writes now resolve the authenticated Discord member and require effective `ViewChannel` access.
2. Persistent warning growth: warning history is bounded per member, per guild, and globally, including legacy-data normalization.
3. Rate-state growth: attacker-keyed maps are pruned and capped on insertion, with a separate global request ceiling.
4. Discord dependency exhaustion: Discord requests now have deadlines, bounded response bodies, normalized response shapes, refresh deduplication, and per-session/global concurrency limits.
5. Stripe subscription race: checkout creation is locked and persisted per guild, webhook state is reconciled with Stripe, and subscription/purchaser identity is bound server-side.
6. Stale manager reads: tenant-sensitive settings reads now refresh Discord authorization.
7. GET side effects: donation Checkout creation now requires a same-origin JSON `POST` and uses a dedicated rate limit.

## Additional Boundary Hardening

- JSON requests require the correct media type, bounded size/depth/node count, plain shapes, exact allowlisted fields, and strict primitive types.
- Dangerous prototype-related keys are rejected before configuration processing.
- Billing management is restricted to the original purchaser or current Discord guild owner.
- Provider redirects are restricted to exact HTTPS Stripe hosts.
- Malformed cookies fail closed; HTTP header, connection, and security-header limits were tightened.
- The browser only requests actions. Guild identity, authorization, entitlements, channel visibility, billing state, and persisted values are decided and validated by the server.

## Verification

- `npm run check`
- `npm run lint`
- `npm test`
- `git diff --check`

Regression coverage includes cross-account tenancy, hidden-channel denial, stale permission refresh, malformed and prototype-polluting JSON, wrong media types, bounded rate state and warning persistence, Discord deadlines, donation method/origin enforcement, duplicate checkouts, billing ownership, competing subscriptions, and equal-second webhook reconciliation.
