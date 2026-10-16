const assert = require('node:assert/strict');
const { test } = require('node:test');

const plain = value => JSON.parse(JSON.stringify(value));

async function harness({ group = true, legacy = false, failAt, onRequest, summary } = {}) {
    const requests = [];
    const opened = [];
    const notices = [];
    const settingsKey = 'stLiteBranch';
    const currentGroup = {
        id: 'group-a', chat_id: 'source', chats: ['source'], name: 'Party',
        members: ['alice.png', 'bob.png'], disabled_members: ['bob.png'], activation_strategy: 1,
        ...(legacy ? { chat_metadata: {}, past_metadata: {} } : {}),
    };
    const c = {
        groupId: group ? 'group-a' : null,
        characterId: group ? undefined : 0,
        characters: [{ name: 'Alice', avatar: 'alice.png', chat: 'source' }],
        groups: [currentGroup, { id: 'group-b', chat_id: 'branch', chats: ['branch'] }],
        chat: Array.from({ length: 5 }, (_, i) => ({
            name: i % 2 ? 'Bob' : 'Alice', mes: `message ${i}`, is_user: false,
            original_avatar: i % 2 ? 'bob.png' : 'alice.png', force_avatar: `avatar-${i}`,
            stlb_uid: `uid-${i}`, extra: { gen_id: 42 },
            swipes: [`message ${i}`, 'alternative'], swipe_id: 0,
        })),
        chatMetadata: {
            integrity: 'parent-integrity', scenario: 'Keep this scenario',
            [settingsKey]: { pinnedMessages: [{ uid: 'uid-0' }, { uid: 'uid-3' }] },
        },
        extensionSettings: { [settingsKey]: { nameTemplate: 'branch' } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        getCurrentChatId() { return c.groupId ? c.groups.find(g => g.id === c.groupId)?.chat_id : c.characters[c.characterId]?.chat; },
        async openGroupChat(id, name) {
            const g = c.groups.find(g => g.id === id);
            assert.ok(g.chats.includes(name), 'must register before opening');
            opened.push([id, name]);
            g.chat_id = name;
        },
        async openCharacterChat(name) { opened.push(name); c.characters[c.characterId].chat = name; },
        async generateQuietPrompt() { return summary ? summary(c) : 'Recap'; },
        toastr: Object.fromEntries(['success', 'error', 'info', 'warning'].map(type => [type, text => notices.push([type, text])])),
    };
    global.fetch = async (url, options) => {
            const request = { url, body: options.body ? JSON.parse(options.body) : null };
            requests.push(request);
            await onRequest?.(request, c);
            return { ok: url !== failAt, statusText: 'Test failure', json: async () => {
                if (url === '/api/groups/all') return plain(c.groups);
                if (url === '/api/characters/chats') return [{ file_name: 'source.jsonl' }];
                return { error: 'Test failure' };
            } };
    };
    global.document = { createElement: () => ({ setAttribute() {}, append() {}, remove() {} }), body: { append() {} } };
    const { createBranchService } = await import('../branch.js');
    const { createSummaryService } = await import('../summary.js');
    const { createSettingsStore } = await import('../settings.js');
    const ctx = () => c;
    const t = key => key;
    const api = createBranchService({ ctx, getSettings: createSettingsStore(ctx, settingsKey).getSettings,
        summaryService: createSummaryService({ ctx, t, escapeHtml: x => x }), t,
        toast: (text, type) => notices.push([type, text]) });
    return { api, c, requests, opened, notices, currentGroup };
}

for (const legacy of [false, true]) {
    test(`group branch preserves authors, pins and settings (${legacy ? 'legacy' : 'header'} format)`, async () => {
        const h = await harness({ legacy });
        const original = plain(h.c.chat);
        const metadata = plain(h.c.chatMetadata);
        assert.equal(await h.api.createBranch(3, 2, false), true);
        assert.deepEqual(h.requests.map(r => r.url), ['/api/groups/all', '/api/chats/group/save', '/api/groups/edit']);
        const saved = h.requests[1].body;
        assert.equal(saved.id, 'branch (2)', 'names in other groups must also be avoided');
        assert.equal(saved.force, false);
        assert.deepEqual(saved.chat.slice(legacy ? 0 : 1), original.slice(2, 4));
        const branchMeta = legacy ? h.requests[2].body.past_metadata[saved.id] : saved.chat[0].chat_metadata;
        assert.equal(branchMeta.main_chat, 'source');
        assert.equal(branchMeta.scenario, metadata.scenario);
        assert.notEqual(branchMeta.integrity, metadata.integrity);
        assert.deepEqual(branchMeta.stLiteBranch.pinnedMessages, [{ uid: 'uid-3' }]);
        assert.deepEqual(h.requests[2].body.members, ['alice.png', 'bob.png']);
        assert.deepEqual(h.requests[2].body.disabled_members, ['bob.png']);
        assert.equal(h.requests[2].body.chat_id, 'source', 'registration must not switch the source');
        assert.deepEqual(plain(h.c.chat), original);
        assert.deepEqual(plain(h.c.chatMetadata), metadata);
        assert.deepEqual(h.opened, [['group-a', 'branch (2)']]);
    });
}

test('solo branch still uses the character save/open APIs', async () => {
    const h = await harness({ group: false });
    assert.equal(await h.api.createBranch(4, 2, false), true);
    assert.deepEqual(h.requests.map(r => r.url), ['/api/characters/chats', '/api/chats/save']);
    assert.equal(h.requests[1].body.avatar_url, 'alice.png');
    assert.equal(h.requests[1].body.chat.length, 3);
    assert.deepEqual(h.opened, ['branch']);
});

test('group summary tolerates transient character selection and is pinned as narrator', async () => {
    const h = await harness({ summary(c) { c.characterId = 0; return 'Group recap'; } });
    assert.equal(await h.api.createBranch(4, 2, true), true);
    const [header, recap] = h.requests.find(r => r.url === '/api/chats/group/save').body.chat;
    assert.equal(recap.extra.type, 'narrator');
    assert.equal(recap.is_system, false);
    assert.ok(recap.mes.includes('Group recap'));
    assert.equal(header.chat_metadata.stLiteBranch.pinnedMessages[0].uid, recap.stlb_uid);
});

test('switching groups during summary aborts before any save', async () => {
    const h = await harness({ summary(c) { c.groupId = 'group-b'; return 'Recap'; } });
    assert.equal(await h.api.createBranch(4, 2, true), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.opened.length, 0);
});

test('switching chat during name lookup aborts before saving', async () => {
    const h = await harness({ onRequest(r, c) { if (r.url === '/api/groups/all') c.groups[0].chat_id = 'other'; } });
    assert.equal(await h.api.createBranch(4, 2, false), false);
    assert.deepEqual(h.requests.map(r => r.url), ['/api/groups/all']);
});

for (const failAt of ['/api/groups/all', '/api/chats/group/save', '/api/groups/edit']) {
    test(`failure at ${failAt} does not publish or open a broken history entry`, async () => {
        const h = await harness({ failAt });
        assert.equal(await h.api.createBranch(4, 2, false), false);
        assert.deepEqual(h.currentGroup.chats, ['source']);
        assert.equal(h.currentGroup.chat_id, 'source');
        assert.equal(h.opened.length, 0);
        assert.ok(h.notices.at(-1)[1].startsWith(failAt === '/api/groups/edit' ? 'toast.savedIncomplete' : 'toast.failed'));
    });
}

test('a source switch after saving reports partial success without registering in another group', async () => {
    const h = await harness({ onRequest(r, c) { if (r.url === '/api/chats/group/save') c.groupId = 'group-b'; } });
    assert.equal(await h.api.createBranch(4, 2, false), false);
    assert.equal(h.requests.some(r => r.url === '/api/groups/edit'), false);
    assert.equal(h.notices.at(-1)[1], 'toast.savedIncomplete');
});

test('return to group source uses the same group and refuses a missing chat', async () => {
    const h = await harness();
    h.currentGroup.chat_id = 'child';
    h.c.chatMetadata.litebranch = { source: 'source', sourceGroupId: 'group-a' };
    await h.api.returnToSource();
    assert.deepEqual(h.opened, [['group-a', 'source']]);
    h.c.chatMetadata.litebranch.source = 'deleted';
    await h.api.returnToSource();
    assert.equal(h.opened.length, 1);
    assert.equal(h.notices.at(-1)[1], 'source.failed');
});

test('missing group open API is detected before saving', async () => {
    const h = await harness();
    delete h.c.openGroupChat;
    assert.equal(await h.api.createBranch(4, 2, false), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.notices.at(-1)[1], 'toast.updateRequired');
});

test('return to solo source opens the parent and aborts if chat changes during lookup', async () => {
    const h = await harness({ group: false });
    h.c.characters[0].chat = 'child';
    h.c.chatMetadata.litebranch = { source: 'source', sourceAvatar: 'alice.png' };
    await h.api.returnToSource();
    assert.deepEqual(h.opened, ['source']);

    const switched = await harness({ group: false, onRequest(request, c) {
        if (request.url === '/api/characters/chats') c.characters[0].chat = 'other';
    } });
    switched.c.characters[0].chat = 'child';
    switched.c.chatMetadata.litebranch = { source: 'source' };
    await switched.api.returnToSource();
    assert.equal(switched.opened.length, 0);
});

test('summary failure stops branch creation without saving a recap-less branch', async () => {
    const h = await harness({ summary() { throw new Error('Connection failed'); } });
    assert.equal(await h.api.createBranch(4, 2, true), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.opened.length, 0);
});
