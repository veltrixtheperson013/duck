import assert from "node:assert/strict";
import test from "node:test";
import { PermissionsBitField } from "discord.js";
import { assertCanPublishTo, ticketClosePermissionOverwrites } from "../src/community.js";

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
