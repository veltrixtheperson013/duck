import { hasPlusEntitlement } from "./dashboard-config.js";

export const PLUS_TRIAL_MS = 7 * 24 * 60 * 60 * 1000;
export function trialAvailable(settings, now = Date.now()) {
  return !settings?.plusTrialUsedAt && !settings?.subscription?.trialUsedAt && !hasPlusEntitlement(settings, now) && !settings?.subscription?.subscriptionId;
}
export function claimTrial(settings, userId, now = Date.now()) {
  if (!trialAvailable(settings, now)) throw Object.assign(new Error("This server has already used its Plus trial or already has a subscription."), { status: 409 });
  const startedAt = new Date(now).toISOString();
  return { plusTrialUsedAt: startedAt, subscription: { tier: "plus", status: "trialing", provider: "trial", startedAt, trialUsedAt: startedAt, expiresAt: new Date(now + PLUS_TRIAL_MS).toISOString(), claimedBy: userId, cancelAtPeriodEnd: true } };
}
