'use strict';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-abcdefghijkl';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghijkl';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { createApp } = require('../src/app');
const { createGroupsRepo } = require('../src/modules/groups/groups.repo');
const { createTestPool, fakeMailer, uniqueIp } = require('./helpers/test-db');

async function withApp(t, fn) {
  const pool = await createTestPool();
  const mailer = fakeMailer();
  const app = createApp({ pool, mailer });
  try {
    await fn({ app, pool, mailer });
  } finally {
    if (pool.end) await pool.end();
  }
}

async function registerAndVerify(app, mailer, { username, email, password = 'strongPassword123' }) {
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .set('X-Forwarded-For', uniqueIp())
    .send({ username, email, password, displayName: username });
  const data = reg.body.data;
  const mail = mailer.sent.find((m) => m.type === 'email_verify' && m.to === email);
  await request(app)
    .post('/api/v1/auth/email/verify')
    .set('X-Forwarded-For', uniqueIp())
    .send({ token: mail.token });
  return data;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const fwd = () => ({ 'X-Forwarded-For': uniqueIp() });

async function createOneToOne(pool, userIds) {
  const convId = crypto.randomUUID();
  await pool.query(`INSERT INTO conversations (id, kind) VALUES ($1, 'one_to_one')`, [convId]);
  for (const uid of userIds) {
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'member')`,
      [convId, uid]
    );
  }
  return convId;
}

async function insertMedia(pool, { id, ownerId, status = 'ready' }) {
  await pool.query(
    `INSERT INTO media_objects (id, owner_user_id, s3_key, media_type, content_type, status)
     VALUES ($1, $2, $3, 'image', 'image/jpeg', $4)`,
    [id, ownerId, `test/${id}.jpg`, status]
  );
}

async function createGroup(app, token, body) {
  return request(app)
    .post('/api/v1/conversations/groups')
    .set(auth(token))
    .set(fwd())
    .send({ name: 'Test Group', ...body });
}

const msgBody = (overrides = {}) => ({
  messageType: 'text',
  ciphertext: 'enc',
  nonce: 'nonce',
  authTag: 'tag',
  ...overrides,
});

test('groups: create + roles + detail', async (t) => {
  await t.test('create group → owner + members; detail members list; non-member 403', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const carol = await registerAndVerify(app, mailer, { username: 'carol_01', email: 'carol@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });

      const created = await createGroup(app, alice.accessToken, {
        name: 'Fam Group',
        description: 'Ghar ki baatein',
        memberUserIds: [bob.user.id, carol.user.id],
      });
      assert.equal(created.status, 201);
      const conversation = created.body.data.conversation;
      assert.equal(conversation.kind, 'group');
      assert.equal(conversation.name, 'Fam Group');
      assert.equal(conversation.createdBy, alice.user.id);
      const roles = Object.fromEntries(conversation.members.map((m) => [m.userId, m.role]));
      assert.equal(roles[alice.user.id], 'owner');
      assert.equal(roles[bob.user.id], 'member');
      assert.equal(roles[carol.user.id], 'member');

      // Member detail dekhta hai.
      const detail = await request(app)
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.conversation.myRole, 'member');
      assert.equal(detail.body.data.conversation.members.length, 3);

      // Non-member → 403.
      const stranger = await request(app)
        .get(`/api/v1/conversations/${conversation.id}`)
        .set(auth(eve.accessToken))
        .set(fwd());
      assert.equal(stranger.status, 403);
      assert.equal(stranger.body.error.code, 'NOT_CONVERSATION_MEMBER');
    });
  });

  await t.test('empty name → 400; unknown member id → 404', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

      const empty = await createGroup(app, alice.accessToken, { name: '   ' });
      assert.equal(empty.status, 400);
      // REST layer par zod trim/min se VALIDATION_ERROR hi aata hai
      // (service ka GROUP_NAME_REQUIRED socket path ka backstop hai).
      assert.equal(empty.body.error.code, 'VALIDATION_ERROR');

      const badMember = await createGroup(app, alice.accessToken, {
        name: 'X',
        memberUserIds: [crypto.randomUUID()],
      });
      assert.equal(badMember.status, 404);
      assert.equal(badMember.body.error.code, 'USER_NOT_FOUND');
    });
  });
});

test('groups: permission matrix — member vs admin vs owner', async (t) => {
  await t.test('member sab restricted; admin manage kar sakta hai; owner sab', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const carol = await registerAndVerify(app, mailer, { username: 'carol_01', email: 'carol@example.com' });
      const dave = await registerAndVerify(app, mailer, { username: 'dave_01', email: 'dave@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });

      const created = await createGroup(app, alice.accessToken, {
        name: 'Matrix',
        memberUserIds: [bob.user.id, carol.user.id, dave.user.id],
      });
      const convId = created.body.data.conversation.id;

      // Member (bob): patch/invite/remove/role sab 403.
      const memberPatch = await request(app)
        .patch(`/api/v1/conversations/${convId}`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ name: 'Hacked' });
      assert.equal(memberPatch.status, 403);
      assert.equal(memberPatch.body.error.code, 'INSUFFICIENT_ROLE');

      const memberInvite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ userId: eve.user.id });
      assert.equal(memberInvite.status, 403);

      const memberRemove = await request(app)
        .delete(`/api/v1/conversations/${convId}/members/${carol.user.id}`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(memberRemove.status, 403);

      const memberRole = await request(app)
        .post(`/api/v1/conversations/${convId}/members/${carol.user.id}/role`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ role: 'admin' });
      assert.equal(memberRole.status, 403);

      // Owner bob ko admin banata hai.
      const promote = await request(app)
        .post(`/api/v1/conversations/${convId}/members/${bob.user.id}/role`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ role: 'admin' });
      assert.equal(promote.status, 200);

      // Admin (bob): patch/invite chalte hain.
      const adminPatch = await request(app)
        .patch(`/api/v1/conversations/${convId}`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ description: 'Admin edited' });
      assert.equal(adminPatch.status, 200);
      assert.equal(adminPatch.body.data.conversation.description, 'Admin edited');

      const adminInvite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ userId: eve.user.id });
      assert.equal(adminInvite.status, 201);

      // Admin regular member remove kar sakta hai...
      const adminRemoveMember = await request(app)
        .delete(`/api/v1/conversations/${convId}/members/${carol.user.id}`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(adminRemoveMember.status, 200);

      // ...lekin admin/owner ko nahi.
      // Pehle owner dave ko admin banata hai, phir bob (admin) usse remove nahi kar sakta.
      const promoteDave = await request(app)
        .post(`/api/v1/conversations/${convId}/members/${dave.user.id}/role`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ role: 'admin' });
      assert.equal(promoteDave.status, 200);

      const adminRemoveAdmin = await request(app)
        .delete(`/api/v1/conversations/${convId}/members/${dave.user.id}`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(adminRemoveAdmin.status, 403);
      assert.equal(adminRemoveAdmin.body.error.code, 'INSUFFICIENT_ROLE');

      // Admin role change nahi kar sakta.
      const adminRole = await request(app)
        .post(`/api/v1/conversations/${convId}/members/${dave.user.id}/role`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send({ role: 'member' });
      assert.equal(adminRole.status, 403);
    });
  });
});

test('groups: invite flow — accept/decline/re-invite/block', async (t) => {
  await t.test('pending list + accept + member join; re-accept 409', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const dave = await registerAndVerify(app, mailer, { username: 'dave_01', email: 'dave@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'Invites' });
      const convId = created.body.data.conversation.id;

      const invite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: dave.user.id });
      assert.equal(invite.status, 201);
      const inviteId = invite.body.data.invite.id;
      assert.equal(invite.body.data.invite.inviteeUserId, dave.user.id);
      assert.equal(invite.body.data.invite.status, 'pending');
      assert.equal(invite.body.data.invite.conversationName, 'Invites');

      // Dave ki pending list.
      const pending = await request(app).get('/api/v1/invites').set(auth(dave.accessToken)).set(fwd());
      assert.equal(pending.status, 200);
      assert.equal(pending.body.data.invites.length, 1);
      assert.equal(pending.body.data.invites[0].id, inviteId);
      assert.equal(pending.body.data.invites[0].inviterUsername, 'alice_01');

      // Accept → member ban jata hai.
      const accepted = await request(app)
        .post(`/api/v1/invites/${inviteId}/accept`)
        .set(auth(dave.accessToken))
        .set(fwd());
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.invite.status, 'accepted');

      const members = await request(app)
        .get(`/api/v1/conversations/${convId}/members`)
        .set(auth(dave.accessToken))
        .set(fwd());
      assert.equal(members.status, 200);
      assert.ok(members.body.data.members.some((m) => m.userId === dave.user.id));

      // Dobara accept → 409.
      const again = await request(app)
        .post(`/api/v1/invites/${inviteId}/accept`)
        .set(auth(dave.accessToken))
        .set(fwd());
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'INVITE_ALREADY_HANDLED');
    });
  });

  await t.test('decline + re-invite same row update; stranger accept 403; self invite 400; already member 409', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const carol = await registerAndVerify(app, mailer, { username: 'carol_01', email: 'carol@example.com' });
      const dave = await registerAndVerify(app, mailer, { username: 'dave_01', email: 'dave@example.com' });

      const created = await createGroup(app, alice.accessToken, {
        name: 'Invites2',
        memberUserIds: [bob.user.id],
      });
      const convId = created.body.data.conversation.id;

      // Self invite → 400.
      const selfInvite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: alice.user.id });
      assert.equal(selfInvite.status, 400);
      assert.equal(selfInvite.body.error.code, 'CANNOT_INVITE_SELF');

      // Already member → 409.
      const dupInvite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: bob.user.id });
      assert.equal(dupInvite.status, 409);
      assert.equal(dupInvite.body.error.code, 'ALREADY_MEMBER');

      // Decline flow.
      const invite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: carol.user.id });
      const inviteId = invite.body.data.invite.id;

      // Stranger (dave) accept nahi kar sakta.
      const strangerAccept = await request(app)
        .post(`/api/v1/invites/${inviteId}/accept`)
        .set(auth(dave.accessToken))
        .set(fwd());
      assert.equal(strangerAccept.status, 403);
      assert.equal(strangerAccept.body.error.code, 'NOT_INVITE_RECIPIENT');

      const declined = await request(app)
        .post(`/api/v1/invites/${inviteId}/decline`)
        .set(auth(carol.accessToken))
        .set(fwd());
      assert.equal(declined.status, 200);
      assert.equal(declined.body.data.invite.status, 'declined');

      // Re-invite → same row pending (same invite id).
      const reInvite = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: carol.user.id });
      assert.equal(reInvite.status, 201);
      assert.equal(reInvite.body.data.invite.id, inviteId);
      assert.equal(reInvite.body.data.invite.status, 'pending');

      const row = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_invites WHERE conversation_id = $1', [convId]);
      assert.equal(row.rows[0].n, 1);
    });
  });

  await t.test('blocked (dono directions) → invite 403', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const dave = await registerAndVerify(app, mailer, { username: 'dave_01', email: 'dave@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'Blocked' });
      const convId = created.body.data.conversation.id;

      // Alice ne dave ko block kiya.
      await request(app)
        .post(`/api/v1/users/${dave.user.id}/block`)
        .set(auth(alice.accessToken))
        .set(fwd());
      const blocked = await request(app)
        .post(`/api/v1/conversations/${convId}/invites`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ userId: dave.user.id });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.error.code, 'CANNOT_INVITE_USER');
    });
  });
});

test('groups: leave + remove + role + delete', async (t) => {
  await t.test('member leave → left; owner leave → 403; left member access → 403', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'Leave', memberUserIds: [bob.user.id] });
      const convId = created.body.data.conversation.id;

      const ownerLeave = await request(app)
        .post(`/api/v1/conversations/${convId}/leave`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(ownerLeave.status, 403);
      assert.equal(ownerLeave.body.error.code, 'OWNER_CANNOT_LEAVE');

      const left = await request(app)
        .post(`/api/v1/conversations/${convId}/leave`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(left.status, 200);

      const after = await request(app)
        .get(`/api/v1/conversations/${convId}/members`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(after.status, 403);
      assert.equal(after.body.error.code, 'NOT_CONVERSATION_MEMBER');
    });
  });

  await t.test('remove unknown member → 404; remove self → 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'Remove' });
      const convId = created.body.data.conversation.id;

      const unknown = await request(app)
        .delete(`/api/v1/conversations/${convId}/members/${crypto.randomUUID()}`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error.code, 'MEMBER_NOT_FOUND');

      const self = await request(app)
        .delete(`/api/v1/conversations/${convId}/members/${alice.user.id}`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(self.status, 400);
      assert.equal(self.body.error.code, 'CANNOT_REMOVE_SELF');
    });
  });

  await t.test('delete group → cascade; non-owner 403; one_to_one patch → 400', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'DeleteMe', memberUserIds: [bob.user.id] });
      const convId = created.body.data.conversation.id;

      // Message daal dete hain — delete par cascade hona chahiye.
      await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(msgBody());
      const before = await pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
      assert.equal(before.rows[0].n, 1);

      const forbidden = await request(app)
        .delete(`/api/v1/conversations/${convId}`)
        .set(auth(bob.accessToken))
        .set(fwd());
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.body.error.code, 'INSUFFICIENT_ROLE');

      const deleted = await request(app)
        .delete(`/api/v1/conversations/${convId}`)
        .set(auth(alice.accessToken))
        .set(fwd());
      assert.equal(deleted.status, 200);

      const messagesAfter = await pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
      assert.equal(messagesAfter.rows[0].n, 0);
      const convAfter = await pool.query('SELECT COUNT(*)::int AS n FROM conversations WHERE id = $1', [convId]);
      assert.equal(convAfter.rows[0].n, 0);

      // one_to_one par group ops nahi chalte.
      const o2o = await createOneToOne(pool, [alice.user.id, bob.user.id]);
      const o2oPatch = await request(app)
        .patch(`/api/v1/conversations/${o2o}`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send({ name: 'Nope' });
      assert.equal(o2oPatch.status, 400);
      assert.equal(o2oPatch.body.error.code, 'NOT_GROUP_CONVERSATION');
    });
  });
});

test('groups: update group name/description/icon', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });

    const created = await createGroup(app, alice.accessToken, { name: 'Old Name' });
    const convId = created.body.data.conversation.id;

    const mediaId = crypto.randomUUID();
    await insertMedia(pool, { id: mediaId, ownerId: alice.user.id });

    const updated = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ name: 'New Name', description: 'Desc', iconMediaId: mediaId });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.conversation.name, 'New Name');
    assert.equal(updated.body.data.conversation.description, 'Desc');
    assert.equal(updated.body.data.conversation.iconMediaId, mediaId);

    // Icon remove (null).
    const iconRemoved = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ iconMediaId: null });
    assert.equal(iconRemoved.status, 200);
    assert.equal(iconRemoved.body.data.conversation.iconMediaId, null);

    // Empty name → 400; empty patch → 400.
    const emptyName = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({ name: ' ' });
    assert.equal(emptyName.status, 400);
    const nothing = await request(app)
      .patch(`/api/v1/conversations/${convId}`)
      .set(auth(alice.accessToken))
      .set(fwd())
      .send({});
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.error.code, 'NOTHING_TO_UPDATE');
  });
});

test('groups: group messaging + media attach', async (t) => {
  await t.test('member send → 201; non-member → 403', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });
      const eve = await registerAndVerify(app, mailer, { username: 'eve_01', email: 'eve@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'Chat', memberUserIds: [bob.user.id] });
      const convId = created.body.data.conversation.id;

      const sent = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(bob.accessToken))
        .set(fwd())
        .send(msgBody());
      assert.equal(sent.status, 201);

      const outsider = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(eve.accessToken))
        .set(fwd())
        .send(msgBody());
      assert.equal(outsider.status, 403);
      assert.equal(outsider.body.error.code, 'NOT_CONVERSATION_MEMBER');
    });
  });

  await t.test('media message rules: owner/ready/type checks', async () => {
    await withApp(t, async ({ app, pool, mailer }) => {
      const alice = await registerAndVerify(app, mailer, { username: 'alice_01', email: 'alice@example.com' });
      const bob = await registerAndVerify(app, mailer, { username: 'bob_01', email: 'bob@example.com' });

      const created = await createGroup(app, alice.accessToken, { name: 'Media', memberUserIds: [bob.user.id] });
      const convId = created.body.data.conversation.id;

      const readyMedia = crypto.randomUUID();
      const pendingMedia = crypto.randomUUID();
      const bobMedia = crypto.randomUUID();
      await insertMedia(pool, { id: readyMedia, ownerId: alice.user.id });
      await insertMedia(pool, { id: pendingMedia, ownerId: alice.user.id, status: 'pending' });
      await insertMedia(pool, { id: bobMedia, ownerId: bob.user.id });

      // Image bina mediaId → 400.
      const noMedia = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ messageType: 'image' }));
      assert.equal(noMedia.status, 400);
      assert.equal(noMedia.body.error.code, 'MEDIA_ID_REQUIRED');

      // Text + mediaId → 400.
      const textWithMedia = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ mediaId: readyMedia }));
      assert.equal(textWithMedia.status, 400);
      assert.equal(textWithMedia.body.error.code, 'MEDIA_MESSAGE_TYPE_MISMATCH');

      // Dusre ki media → 403.
      const notOwned = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ messageType: 'image', mediaId: bobMedia }));
      assert.equal(notOwned.status, 403);
      assert.equal(notOwned.body.error.code, 'NOT_MEDIA_OWNER');

      // Pending media → 409.
      const notReady = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ messageType: 'image', mediaId: pendingMedia }));
      assert.equal(notReady.status, 409);
      assert.equal(notReady.body.error.code, 'MEDIA_NOT_READY');

      // Random mediaId → 404.
      const missing = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ messageType: 'image', mediaId: crypto.randomUUID() }));
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'MEDIA_NOT_FOUND');

      // Valid image + mediaId → 201, message.mediaId set.
      const okSend = await request(app)
        .post(`/api/v1/conversations/${convId}/messages`)
        .set(auth(alice.accessToken))
        .set(fwd())
        .send(msgBody({ messageType: 'image', mediaId: readyMedia }));
      assert.equal(okSend.status, 201);
      assert.equal(okSend.body.data.message.mediaId, readyMedia);

      const row = await pool.query('SELECT media_id FROM messages WHERE id = $1', [okSend.body.data.message.id]);
      assert.equal(row.rows[0].media_id, readyMedia);
    });
  });
});

test('groups: batched latest non-revoked member keys', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'key_alice', email: 'key_alice@example.com' });
    const bob = await registerAndVerify(app, mailer, { username: 'key_bob', email: 'key_bob@example.com' });
    const carol = await registerAndVerify(app, mailer, { username: 'key_carol', email: 'key_carol@example.com' });
    const created = await createGroup(app, alice.accessToken, { memberUserIds: [bob.user.id, carol.user.id] });
    assert.equal(created.status, 201);
    const convId = created.body.data.conversation.id;
    const devices = [
      ['00000000-0000-4000-8000-000000000001', alice.user.id, 'old', '2020-01-01', null],
      ['00000000-0000-4000-8000-000000000002', alice.user.id, 'tie-low', '2021-01-01', null],
      ['00000000-0000-4000-8000-000000000003', alice.user.id, 'latest', '2021-01-01', null],
      ['00000000-0000-4000-8000-000000000004', alice.user.id, 'revoked', '2022-01-01', '2022-01-02'],
      ['00000000-0000-4000-8000-000000000005', alice.user.id, null, '2023-01-01', null],
      ['00000000-0000-4000-8000-000000000006', bob.user.id, 'bob-key', '2020-01-01', null],
      ['00000000-0000-4000-8000-000000000007', carol.user.id, 'former-key', '2024-01-01', null],
    ];
    for (const params of devices) {
      await pool.query(`INSERT INTO devices (id, user_id, identity_public_key, created_at, revoked_at)
        VALUES ($1, $2, $3, $4, $5)`, params);
    }
    await pool.query('UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2', [convId, carol.user.id]);
    const queries = [];
    const repo = createGroupsRepo({ db: { query(text, params) {
      queries.push({ text, params });
      return pool.query(text, params);
    } } });
    const rows = await repo.listMembers(convId);
    assert.equal(queries.length, 2, 'one member query and one devices query');
    assert.deepEqual(new Set(queries[1].params), new Set([alice.user.id, bob.user.id]));
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.user_id, r.identity_public_key])), {
      [alice.user.id]: 'latest', [bob.user.id]: 'bob-key',
    });
    await pool.query('UPDATE devices SET revoked_at = now() WHERE user_id = $1', [bob.user.id]);
    const missing = await repo.listMembers(convId);
    assert.equal(missing.find((r) => r.user_id === bob.user.id).identity_public_key, null);
    queries.length = 0;
    assert.deepEqual(await repo.listMembers(crypto.randomUUID()), []);
    assert.equal(queries.length, 1, 'empty groups need no device lookup');
  });
});

test('groups: former admin rejoins as visible member without restoring old history', async (t) => {
  await withApp(t, async ({ app, pool, mailer }) => {
    const alice = await registerAndVerify(app, mailer, { username: 'rejoin_alice', email: 'rejoin_alice@example.com' });
    const bob = await registerAndVerify(app, mailer, { username: 'rejoin_bob', email: 'rejoin_bob@example.com' });
    const created = await createGroup(app, alice.accessToken, { memberUserIds: [bob.user.id] });
    assert.equal(created.status, 201);
    const convId = created.body.data.conversation.id;
    const repo = createGroupsRepo({ db: pool });
    await pool.query(`UPDATE conversation_members SET role = 'admin', joined_at = $3,
      hidden_at = $3, history_cleared_at = $3 WHERE conversation_id = $1 AND user_id = $2`,
    [convId, bob.user.id, '2020-01-01']);
    await repo.insertMembers(convId, [{ userId: bob.user.id, role: 'member' }]);
    const active = (await pool.query('SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, bob.user.id])).rows[0];
    assert.equal(active.role, 'admin', 'active membership is not reset');
    assert.ok(active.hidden_at);
    assert.equal(new Date(active.joined_at).getUTCFullYear(), 2020);
    const old = await request(app).post(`/api/v1/conversations/${convId}/messages`)
      .set(auth(alice.accessToken)).set(fwd()).send(msgBody());
    assert.equal(old.status, 201);
    await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [old.body.data.message.id, '2019-01-01']);
    const removed = await request(app).delete(`/api/v1/conversations/${convId}/members/${bob.user.id}`)
      .set(auth(alice.accessToken)).set(fwd());
    assert.equal(removed.status, 200);
    const gap = await request(app).post(`/api/v1/conversations/${convId}/messages`)
      .set(auth(alice.accessToken)).set(fwd()).send(msgBody());
    assert.equal(gap.status, 201);
    await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1', [gap.body.data.message.id, '2021-01-01']);
    // Hidden state can persist after removal; acceptance must reset it.
    await pool.query('UPDATE conversation_members SET hidden_at = $3 WHERE conversation_id = $1 AND user_id = $2', [convId, bob.user.id, '2020-01-01']);
    const invite = await request(app).post(`/api/v1/conversations/${convId}/invites`)
      .set(auth(alice.accessToken)).set(fwd()).send({ userId: bob.user.id });
    assert.equal(invite.status, 201);
    const accepted = await request(app).post(`/api/v1/invites/${invite.body.data.invite.id}/accept`)
      .set(auth(bob.accessToken)).set(fwd());
    assert.equal(accepted.status, 200);
    const member = (await pool.query('SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, bob.user.id])).rows[0];
    assert.equal(member.left_at, null);
    assert.equal(member.role, 'member');
    assert.equal(member.hidden_at, null);
    assert.ok(new Date(member.joined_at) > new Date(active.joined_at));
    assert.ok(new Date(member.history_cleared_at) >= new Date(active.history_cleared_at));
    const detail = await request(app).get(`/api/v1/conversations/${convId}/members`).set(auth(bob.accessToken)).set(fwd());
    assert.equal(detail.status, 200);
    const history = await request(app).get(`/api/v1/conversations/${convId}/messages`).set(auth(bob.accessToken)).set(fwd());
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.data.messages, []);
    const sent = await request(app).post(`/api/v1/conversations/${convId}/messages`)
      .set(auth(bob.accessToken)).set(fwd()).send(msgBody());
    assert.equal(sent.status, 201);
    await pool.query('UPDATE messages SET created_at = $2 WHERE id = $1',
      [sent.body.data.message.id, new Date(new Date(member.history_cleared_at).getTime() + 1000)]);
    const newHistory = await request(app).get(`/api/v1/conversations/${convId}/messages`).set(auth(bob.accessToken)).set(fwd());
    assert.equal(newHistory.status, 200);
    assert.deepEqual(newHistory.body.data.messages.map((m) => m.id), [sent.body.data.message.id]);
    const visible = await request(app).get('/api/v1/conversations').set(auth(bob.accessToken)).set(fwd());
    assert.equal(visible.status, 200);
    assert.ok(visible.body.data.conversations.some((c) => c.id === convId));
    const futureCutoff = new Date('2099-01-01');
    await pool.query(`UPDATE conversation_members SET left_at = now(), history_cleared_at = $3
      WHERE conversation_id = $1 AND user_id = $2`, [convId, bob.user.id, futureCutoff]);
    await repo.insertMembers(convId, [{ userId: bob.user.id, role: 'member' }]);
    const preserved = (await pool.query('SELECT history_cleared_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, bob.user.id])).rows[0];
    assert.equal(new Date(preserved.history_cleared_at).toISOString(), futureCutoff.toISOString());
    await pool.query(`UPDATE conversation_members SET left_at = now(), history_cleared_at = NULL
      WHERE conversation_id = $1 AND user_id = $2`, [convId, bob.user.id]);
    await repo.insertMembers(convId, [{ userId: bob.user.id, role: 'member' }]);
    const reset = (await pool.query('SELECT history_cleared_at, left_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convId, bob.user.id])).rows[0];
    assert.equal(reset.left_at, null);
    assert.ok(reset.history_cleared_at, 'rejoin without an old cutoff cannot reveal old messages');
  });
});
