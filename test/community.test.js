import assert from "node:assert/strict";
import test from "node:test";
import { PermissionsBitField } from "discord.js";
import { assertCanPublishTo, createTicketVerificationPhrase, isTicketStaff, normalizeTicketVerificationAnswer, ticketClosePermissionOverwrites } from "../src/community.js";

test("ticket verification phrases are human-readable and comparison is forgiving about case and spacing", () => {
  const values = [0, 3, 164_743];
  const ranges = [];
  const phrase = createTicketVerificationPhrase((...range) => { ranges.push(range); return values.shift(); });
  assert.equal(phrase, "Apple Honeycomb 164,743");
  assert.equal(normalizeTicketVerificationAnswer("  apple   HONEYCOMB 164,743 "), normalizeTicketVerificationAnswer(phrase));
  assert.deepEqual(ranges[2], [1, 1_000_000]);
});

test("ticket CAPTCHA enforcement exempts owners, permission staff, and configured support roles", () => {
  const ownerId = "1138897388694687834";
  const supportRoleId = "223456789012345678";
  const interaction = (userId, permissions = [], roles = []) => ({ user: { id: userId }, guild: { ownerId }, memberPermissions: { has: (permission) => permissions.includes(permission) }, member: { roles: { cache: new Map(roles.map((id) => [id, {}])) } } });
  assert.equal(isTicketStaff(interaction(ownerId), {}), true);
  assert.equal(isTicketStaff(interaction("323456789012345678", [PermissionsBitField.Flags.ManageMessages]), {}), true);
  assert.equal(isTicketStaff(interaction("323456789012345678", [], [supportRoleId]), { ticketSupportRoleId: supportRoleId }), true);
  assert.equal(isTicketStaff(interaction("323456789012345678"), { ticketSupportRoleId: supportRoleId }), false);
});

test("panel publishing reports missing Discord channel permissions", () => {
  const me = { permissions: new PermissionsBitField(PermissionsBitField.Flags.ManageRoles) };
  const guild = { members: { me } };
  const allowed = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
  ]);
  assert.equal(assertCanPublishTo(guild, { name: "roles", permissionsFor: () => allowed }), me);
  assert.throws(
    () => assertCanPublishTo(guild, { name: "roles", permissionsFor: () => new PermissionsBitField(PermissionsBitField.Flags.ViewChannel) }),
    /Send Messages, Embed Links/,
  );
});

test("ticket close removes the stale owner overwrite without touching staff access", () => {
  const everyone = { id: "100000000000000001", type: 0, allow: 0n, deny: 1n };
  const owner = { id: "100000000000000002", type: 1, allow: 3n, deny: 0n };
  const staff = { id: "100000000000000003", type: 0, allow: 7n, deny: 0n };
  const channel = { permissionOverwrites: { cache: new Map([[everyone.id, everyone], [owner.id, owner], [staff.id, staff]]) } };
  const result = ticketClosePermissionOverwrites(channel, owner.id);
  assert.deepEqual(result.map(({ id }) => id), [everyone.id, staff.id]);
  assert.equal(result[1].allow, 7n);
});
