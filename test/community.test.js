import assert from "node:assert/strict";
import test from "node:test";
import { PermissionsBitField } from "discord.js";
import { assertCanPublishTo } from "../src/community.js";

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
