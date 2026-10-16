import { buildSummaryPlan } from './summary.js';

const clone = value => JSON.parse(JSON.stringify(value));
const normalize = name => String(name || '').replace(/\.jsonl$/i, '').normalize('NFC').toLocaleLowerCase();
const sanitize = name => String(name || 'chat').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'chat';
const uuid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const n = Math.floor(Math.random() * 16);
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
});

export function createBranchService({ ctx, getSettings, summaryService, toast, t, isDisposed = () => false }) {
    const getGroup = (c = ctx()) => c.groupId ? c.groups?.find(g => String(g.id) === String(c.groupId)) : null;
    const getChatArray = () => Array.isArray(ctx().chat) ? ctx().chat : [];
    const chatId = (c = ctx()) => String(c.getCurrentChatId?.() ?? c.chatId ?? '');
    const getSourceChatName = () => getGroup()?.chat_id || ctx().characters?.[ctx().characterId]?.chat || chatId();
    const hasOpenChat = () => !!chatId() && (ctx().groupId ? !!getGroup() : ctx().characterId != null);
    const captureSource = () => {
        const c = ctx();
        const group = getGroup(c);
        const char = c.characters?.[c.characterId];
        return {
            groupId: c.groupId || null, characterId: c.characterId,
            characterName: char?.name, avatar: char?.avatar,
            legacyGroup: !!group && (Object.hasOwn(group, 'past_metadata') || Object.hasOwn(group, 'chat_metadata')),
            chatId: chatId(c), sourceName: getSourceChatName(), requestHeaders: c.getRequestHeaders(),
        };
    };
    const isSameSource = source => !isDisposed() && (ctx().groupId || null) === source.groupId
        && (!!source.groupId || ctx().characterId === source.characterId)
        && chatId() === source.chatId && getSourceChatName() === source.sourceName;
    const computeRange = (mesId, count) => ({ start: Math.max(0, mesId - count + 1), end: mesId });

    async function post(url, body, source) {
        const res = await fetch(url, { method: 'POST', cache: 'no-cache', headers: source.requestHeaders,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!res.ok) throw new Error(`${url}: ${res.statusText}`);
        return res;
    }
    async function existingNames(source) {
        const res = await post(source.groupId ? '/api/groups/all' : '/api/characters/chats',
            source.groupId ? undefined : { avatar_url: source.avatar, simple: true }, source);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('Invalid chat list');
        return new Set((source.groupId
            ? [...data, ...(ctx().groups || [])].flatMap(g => [...(g.chats || []), g.chat_id])
            : data.flatMap(x => [x.file_id, x.file_name])).filter(Boolean).map(normalize));
    }
    function branchName(source, mesId, existing) {
        const date = ctx().humanizedDateTime?.() || new Date().toISOString().replace(/[:.]/g, '-');
        const base = sanitize(getSettings().nameTemplate.replace(/\{chat\}/g, source.sourceName)
            .replace(/\{date\}/g, date).replace(/\{mes\}/g, String(mesId)));
        existing.add(normalize(source.sourceName));
        let name = base;
        for (let n = 2; existing.has(normalize(name)); n++) {
            const suffix = ` (${n})`;
            name = base.slice(0, 160 - suffix.length).trim() + suffix;
        }
        return name;
    }
    async function saveAndOpen(name, messages, source, metadata) {
        const header = { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
        await post(source.groupId ? '/api/chats/group/save' : '/api/chats/save', source.groupId
            ? { id: name, chat: source.legacyGroup ? messages : [header, ...messages], force: false }
            : { ch_name: source.characterName, file_name: name, chat: [header, ...messages], avatar_url: source.avatar, force: false }, source);
        source.savedBranchName = name;
        if (!isSameSource(source)) throw new Error(t('toast.sourceChanged'));
        if (source.groupId) {
            const updated = clone(getGroup());
            updated.chats = [...new Set([...(updated.chats || []), name])];
            if (source.legacyGroup) updated.past_metadata = { ...(updated.past_metadata || {}), [name]: metadata };
            await post('/api/groups/edit', updated, source);
            const live = ctx().groups?.find(g => String(g.id) === String(source.groupId));
            if (live) {
                live.chats = [...new Set([...(live.chats || []), name])];
                if (source.legacyGroup) live.past_metadata = { ...(live.past_metadata || {}), [name]: clone(metadata) };
            }
            if (!isSameSource(source)) throw new Error(t('toast.sourceChanged'));
            await ctx().openGroupChat(source.groupId, name);
        } else await ctx().openCharacterChat(name);
        if (chatId() !== name) throw new Error('Saved branch did not open');
    }

    let running = false;
    async function createBranch(mesId, count, withSummary, overrides = {}) {
        if (running) { toast(t('toast.busy'), 'warning'); return false; }
        if (!hasOpenChat()) { toast(t('toast.noChat'), 'warning'); return false; }
        const chat = getChatArray();
        if (!chat.length) { toast(t('toast.empty'), 'warning'); return false; }
        if (!Number.isInteger(Number(mesId))) { toast(t('toast.badAnchor'), 'warning'); return false; }
        mesId = Math.max(0, Math.min(Number(mesId), chat.length - 1));
        if (!Number.isFinite(Number(count)) || Number(count) < 1) { toast(t('toast.badCount'), 'warning'); return false; }
        const { start, end } = computeRange(mesId, Math.floor(Number(count)));
        const source = captureSource();
        if (typeof (source.groupId ? ctx().openGroupChat : ctx().openCharacterChat) !== 'function') {
            toast(t('toast.updateRequired'), 'error'); return false;
        }
        const options = { ...getSettings(), ...overrides };
        running = true;
        toast(t('toast.creating'), 'info');
        try {
            const carried = clone(chat.slice(start, end + 1));
            const metadata = clone(ctx().chatMetadata || {});
            const uids = new Set(carried.map(m => m.stlb_uid || m.extra?.stlb_uid).filter(Boolean));
            const records = metadata.stLiteBranch?.pinnedMessages;
            const pinnedMessages = (Array.isArray(records) ? records : []).filter(r => r && uids.has(r.uid));
            const messages = [...carried];
            const plan = withSummary ? buildSummaryPlan(chat, start, options) : null;
            if (plan?.chunks.length) {
                const recap = await summaryService.generate(plan, options, source, isSameSource);
                if (!recap) return false; // Preview cancelled: no file or history entry is created.
                recap.stlb_uid = uuid();
                pinnedMessages.unshift({ uid: recap.stlb_uid, pinnedAt: Date.now() });
                messages.unshift(recap);
            }
            metadata.integrity = uuid();
            metadata.main_chat = source.sourceName;
            metadata.litebranch = { source: source.sourceName, sourceGroupId: source.groupId,
                sourceAvatar: source.avatar, created: new Date().toISOString(), count: messages.length };
            metadata.stLiteBranch = { ...(metadata.stLiteBranch || {}), pinnedMessages };
            if (!isSameSource(source)) throw new Error(t('toast.sourceChanged'));
            const existing = await existingNames(source);
            if (!isSameSource(source)) throw new Error(t('toast.sourceChanged'));
            await saveAndOpen(branchName(source, mesId, existing), messages, source, metadata);
            toast(t('toast.done', { n: carried.length }), 'success');
            return true;
        } catch (error) {
            console.error('[LiteBranch] createBranch failed', error);
            toast(source.savedBranchName ? t('toast.savedIncomplete', { name: source.savedBranchName })
                : `${t('toast.failed')} ${error.message}`, 'error');
            return false;
        } finally { running = false; }
    }

    async function returnToSource() {
        const origin = ctx().chatMetadata?.litebranch;
        if (!origin?.source || origin.source === chatId() || running) return;
        const source = captureSource();
        running = true;
        try {
            if (ctx().groupId) {
                const group = getGroup();
                if (origin.sourceGroupId && String(origin.sourceGroupId) !== String(group.id)) throw new Error('Source group mismatch');
                if (!group.chats?.includes(origin.source)) throw new Error('Source chat missing');
                await ctx().openGroupChat(group.id, origin.source);
            } else {
                if (origin.sourceAvatar && origin.sourceAvatar !== ctx().characters?.[ctx().characterId]?.avatar) throw new Error('Source character mismatch');
                const names = await existingNames(source);
                if (!isSameSource(source)) throw new Error(t('toast.sourceChanged'));
                if (!names.has(normalize(origin.source))) throw new Error('Source chat missing');
                await ctx().openCharacterChat(origin.source);
            }
            if (chatId() !== origin.source) throw new Error('Source chat did not open');
        } catch (error) { console.error('[LiteBranch] return failed', error); toast(t('source.failed'), 'error'); }
        finally { running = false; }
    }
    return { createBranch, captureSource, isSameSource, hasOpenChat, getChatArray, computeRange, returnToSource };
}
