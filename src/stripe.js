import Stripe from "stripe";

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const DONATION_AMOUNTS = new Set([1, 5, 10, 20, 50, 100]);

let cachedClient = null;
let cachedKey = null;

function isPlusEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.DUCK_PLUS_ENABLED || "").trim());
}

function getStripeClient() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey) return null;
  if (!cachedClient || cachedKey !== secretKey) {
    cachedClient = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15_000 });
    cachedKey = secretKey;
  }
  return cachedClient;
}

function getPlusPriceId(period) {
  const key = period === "year" ? "STRIPE_PLUS_YEARLY_PRICE_ID" : "STRIPE_PLUS_MONTHLY_PRICE_ID";
  const priceId = String(process.env[key] || "").trim();
  return /^price_[a-z0-9]+$/i.test(priceId) ? priceId : null;
}

function getPublicBaseUrl() {
  const raw = String(process.env.DUCK_PUBLIC_URL || "https://duck.wispbyte.app").trim();
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error();
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw Object.assign(new Error("DUCK_PUBLIC_URL must be a valid HTTPS URL."), { status: 503 });
  }
}

function isStripeServerConfigured() {
  return Boolean(
    isPlusEnabled()
      && String(process.env.STRIPE_SECRET_KEY || "").trim()
      && String(process.env.STRIPE_WEBHOOK_SECRET || "").trim()
      && getPlusPriceId("month")
      && getPlusPriceId("year"),
  );
}

function makePlusCheckoutInput({ guildId, discordUserId, period }) {
  if (!isPlusEnabled()) throw Object.assign(new Error("Duck Plus is currently unavailable."), { status: 503 });
  const priceId = getPlusPriceId(period);
  if (!priceId) throw Object.assign(new Error("That Duck Plus billing period is not configured."), { status: 503 });
  const baseUrl = getPublicBaseUrl();
  const metadata = { duck_guild_id: guildId, duck_discord_user_id: discordUserId };
  return {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: guildId,
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true,
    success_url: `${baseUrl}/dashboard?billing=success&guild=${encodeURIComponent(guildId)}`,
    cancel_url: `${baseUrl}/dashboard?billing=canceled&guild=${encodeURIComponent(guildId)}`,
  };
}

function makeDonationCheckoutInput(amount) {
  if (!DONATION_AMOUNTS.has(amount)) throw Object.assign(new Error("Choose a valid support amount."), { status: 400 });
  const baseUrl = getPublicBaseUrl();
  return {
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: amount * 100,
        product_data: { name: "Support Duck development", description: "One-time support for Duck's development and server costs." },
      },
    }],
    metadata: { duck_payment_type: "development_support", duck_support_amount: String(amount) },
    success_url: `${baseUrl}/donate?thanks=1`,
    cancel_url: `${baseUrl}/donate`,
  };
}

function getSubscriptionPriceId(subscription) {
  return subscription?.items?.data?.find((item) => item?.price?.id)?.price?.id ?? null;
}

function getSubscriptionPeriodEnd(subscription, priceId) {
  const matchingItem = subscription?.items?.data?.find((item) => item?.price?.id === priceId);
  return matchingItem?.current_period_end ?? subscription?.current_period_end ?? null;
}

function isDuckPlusPrice(priceId) {
  return Boolean(priceId && [getPlusPriceId("month"), getPlusPriceId("year")].includes(priceId));
}

function unixTimeToIso(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function makeStripeSubscriptionPatch(event) {
  if (!SUBSCRIPTION_EVENTS.has(event?.type)) return null;
  const subscription = event?.data?.object;
  const guildId = String(subscription?.metadata?.duck_guild_id || "");
  const purchaserId = String(subscription?.metadata?.duck_discord_user_id || "");
  const priceId = getSubscriptionPriceId(subscription);
  if (!/^\d{10,}$/.test(guildId) || !isDuckPlusPrice(priceId)) return null;
  const status = String(subscription.status || "inactive");
  const entitled = ["active", "trialing"].includes(status);
  const occurredAt = unixTimeToIso(event.created);
  return {
    guildId,
    eventId: event.id,
    occurredAt,
    subscription: {
      provider: "stripe",
      tier: entitled ? "plus" : "free",
      status,
      startedAt: unixTimeToIso(subscription.created),
      expiresAt: entitled ? unixTimeToIso(getSubscriptionPeriodEnd(subscription, priceId)) : null,
      customerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null,
      subscriptionId: subscription.id,
      purchaserId: /^\d{10,}$/.test(purchaserId) ? purchaserId : null,
      priceId,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      canceledAt: unixTimeToIso(subscription.canceled_at),
      eventId: event.id,
      eventCreatedAt: occurredAt,
      updatedAt: new Date().toISOString(),
    },
  };
}

export {
  getPublicBaseUrl,
  getStripeClient,
  getPlusPriceId,
  isPlusEnabled,
  isStripeServerConfigured,
  makeDonationCheckoutInput,
  makePlusCheckoutInput,
  makeStripeSubscriptionPatch,
};
