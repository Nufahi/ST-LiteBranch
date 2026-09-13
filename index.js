const MODULE_NAME = 'ST-LiteBranch';
const LOG_PREFIX = '[LiteBranch]';
const SETTINGS_KEY = 'stLiteBranch';

jQuery(async function () {
    'use strict';

    // ---------------------------------------------------------------------
    // Prevent double initialization (hot-reload safe)
    // ---------------------------------------------------------------------
    if (window.__stLiteBranchInitialized) {
        console.warn(`${LOG_PREFIX} Already initialized, disposing previous instance.`);
        if (typeof window.__stLiteBranchDispose === 'function') {
            try { window.__stLiteBranchDispose(); } catch (e) { console.error(`${LOG_PREFIX} Dispose error:`, e); }
        }
    }
    window.__stLiteBranchInitialized = true;
    const instanceToken = Symbol(MODULE_NAME);
    window.__stLiteBranchInstance = instanceToken;
    let disposed = false;

    function ctx() { return SillyTavern.getContext(); }

    const eventSource = ctx().eventSource;
    const event_types = ctx().eventTypes || ctx().event_types || {};

    // ---------------------------------------------------------------------
    // i18n (lightweight, fetched JSON with fallback)
    // ---------------------------------------------------------------------
    let I18N = {};
    function detectLocale() {
        // 1) Respect the language the user picked in SillyTavern's UI.
        try {
            const stored = localStorage.getItem('language');
            if (stored && stored.toLowerCase() !== 'default') {
                return stored.toLowerCase().slice(0, 2);
            }
        } catch (_) { /* noop */ }
        // 2) Fall back to anything the context exposes.
        try {
            const c = ctx();
            const fromCtx = (typeof c.getCurrentLocale === 'function' && c.getCurrentLocale())
                || c.locale || c.language;
            if (fromCtx) return String(fromCtx).toLowerCase().slice(0, 2);
        } catch (_) { /* noop */ }
        // 3) Last resort: the browser language.
        return (navigator.language || 'en').toLowerCase().slice(0, 2);
    }
    async function loadI18n() {
        const loc = detectLocale();
        const base = `scripts/extensions/third-party/${MODULE_NAME}/i18n`;
        for (const code of [loc, 'en']) {
            try {
                const res = await fetch(`${base}/${code}.json`, { cache: 'no-cache' });
                if (res.ok) { I18N = await res.json(); return; }
            } catch (_) { /* try next */ }
        }
        I18N = {};
    }
    function t(key, vars) {
        let s = (I18N && I18N[key]) || key;
        if (vars) for (const k in vars) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), vars[k]);
        return s;
    }

    await loadI18n();
    if (window.__stLiteBranchInstance !== instanceToken) return;

    // ---------------------------------------------------------------------
    // Settings + storage
    // ---------------------------------------------------------------------
    const LEGACY_SUMMARY_PROMPT =
        'Summarize the roleplay so far in a concise recap that preserves the important '
        + 'facts, relationships, ongoing plot threads and the current situation. '
        + 'Write it as neutral notes, not as a message in character. Do not add anything '
        + 'that did not happen.';
    const DEFAULT_SUMMARY_PROMPT =
        'Write a compact English continuity summary of the roleplay transcript for use as context '
        + 'in a continued chat. Preserve established facts, character identities and relationships, '
        + 'important decisions, promises, inventory or status changes, unresolved goals, and the '
        + 'current location and situation. Give recent and ongoing events priority over obsolete detail. '
        + 'Use dense, clear bullet points. Do not roleplay, address the user, mention the transcript, '
        + 'or invent information. Output only the summary in English.';
    const SUMMARY_HEADER = '[ Story so far ]';

    const DEFAULT_SETTINGS = {
        defaultCount: 50,
        askEveryTime: true,
        showJumpBottom: true,
        showMessageActions: true,
        summaryDefault: false,
        summaryPrompt: DEFAULT_SUMMARY_PROMPT,
        summaryLimit: 12000,
        nameTemplate: '{chat} — lite @{mes} {date}',
    };

    function getSettings() {
        const c = ctx();
        if (!c.extensionSettings[SETTINGS_KEY] || typeof c.extensionSettings[SETTINGS_KEY] !== 'object') {
            c.extensionSettings[SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
        }
        const s = c.extensionSettings[SETTINGS_KEY];
        if (!Number.isFinite(s.defaultCount) || s.defaultCount < 1) s.defaultCount = 50;
        if (typeof s.askEveryTime !== 'boolean') s.askEveryTime = true;
        if (typeof s.showJumpBottom !== 'boolean') s.showJumpBottom = true;
        if (typeof s.showMessageActions !== 'boolean') s.showMessageActions = true;
        if (typeof s.summaryDefault !== 'boolean') s.summaryDefault = false;
        if (typeof s.summaryPrompt !== 'string' || !s.summaryPrompt.trim()
            || s.summaryPrompt.trim() === LEGACY_SUMMARY_PROMPT) {
            s.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
        }
        if (!Number.isFinite(s.summaryLimit) || s.summaryLimit < 500) s.summaryLimit = 12000;
        if (typeof s.nameTemplate !== 'string' || !s.nameTemplate.trim()) s.nameTemplate = DEFAULT_SETTINGS.nameTemplate;
        return s;
    }
    function save() { ctx().saveSettingsDebounced(); }

    // ---------------------------------------------------------------------
    // Utilities
    // ---------------------------------------------------------------------
    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function toast(msg, type) {
        try {
            const toastr = ctx().toastr || window.toastr;
            if (toastr && typeof toastr[type || 'success'] === 'function') {
                toastr[type || 'success'](msg, t('app.title'), { timeOut: 2600 });
                return;
            }
        } catch (_) { /* noop */ }
        console.log(`${LOG_PREFIX} ${msg}`);
    }
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
    function createUid() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return `stlb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    function createIntegrityUuid() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
            const random = Math.floor(Math.random() * 16);
            return (char === 'x' ? random : ((random & 0x3) | 0x8)).toString(16);
        });
    }
    function clonePersisted(value) {
        return JSON.parse(JSON.stringify(value));
    }

    const SPLIT_ICON_HTML = `
        <svg class="stlb-split-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M16 3h5v5"></path><path d="M8 3H3v5"></path>
            <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"></path><path d="m15 9 6-6"></path>
        </svg>`;

    // Sanitize a value for use as a chat file name (mirrors ST's own rules:
    // no path separators or characters that break the file system).
    function sanitizeFileName(name) {
        return String(name || 'chat')
            .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 160) || 'chat';
    }

    // ---------------------------------------------------------------------
    // Chat identity helpers
    // ---------------------------------------------------------------------
    function isGroup() { return !!ctx().groupId; }
    function getChatArray() {
        const c = ctx();
        return Array.isArray(c.chat) ? c.chat : [];
    }
    function getSourceChatName() {
        const c = ctx();
        // this_chid -> characters[this_chid].chat is the current file name.
        const char = c.characters?.[c.characterId];
        return char?.chat || c.getCurrentChatId?.() || c.chatId || 'chat';
    }
    function hasOpenChat() {
        const c = ctx();
        const id = c.getCurrentChatId?.() ?? c.chatId ?? null;
        return id !== undefined && id !== null && id !== '' && c.characterId != null;
    }

    function buildBranchName(mesId, sourceName) {
        const s = getSettings();
        const c = ctx();
        const date = (typeof c.humanizedDateTime === 'function')
            ? c.humanizedDateTime()
            : new Date().toISOString().replace(/[:.]/g, '-');
        const out = s.nameTemplate
            .replace(/\{chat\}/g, sourceName)
            .replace(/\{date\}/g, date)
            .replace(/\{mes\}/g, String(mesId));
        return sanitizeFileName(out);
    }

    // =====================================================================
    // CORE — build & save the branch, then switch to it
    // =====================================================================

    // Compute the inclusive slice [start, mesId] of the last `count` messages.
    function computeRange(mesId, count) {
        const start = Math.max(0, mesId - count + 1);
        return { start, end: mesId }; // inclusive on both ends
    }

    // Optionally ask the model to summarize everything before `start`.
    function buildSummaryTranscript(chat, startIdx, limit) {
        const reversed = [];
        let remaining = limit;
        for (let index = startIdx - 1; index >= 0 && remaining > 0; index--) {
            const message = chat[index];
            if (!message || message.is_system || message.is_hidden
                || message.extra?.hidden || message.extra?.is_hidden || message.extra?.isSmallSys) continue;
            const body = String(message.mes || '').trim();
            if (!body) continue;
            const text = `${message.name || (message.is_user ? 'User' : 'Char')}: ${body}`;
            const separatorLength = reversed.length ? 2 : 0;
            if (remaining <= separatorLength) break;
            remaining -= separatorLength;
            if (text.length > remaining) {
                reversed.push(remaining === 1 ? '…' : `…${text.slice(-(remaining - 1))}`);
                remaining = 0;
            } else {
                reversed.push(text);
                remaining -= text.length;
            }
        }
        return reversed.reverse().join('\n\n');
    }

    // Build this synchronously from the source chat before generation starts.
    function getSummaryInput(chat, startIdx) {
        const s = getSettings();
        if (startIdx <= 0) return null; // nothing older to summarize
        const text = buildSummaryTranscript(chat, startIdx, s.summaryLimit);
        if (!text) return null;
        return `${s.summaryPrompt}\n\nReturn only the final summary in English.\n\n---\n${text}\n---`;
    }

    async function makeSummaryMessage(prompt, characterName) {
        const c = ctx();

        let summary = '';
        try {
            summary = await c.generateQuietPrompt({ quietPrompt: prompt });
        } catch (_) {
            // Older ST signature: positional (quiet_prompt, quietToLoud, skipWIAN)
            try { summary = await c.generateQuietPrompt(prompt, false, false); }
            catch (e) { console.error(`${LOG_PREFIX} summary failed`, e); return null; }
        }
        summary = String(summary || '').trim();
        if (!summary) return null;

        const now = Date.now();
        return {
            name: characterName || 'System',
            is_user: false,
            is_system: false, // false so it DOES get sent to the model as context
            send_date: now,
            mes: `${SUMMARY_HEADER}\n\n${summary}`,
            extra: { litebranch_summary: true },
        };
    }

    // Save an arbitrary message array under a new chat file for the current
    // character via the server endpoint, then open it. Solo chats only.
    function normalizeChatName(name) {
        return String(name || '').replace(/\.jsonl$/i, '').normalize('NFC').toLocaleLowerCase();
    }

    async function getExistingChatNames(source) {
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            cache: 'no-cache',
            headers: source.requestHeaders,
            body: JSON.stringify({ avatar_url: source.avatar, simple: true }),
        });
        if (!res.ok) throw new Error(`chat list failed: ${res.statusText}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('chat list returned an invalid response');
        return new Set(data.flatMap(item => [item?.file_id, item?.file_name])
            .filter(Boolean).map(normalizeChatName));
    }

    function makeUniqueBranchName(baseName, existingNames, sourceName) {
        const unavailable = new Set(existingNames);
        unavailable.add(normalizeChatName(sourceName));
        let candidate = sanitizeFileName(baseName);
        let number = 2;
        while (unavailable.has(normalizeChatName(candidate))) {
            const suffix = ` (${number++})`;
            candidate = `${baseName.slice(0, Math.max(1, 160 - suffix.length)).trim()}${suffix}`;
        }
        return candidate;
    }

    function isSameSource(source) {
        const c = ctx();
        const chatId = c.getCurrentChatId?.() ?? c.chatId ?? '';
        return c.characterId === source.characterId
            && String(chatId) === source.chatId
            && getSourceChatName() === source.sourceName;
    }

    async function saveAndOpenBranch(branchName, messages, source, metadata) {
        const chatHeader = {
            chat_metadata: metadata,
            user_name: 'unused',
            character_name: 'unused',
        };

        const res = await fetch('/api/chats/save', {
            method: 'POST',
            cache: 'no-cache',
            headers: source.requestHeaders,
            body: JSON.stringify({
                ch_name: source.characterName,
                file_name: branchName,
                chat: [chatHeader, ...messages],
                avatar_url: source.avatar,
                force: false,
            }),
        });
        if (!res.ok) {
            let detail = res.statusText;
            try { detail = (await res.json())?.error || detail; } catch (_) { /* noop */ }
            throw new Error(`save failed: ${detail}`);
        }

        if (!isSameSource(source)) throw new Error('source chat changed before branch could be opened');
        await source.context.openCharacterChat(branchName);
    }

    // The whole flow. `mesId` is the anchor (inclusive, branch goes back from it).
    let branchCreationRunning = false;
    async function createBranch(mesId, count, withSummary) {
        if (branchCreationRunning) { toast(t('toast.busy'), 'warning'); return false; }
        if (!hasOpenChat()) { toast(t('toast.noChat'), 'warning'); return false; }
        if (isGroup()) { toast(t('toast.groupUnsupported'), 'warning'); return false; }

        const c = ctx();
        const chat = getChatArray();
        if (!chat.length) { toast(t('toast.empty'), 'warning'); return false; }
        const numericMesId = Number(mesId);
        if (!Number.isInteger(numericMesId)) { toast(t('toast.badAnchor'), 'warning'); return false; }
        mesId = clamp(numericMesId, 0, chat.length - 1);
        count = Math.max(1, Math.floor(Number(count) || 1));
        const { start, end } = computeRange(mesId, count);
        const sourceName = getSourceChatName();
        const char = c.characters?.[c.characterId];
        if (!char) { toast(t('toast.noChat'), 'warning'); return false; }

        branchCreationRunning = true;
        toast(t('toast.creating'), 'info');
        try {
            const source = {
                context: c,
                characterId: c.characterId,
                characterName: char.name,
                avatar: char.avatar,
                chatId: String(c.getCurrentChatId?.() ?? c.chatId ?? ''),
                sourceName,
                requestHeaders: c.getRequestHeaders(),
            };
            const carried = clonePersisted(chat.slice(start, end + 1));
            const summaryPrompt = withSummary ? getSummaryInput(chat, start) : null;
            const metadata = clonePersisted(c.chatMetadata || {});
            delete metadata.integrity;

            let messages = carried;
            const carriedUids = new Set(carried.map(getMessageUid).filter(Boolean));
            const pinnedRecords = getPinRecords()
                .filter(record => carriedUids.has(record.uid))
                .map(record => clonePersisted(record));
            if (summaryPrompt) {
                let summaryMsg = null;
                try { summaryMsg = await makeSummaryMessage(summaryPrompt, source.characterName); }
                catch (error) { console.error(`${LOG_PREFIX} summary failed`, error); }
                if (!isSameSource(source)) throw new Error('source chat changed during summary generation');
                if (summaryMsg) {
                    summaryMsg.stlb_uid = createUid();
                    pinnedRecords.unshift({ uid: summaryMsg.stlb_uid, pinnedAt: Date.now() });
                    messages = [summaryMsg, ...carried];
                } else if (start > 0) {
                    toast(t('toast.summaryFailed'), 'warning');
                }
            }

            metadata.integrity = createIntegrityUuid();
            metadata.main_chat = sourceName;
            metadata.litebranch = {
                source: sourceName,
                created: new Date().toISOString(),
                count: messages.length,
            };
            metadata[SETTINGS_KEY] = {
                ...(metadata[SETTINGS_KEY] || {}),
                pinnedMessages: pinnedRecords,
            };

            if (!isSameSource(source)) throw new Error('source chat changed before branch save');
            const existingNames = await getExistingChatNames(source);
            if (!isSameSource(source)) throw new Error('source chat changed while checking branch name');
            const branchName = makeUniqueBranchName(buildBranchName(mesId, sourceName), existingNames, sourceName);
            await saveAndOpenBranch(branchName, messages, source, metadata);
            toast(t('toast.done', { n: carried.length }), 'success');
            return true;
        } catch (e) {
            console.error(`${LOG_PREFIX} createBranch failed`, e);
            toast(t('toast.failed'), 'error');
            return false;
        } finally {
            branchCreationRunning = false;
        }
    }

    // =====================================================================
    // DIALOG (Popup)
    // =====================================================================
    async function openBranchDialog(mesId) {
        const c = ctx();
        const s = getSettings();
        const chat = getChatArray();
        const total = chat.length;
        const anchor = clamp(Number(mesId), 0, total - 1);

        const buildRangeText = (count) => {
            const { start, end } = computeRange(anchor, count);
            const n = end - start + 1;
            if (start === 0 && count >= (end + 1)) return t('dlg.rangeAll', { n });
            return t('dlg.range', { from: start, to: end, n });
        };

        const defCount = clamp(s.defaultCount, 1, anchor + 1);
        const html = `
        <div class="stlb-dialog">
            <div class="stlb-intro">${escapeHtml(t('dlg.intro'))}</div>

            <label class="stlb-field">
                <span class="stlb-label">${escapeHtml(t('dlg.count'))}</span>
                <input type="number" min="1" step="1" id="stlb-count" class="text_pole" value="${defCount}">
                <span class="stlb-hint">${escapeHtml(t('dlg.countHint'))}</span>
            </label>

            <div class="stlb-range" id="stlb-range" role="status" aria-live="polite">${escapeHtml(buildRangeText(defCount))}</div>

            <label class="stlb-check">
                <input type="checkbox" id="stlb-summary" ${s.summaryDefault ? 'checked' : ''}>
                <span class="stlb-check-text">
                    <span class="stlb-label">${escapeHtml(t('dlg.summary'))}</span>
                    <span class="stlb-hint">${escapeHtml(t('dlg.summaryHint'))}</span>
                </span>
            </label>
        </div>`;

        const Popup = c.Popup;
        const POPUP_TYPE = c.POPUP_TYPE || {};
        const POPUP_RESULT = c.POPUP_RESULT || {};
        if (!Popup) {
            // Extremely defensive fallback: no Popup class -> just run with defaults.
            return createBranch(anchor, s.defaultCount, s.summaryDefault);
        }

        const dom = document.createElement('div');
        dom.innerHTML = html;

        // Live range preview as the count changes.
        const countInput = dom.querySelector('#stlb-count');
        const rangeEl = dom.querySelector('#stlb-range');
        countInput.addEventListener('input', () => {
            const n = Math.max(1, Math.floor(Number(countInput.value) || 1));
            rangeEl.textContent = buildRangeText(n);
        });

        const popup = new Popup(dom, POPUP_TYPE.TEXT ?? 1, t('dlg.title'), {
            okButton: t('dlg.create'),
            cancelButton: t('dlg.cancel'),
            wide: false,
        });
        const result = await popup.show();
        const okValue = POPUP_RESULT.AFFIRMATIVE ?? 1;
        if (result !== okValue) return false;

        const count = Math.floor(Number(countInput.value) || 0);
        if (!Number.isFinite(count) || count < 1) { toast(t('toast.badCount'), 'warning'); return false; }
        const withSummary = !!dom.querySelector('#stlb-summary')?.checked;

        return createBranch(anchor, count, withSummary);
    }

    // Decide whether to show the dialog or branch instantly (settings driven).
    async function branchFromMessage(mesId) {
        if (!hasOpenChat()) { toast(t('toast.noChat'), 'warning'); return; }
        if (isGroup()) { toast(t('toast.groupUnsupported'), 'warning'); return; }
        const s = getSettings();
        if (s.askEveryTime) {
            await openBranchDialog(mesId);
        } else {
            await createBranch(mesId, s.defaultCount, s.summaryDefault);
        }
    }

    // =====================================================================
    // PINNED MESSAGES
    // =====================================================================
    const PIN_META_KEY = SETTINGS_KEY;
    const PIN_BTN_CLASS = 'stlb_pin_button';
    const NAV_ID = 'stlb-pin-nav';
    const JUMP_BOTTOM_ID = 'stlb-jump-bottom';
    let activePinIndex = 0;
    let jumpToken = 0;
    let reconcileRunning = false;
    let reconcilePending = false;

    function hasActiveChat() {
        const c = ctx();
        const id = c.getCurrentChatId?.() ?? c.chatId;
        return id !== undefined && id !== null && id !== '';
    }

    function getPinRecords() {
        const records = ctx().chatMetadata?.[PIN_META_KEY]?.pinnedMessages;
        if (!Array.isArray(records)) return [];
        return records.filter(record => record && typeof record.uid === 'string');
    }

    function setPinRecords(records) {
        const c = ctx();
        const namespace = { ...(c.chatMetadata?.[PIN_META_KEY] || {}), pinnedMessages: records };
        if (typeof c.updateChatMetadata === 'function') {
            c.updateChatMetadata({ [PIN_META_KEY]: namespace }, false);
        } else {
            c.chatMetadata[PIN_META_KEY] = namespace;
        }
    }

    async function persistPins() {
        const c = ctx();
        if (typeof c.saveMetadata === 'function') await c.saveMetadata();
        else if (typeof c.saveChat === 'function') await c.saveChat();
    }

    function getMessageUid(message) {
        return message?.stlb_uid || message?.extra?.stlb_uid || null;
    }

    function ensureMessageUid(message) {
        if (!message.stlb_uid) message.stlb_uid = message.extra?.stlb_uid || createUid();
        if (message.extra?.stlb_uid) delete message.extra.stlb_uid;
        return message.stlb_uid;
    }

    function findMessageIndex(uid) {
        return getChatArray().findIndex(message => getMessageUid(message) === uid);
    }

    function getResolvedPins() {
        const messageIndexes = new Map();
        getChatArray().forEach((message, index) => {
            const uid = getMessageUid(message);
            if (uid && !messageIndexes.has(uid)) messageIndexes.set(uid, index);
        });
        return getPinRecords()
            .map(record => ({ record, messageIndex: messageIndexes.get(record.uid) ?? -1 }))
            .filter(pin => pin.messageIndex >= 0)
            .sort((a, b) => a.messageIndex - b.messageIndex);
    }

    function messagePreview(message) {
        return String(message?.mes || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || t('pin.empty');
    }

    function ensurePinNavigator() {
        let nav = document.getElementById(NAV_ID);
        if (nav) return nav;
        const chatEl = document.getElementById('chat');
        if (!chatEl?.parentElement) return null;

        nav = document.createElement('div');
        nav.id = NAV_ID;
        nav.className = 'stlb-pin-nav stlb-hidden';
        nav.innerHTML = `
            <button type="button" class="stlb-pin-main interactable" data-stlb-pin-action="jump">
                <i class="fa-solid fa-thumbtack" aria-hidden="true"></i>
                <span class="stlb-pin-copy">
                    <span class="stlb-pin-heading"></span>
                    <span class="stlb-pin-preview"></span>
                </span>
            </button>
            <span class="stlb-pin-actions">
                <button type="button" class="stlb-pin-action interactable fa-solid fa-chevron-left"
                    data-stlb-pin-action="prev"></button>
                <button type="button" class="stlb-pin-action interactable fa-solid fa-chevron-right"
                    data-stlb-pin-action="next"></button>
                <button type="button" class="stlb-pin-action interactable fa-solid fa-xmark"
                    data-stlb-pin-action="unpin"></button>
            </span>`;
        chatEl.parentElement.insertBefore(nav, chatEl);
        return nav;
    }

    function renderPinNavigator() {
        const nav = ensurePinNavigator();
        if (!nav) return;
        const pins = getResolvedPins();
        nav.classList.toggle('stlb-hidden', pins.length === 0);
        if (!pins.length) {
            activePinIndex = 0;
            return;
        }

        activePinIndex = clamp(activePinIndex, 0, pins.length - 1);
        const pin = pins[activePinIndex];
        const message = getChatArray()[pin.messageIndex];
        nav.querySelector('.stlb-pin-heading').textContent = t('pin.heading', {
            current: activePinIndex + 1,
            total: pins.length,
            name: message?.name || t('pin.unknown'),
        });
        nav.querySelector('.stlb-pin-preview').textContent = messagePreview(message);
        nav.querySelector('[data-stlb-pin-action="jump"]').title = t('pin.jump');
        nav.querySelector('[data-stlb-pin-action="prev"]').title = t('pin.prev');
        nav.querySelector('[data-stlb-pin-action="next"]').title = t('pin.next');
        nav.querySelector('[data-stlb-pin-action="unpin"]').title = t('pin.remove');
        nav.querySelector('[data-stlb-pin-action="prev"]').classList.toggle('stlb-hidden', pins.length === 1);
        nav.querySelector('[data-stlb-pin-action="next"]').classList.toggle('stlb-hidden', pins.length === 1);
        nav.querySelectorAll('[data-stlb-pin-action]').forEach(control => {
            control.setAttribute('aria-label', control.title);
        });
    }

    function ensureJumpBottomButton() {
        let button = document.getElementById(JUMP_BOTTOM_ID);
        if (!getSettings().showJumpBottom) {
            button?.remove();
            return null;
        }
        if (button) return button;
        button = document.createElement('button');
        button.id = JUMP_BOTTOM_ID;
        button.type = 'button';
        button.className = 'stlb-jump-bottom stlb-hidden interactable';
        button.innerHTML = '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i>';
        button.title = t('chat.jumpBottom');
        button.setAttribute('aria-label', button.title);
        button.addEventListener('click', jumpToBottom);
        document.body.append(button);
        return button;
    }

    function updateJumpBottomButton() {
        const button = ensureJumpBottomButton();
        const chatEl = document.getElementById('chat');
        if (!button || !chatEl) return;
        const distanceFromBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
        const rect = chatEl.getBoundingClientRect();
        const visible = hasActiveChat() && rect.width > 0 && rect.height > 0 && distanceFromBottom > 160;
        button.classList.toggle('stlb-hidden', !visible);
        if (!visible) return;
        setFloatingStyle(button, 'left', `${Math.min(window.innerWidth - 8, rect.right - 12)}px`);
        setFloatingStyle(button, 'top', `${Math.min(window.innerHeight - 8, rect.bottom - 12)}px`);
    }

    function jumpToBottom() {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return;
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
    }

    // =====================================================================
    // FLOATING MESSAGE ACTIONS
    // Keep the real controls inside their message: native and extension
    // handlers depend on closest('.mes'), .mes_block and delegated events.
    // A manual popover escapes chat clipping without changing DOM ancestry.
    // =====================================================================
    const ACTIONS_ID = 'stlb-message-actions';
    const ACTIONS_PANEL_ID = 'stlb-message-actions-panel';
    const ACTIONS_POSITION_KEY = 'stlb-message-actions-position';
    let actionsOffset = 0;
    let floatingActions = null;
    let actionsDrag = null;
    let suppressActionsClick = false;
    let actionsPosition = null;
    try {
        const position = JSON.parse(localStorage.getItem(ACTIONS_POSITION_KEY));
        if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
            actionsPosition = { x: clamp(position.x, 0, 1), y: clamp(position.y, 0, 1) };
        }
    } catch (_) { /* Device-local storage may be unavailable. */ }

    // Geometry is owned by LiteBranch CSS, even with theme !important rules.
    function setFloatingStyle(element, key, value) {
        const property = `--stlb-floating-${key}`;
        if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
    }

    function actionsViewport() {
        const viewport = window.visualViewport;
        const left = (viewport?.offsetLeft || 0) + 8;
        const top = (viewport?.offsetTop || 0) + 8;
        return { left, top,
            right: left + (viewport?.width || window.innerWidth) - 16,
            bottom: top + (viewport?.height || window.innerHeight) - 16 };
    }

    function onActionsPointerDown(event) {
        if (!event.isPrimary || event.button !== 0 || actionsDrag) return;
        const button = event.currentTarget;
        const rect = button.getBoundingClientRect();
        suppressActionsClick = false;
        actionsDrag = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
            right: rect.right, bottom: rect.bottom, x: rect.right, y: rect.bottom, moved: false };
        button.setPointerCapture(event.pointerId);
    }

    function onActionsPointerMove(event) {
        const drag = actionsDrag;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        drag.x = drag.right + dx;
        drag.y = drag.bottom + dy;
        event.currentTarget.classList.add('stlb-dragging');
        scheduleFloatingUpdate();
    }

    function onActionsPointerEnd(event) {
        const drag = actionsDrag;
        if (!drag || drag.id !== event.pointerId) return;
        actionsDrag = null;
        const button = event.currentTarget;
        button.classList.remove('stlb-dragging');
        suppressActionsClick = drag.moved;
        if (drag.moved && event.type === 'pointerup') {
            const viewport = actionsViewport();
            const width = viewport.right - viewport.left - button.offsetWidth;
            const height = viewport.bottom - viewport.top - button.offsetHeight;
            actionsPosition = {
                x: clamp((drag.x - viewport.left - button.offsetWidth) / Math.max(1, width), 0, 1),
                y: clamp((drag.y - viewport.top - button.offsetHeight) / Math.max(1, height), 0, 1),
            };
            try { localStorage.setItem(ACTIONS_POSITION_KEY, JSON.stringify(actionsPosition)); } catch (_) { /* noop */ }
        }
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        scheduleFloatingUpdate();
    }

    function ensureMessageActionsButton() {
        let button = document.getElementById(ACTIONS_ID);
        if (!getSettings().showMessageActions) {
            closeMessageActions();
            actionsDrag = null;
            button?.remove();
            return null;
        }
        if (button) return button;
        button = document.createElement('button');
        button.id = ACTIONS_ID;
        button.type = 'button';
        button.className = 'stlb-message-actions stlb-hidden interactable';
        button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m16 3 5 5M4 15 15.5 3.5a3.54 3.54 0 0 1 5 5L9 20l-6 1z"></path>
        </svg>`;
        button.title = `${t('actions.open')} · ${t('actions.drag')}`;
        button.setAttribute('aria-label', t('actions.open'));
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', ACTIONS_PANEL_ID);
        button.addEventListener('click', event => {
            if (suppressActionsClick && event.detail !== 0) { suppressActionsClick = false; return; }
            suppressActionsClick = false;
            if (floatingActions) closeMessageActions();
            else openMessageActions();
        });
        button.addEventListener('pointerdown', onActionsPointerDown);
        button.addEventListener('pointermove', onActionsPointerMove);
        button.addEventListener('pointerup', onActionsPointerEnd);
        button.addEventListener('pointercancel', onActionsPointerEnd);
        button.addEventListener('lostpointercapture', onActionsPointerEnd);
        document.body.append(button);
        return button;
    }

    function closeMessageActions(returnFocus = false) {
        const state = floatingActions;
        floatingActions = null;
        if (state) {
            state.observer.disconnect();
            // Restore each original position, including when a chat was detached.
            for (const { element, marker } of state.controls) {
                if (marker.parentNode) marker.replaceWith(element);
            }
            state.panel.remove();
        }
        const button = document.getElementById(ACTIONS_ID);
        button?.setAttribute('aria-expanded', 'false');
        if (returnFocus) button?.focus({ preventScroll: true });
    }

    function openMessageActions() {
        closeMessageActions();
        const chat = getChatArray();
        if (!hasActiveChat() || !chat.length) return;
        if (chat.length < 2) actionsOffset = 0;
        const index = chat.length - 1 - actionsOffset;
        const messageEl = document.querySelector(`#chat .mes[mesid="${index}"]`);
        const normal = messageEl?.querySelector('.mes_buttons');
        const editor = messageEl?.querySelector('.mes_edit_buttons');
        if (!normal || !editor || normal.parentElement !== editor.parentElement) {
            toast(t('actions.unavailable'), 'info');
            return;
        }

        const panel = document.createElement('div');
        panel.id = ACTIONS_PANEL_ID;
        panel.className = 'stlb-actions-panel';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', t('actions.open'));
        panel.innerHTML = `
            <div class="stlb-actions-heading">
                <select class="stlb-actions-target" aria-label="${escapeHtml(t('actions.target'))}">
                    <option value="0">${escapeHtml(t('actions.last'))}</option>
                    <option value="1" ${chat.length < 2 ? 'disabled' : ''}>${escapeHtml(t('actions.previous'))}</option>
                </select>
                <button type="button" class="stlb-actions-close interactable fa-solid fa-xmark"
                    title="${escapeHtml(t('actions.close'))}" aria-label="${escapeHtml(t('actions.close'))}"></button>
            </div>
            <div class="stlb-actions-message"></div>`;
        panel.querySelector('.stlb-actions-message').textContent = `#${index} · ${chat[index]?.name || t('pin.unknown')}`;
        const selector = panel.querySelector('select');
        selector.value = String(actionsOffset);
        selector.addEventListener('change', () => {
            actionsOffset = Number(selector.value) === 1 ? 1 : 0;
            openMessageActions();
        });
        panel.querySelector('.stlb-actions-close').addEventListener('click', () => closeMessageActions(true));

        const controls = [normal, editor].map(element => {
            const marker = document.createComment('stlb-message-control');
            element.before(marker);
            return { element, marker };
        });
        normal.before(panel);
        panel.append(normal, editor);
        const observer = new MutationObserver(mutations => {
            if (mutations.some(mutation => mutation.target !== panel || mutation.type === 'childList')) scheduleFloatingUpdate();
        });
        observer.observe(panel, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled'] });
        floatingActions = { panel, controls, observer, messageEl, message: chat[index], chat };
        if (typeof panel.showPopover === 'function') {
            panel.setAttribute('popover', 'manual');
            panel.showPopover();
        }
        document.getElementById(ACTIONS_ID)?.setAttribute('aria-expanded', 'true');
        updateMessageActions();
        selector.focus({ preventScroll: true });
    }

    function updateMessageActions() {
        const button = ensureMessageActionsButton();
        const chatEl = document.getElementById('chat');
        if (!button) return;
        const rect = chatEl?.getBoundingClientRect();
        const viewport = actionsViewport();
        const right = Math.min(viewport.right, (rect?.right || 0) - 12);
        const bottom = Math.min(viewport.bottom, (rect?.bottom || 0) - 12);
        const left = Math.max(viewport.left, (rect?.left || 0) + 8);
        const top = Math.max(viewport.top, (rect?.top || 0) + 8);
        const chat = getChatArray();
        const visible = hasActiveChat() && chat.length > 0 && rect?.width > 0 && rect?.height > 0
            && right - left >= 46 && bottom - top >= 110;
        button.classList.toggle('stlb-hidden', !visible);
        if (!visible) { closeMessageActions(); return; }
        const jump = document.getElementById(JUMP_BOTTOM_ID);
        const jumpVisible = jump && !jump.classList.contains('stlb-hidden');
        let buttonRight = right;
        let buttonBottom = bottom - (jumpVisible ? jump.offsetHeight + 8 : 0);
        if (actionsPosition || actionsDrag?.moved) {
            const minX = viewport.left + button.offsetWidth;
            const minY = viewport.top + button.offsetHeight;
            buttonRight = actionsDrag?.moved ? actionsDrag.x : minX + actionsPosition.x * (viewport.right - minX);
            buttonBottom = actionsDrag?.moved ? actionsDrag.y : minY + actionsPosition.y * (viewport.bottom - minY);
            buttonRight = clamp(buttonRight, minX, viewport.right);
            buttonBottom = clamp(buttonBottom, minY, viewport.bottom);
        }
        setFloatingStyle(button, 'left', `${buttonRight}px`);
        setFloatingStyle(button, 'top', `${buttonBottom}px`);

        const state = floatingActions;
        if (!state) return;
        const index = chat.length - 1 - actionsOffset;
        // Never silently retarget an open delete/edit menu after a new reply,
        // deletion, reordering, or chat switch.
        if (state.chat !== chat || state.message !== chat[index] || !state.messageEl.isConnected
            || Number(state.messageEl.getAttribute('mesid')) !== index
            || state.controls.some(({ element }) => !state.panel.contains(element))) {
            closeMessageActions();
            return;
        }
        const bounds = actionsPosition || actionsDrag?.moved ? viewport : { left, top, right, bottom };
        const panelBottom = buttonBottom - button.offsetHeight - 8;
        const spaceAbove = Math.max(0, panelBottom - bounds.top);
        const spaceBelow = Math.max(0, bounds.bottom - buttonBottom - 8);
        const below = spaceBelow > spaceAbove;
        const styles = {
            width: `${Math.min(window.matchMedia('(max-width: 600px)').matches ? 252 : 300, bounds.right - bounds.left)}px`,
            'max-height': `${below ? spaceBelow : spaceAbove}px`,
        };
        // Only write changed values: the panel observer also watches native
        // inline display changes when the editor / extension menu is toggled.
        for (const [key, value] of Object.entries(styles)) {
            setFloatingStyle(state.panel, key, value);
        }
        const panelRect = state.panel.getBoundingClientRect();
        const panelLeft = `${clamp(buttonRight - panelRect.width, bounds.left, bounds.right - panelRect.width)}px`;
        const panelTop = `${below ? buttonBottom + 8 : Math.max(bounds.top, panelBottom - panelRect.height)}px`;
        setFloatingStyle(state.panel, 'left', panelLeft);
        setFloatingStyle(state.panel, 'top', panelTop);
    }

    function onActionsOutsideClick(e) {
        if (!floatingActions || !(e.target instanceof Element)) return;
        // Keep save/cancel/delete within reach while typing in the native editor.
        if (e.target.closest('.edit_textarea, .reasoning_edit_textarea')?.closest('.mes') === floatingActions.messageEl) return;
        if (!e.target.closest(`#${ACTIONS_ID}, #${ACTIONS_PANEL_ID}`)) closeMessageActions();
    }

    function onActionsKeydown(e) {
        if (e.key !== 'Escape' || !floatingActions) return;
        if (!(e.target instanceof Element)) return;
        if (e.target !== document.body && !e.target.closest(`#${ACTIONS_ID}, #${ACTIONS_PANEL_ID}`)) return;
        e.preventDefault();
        e.stopPropagation();
        closeMessageActions(true);
    }

    function refreshPinButtons() {
        const pinned = new Set(getPinRecords().map(record => record.uid));
        document.querySelectorAll(`#chat .mes[mesid] .${PIN_BTN_CLASS}`).forEach(button => {
            const mesEl = button.closest('.mes[mesid]');
            const message = getChatArray()[Number(mesEl?.getAttribute('mesid'))];
            const isPinned = pinned.has(getMessageUid(message));
            button.classList.toggle('stlb-pinned', isPinned);
            button.title = t(isPinned ? 'pin.buttonRemove' : 'pin.buttonAdd');
            button.setAttribute('aria-label', button.title);
            button.setAttribute('aria-pressed', String(isPinned));
        });
    }

    async function togglePin(messageIndex, forceRemove = false) {
        const message = getChatArray()[messageIndex];
        if (!message || !hasActiveChat()) return;
        const records = getPinRecords();
        const existingUid = getMessageUid(message);
        const existingIndex = records.findIndex(record => record.uid === existingUid);

        if (existingIndex >= 0 || forceRemove) {
            if (existingIndex < 0) return;
            records.splice(existingIndex, 1);
            activePinIndex = Math.max(0, activePinIndex - 1);
        } else {
            const uid = ensureMessageUid(message);
            records.push({ uid, pinnedAt: Date.now() });
        }

        setPinRecords(records);
        renderPinNavigator();
        refreshPinButtons();
        try { await persistPins(); }
        catch (error) {
            console.error(`${LOG_PREFIX} pin save failed`, error);
            toast(t('pin.saveFailed'), 'error');
        }
    }

    async function reconcilePins() {
        if (reconcileRunning) {
            reconcilePending = true;
            return;
        }
        if (!hasActiveChat() || disposed) return;
        reconcileRunning = true;
        reconcilePending = false;
        try {
            const chat = getChatArray();
            const records = getPinRecords();
            const pinnedUids = new Set(records.map(record => record.uid));
            const seen = new Set();
            let messagesChanged = false;

            for (const message of chat) {
                const uid = getMessageUid(message);
                if (!uid) continue;
                if (!message.stlb_uid) {
                    message.stlb_uid = uid;
                    if (message.extra?.stlb_uid) delete message.extra.stlb_uid;
                    messagesChanged = true;
                }
                if (seen.has(uid)) {
                    message.stlb_uid = createUid();
                    messagesChanged = true;
                } else {
                    seen.add(uid);
                }
            }

            const existingUids = new Set(chat.map(getMessageUid).filter(Boolean));
            const validRecords = records.filter(record => existingUids.has(record.uid));
            const metadataChanged = validRecords.length !== records.length
                || validRecords.some(record => !pinnedUids.has(record.uid));
            if (metadataChanged) setPinRecords(validRecords);
            if (messagesChanged || metadataChanged) await persistPins();
        } catch (error) {
            console.error(`${LOG_PREFIX} pin reconciliation failed`, error);
        } finally {
            reconcileRunning = false;
            if (disposed) return;
            renderPinNavigator();
            refreshPinButtons();
            if (reconcilePending) reconcilePins();
        }
    }

    function waitForMoreMessages(token) {
        return new Promise(resolve => {
            const evt = event_types.MORE_MESSAGES_LOADED;
            if (!evt || !eventSource?.on) { resolve(false); return; }
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                eventSource.removeListener?.(evt, handler);
                resolve(value);
            };
            const handler = () => finish(token === jumpToken);
            const timeout = setTimeout(() => finish(false), 3000);
            eventSource.on(evt, handler);
        });
    }

    async function jumpToPin(pin) {
        const token = ++jumpToken;
        const chatId = ctx().getCurrentChatId?.() ?? ctx().chatId;
        let messageIndex = findMessageIndex(pin.record.uid);
        if (messageIndex < 0) { await reconcilePins(); return; }
        if (disposed) return;

        let target = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
        while (!target) {
            const more = document.getElementById('show_more_messages');
            if (!more || token !== jumpToken) return;
            const loaded = waitForMoreMessages(token);
            more.click();
            if (!await loaded) return;
            if ((ctx().getCurrentChatId?.() ?? ctx().chatId) !== chatId || token !== jumpToken) return;
            messageIndex = findMessageIndex(pin.record.uid);
            target = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
        }

        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        target.classList.remove('stlb-pin-highlight');
        void target.offsetWidth;
        target.classList.add('stlb-pin-highlight');
        later(() => target.classList.remove('stlb-pin-highlight'), 1800);
    }

    async function onPinNavigatorClick(e) {
        const control = e.target.closest('[data-stlb-pin-action]');
        if (!control) return;
        const pins = getResolvedPins();
        if (!pins.length) return;
        const action = control.dataset.stlbPinAction;
        if (action === 'prev') activePinIndex = (activePinIndex - 1 + pins.length) % pins.length;
        if (action === 'next') activePinIndex = (activePinIndex + 1) % pins.length;
        if (action === 'unpin') {
            await togglePin(pins[activePinIndex].messageIndex, true);
            return;
        }
        renderPinNavigator();
        if (action === 'jump' || action === 'prev' || action === 'next') {
            await jumpToPin(getResolvedPins()[activePinIndex]);
        }
    }

    // =====================================================================
    // MESSAGE BUTTON (in .extraMesButtons of every message)
    // =====================================================================
    const BTN_CLASS = 'stlb_mes_button';

    function injectButton(mesEl) {
        if (!(mesEl instanceof HTMLElement)) return;
        const holder = mesEl.querySelector('.extraMesButtons');
        if (!holder) return;

        if (!holder.querySelector('.' + PIN_BTN_CLASS)) {
            const pin = document.createElement('div');
            pin.className = `${PIN_BTN_CLASS} mes_button fa-solid fa-thumbtack interactable`;
            pin.title = t('pin.buttonAdd');
            pin.tabIndex = 0;
            pin.setAttribute('role', 'button');
            pin.setAttribute('aria-label', pin.title);
            pin.setAttribute('aria-pressed', 'false');
            holder.prepend(pin);
        }

        if (!isGroup() && !holder.querySelector('.' + BTN_CLASS)) {
            const btn = document.createElement('div');
            btn.className = `${BTN_CLASS} mes_button interactable`;
            btn.innerHTML = SPLIT_ICON_HTML;
            btn.title = t('btn.message');
            btn.tabIndex = 0;
            btn.setAttribute('role', 'button');
            btn.setAttribute('aria-label', btn.title);
            holder.prepend(btn);
        }

        const pinButton = holder.querySelector('.' + PIN_BTN_CLASS);
        if (pinButton) {
            const message = getChatArray()[Number(mesEl.getAttribute('mesid'))];
            const isPinned = getPinRecords().some(record => record.uid === getMessageUid(message));
            pinButton.classList.toggle('stlb-pinned', isPinned);
            pinButton.title = t(isPinned ? 'pin.buttonRemove' : 'pin.buttonAdd');
            pinButton.setAttribute('aria-label', pinButton.title);
            pinButton.setAttribute('aria-pressed', String(isPinned));
        }
    }

    function injectAddedMessages(mutations) {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                injectButton(mutation.target);
                continue;
            }
            for (const node of mutation.addedNodes) {
                if (!(node instanceof Element)) continue;
                const containingMessage = node.closest('.mes[mesid]');
                if (containingMessage) injectButton(containingMessage);
                node.querySelectorAll?.('.mes[mesid]').forEach(injectButton);
            }
        }
    }

    function injectAllButtons() {
        document.querySelectorAll('#chat .mes[mesid] .extraMesButtons').forEach(h => {
            injectButton(h.closest('.mes'));
        });
        refreshPinButtons();
    }

    // Delegated click handler for the message button.
    function onChatClick(e) {
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (target.closest(`#${NAV_ID}`)) {
            e.preventDefault();
            e.stopPropagation();
            onPinNavigatorClick(e);
            return;
        }
        const pin = target.closest('.' + PIN_BTN_CLASS);
        if (pin) {
            e.preventDefault();
            e.stopPropagation();
            const mesEl = pin.closest('.mes[mesid]');
            const mesId = Number(mesEl?.getAttribute('mesid'));
            if (Number.isInteger(mesId)) togglePin(mesId);
            return;
        }
        const btn = target.closest('.' + BTN_CLASS);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const mesEl = btn.closest('.mes[mesid]');
        if (!mesEl) return;
        const mesId = parseInt(mesEl.getAttribute('mesid'), 10);
        if (Number.isNaN(mesId)) return;
        branchFromMessage(mesId);
    }

    function onChatKeydown(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = e.target;
        if (!(target instanceof Element)) return;
        if (!target.closest(`.${BTN_CLASS}, .${PIN_BTN_CLASS}`)) return;
        e.preventDefault();
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    // =====================================================================
    // SETTINGS CARD (Extensions tab)
    // =====================================================================
    function addSettingsCard() {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host || document.getElementById('stlb-settings')) return;
        const s = getSettings();
        const html = `
        <div id="stlb-settings" class="stlb-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><span class="stlb-settings-icon">${SPLIT_ICON_HTML}</span> ${t('app.title')}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="stlb_settings_card">
                        <div class="stlb_settings_intro">${escapeHtml(t('set.intro'))}</div>

                        <div class="stlb_set_row">
                            <div class="stlb_set_text">
                                <div class="stlb_set_label" id="stlb-label-count">${escapeHtml(t('set.defaultCount'))}</div>
                                <div class="stlb_set_desc" id="stlb-desc-count">${escapeHtml(t('set.defaultCountDesc'))}</div>
                            </div>
                            <input type="number" min="1" step="1" id="stlb-set-count" class="text_pole stlb_num" value="${s.defaultCount}" aria-labelledby="stlb-label-count" aria-describedby="stlb-desc-count">
                        </div>

                        <div class="stlb_set_row stlb_set_toggle">
                            <div class="stlb_set_text">
                                <div class="stlb_set_label" id="stlb-label-ask">${escapeHtml(t('set.askEveryTime'))}</div>
                                <div class="stlb_set_desc" id="stlb-desc-ask">${escapeHtml(t('set.askEveryTimeDesc'))}</div>
                            </div>
                            <input type="checkbox" id="stlb-set-ask" ${s.askEveryTime ? 'checked' : ''} aria-labelledby="stlb-label-ask" aria-describedby="stlb-desc-ask">
                        </div>

                        <div class="stlb_set_row stlb_set_toggle">
                            <div class="stlb_set_text">
                                <div class="stlb_set_label" id="stlb-label-jump">${escapeHtml(t('set.showJumpBottom'))}</div>
                                <div class="stlb_set_desc" id="stlb-desc-jump">${escapeHtml(t('set.showJumpBottomDesc'))}</div>
                            </div>
                            <input type="checkbox" id="stlb-set-jump" ${s.showJumpBottom ? 'checked' : ''} aria-labelledby="stlb-label-jump" aria-describedby="stlb-desc-jump">
                        </div>

                        <div class="stlb_set_row stlb_set_toggle">
                            <div class="stlb_set_text">
                                <div class="stlb_set_label" id="stlb-label-actions">${escapeHtml(t('set.showMessageActions'))}</div>
                                <div class="stlb_set_desc" id="stlb-desc-actions">${escapeHtml(t('set.showMessageActionsDesc'))}</div>
                            </div>
                            <input type="checkbox" id="stlb-set-actions" ${s.showMessageActions ? 'checked' : ''} aria-labelledby="stlb-label-actions" aria-describedby="stlb-desc-actions">
                        </div>

                        <div class="stlb_settings_section">
                            <div class="stlb_settings_heading">${escapeHtml(t('set.summaryHeading'))}</div>

                            <div class="stlb_set_row stlb_set_toggle">
                                <div class="stlb_set_text">
                                    <div class="stlb_set_label" id="stlb-label-summary">${escapeHtml(t('set.summaryDefault'))}</div>
                                    <div class="stlb_set_desc" id="stlb-desc-summary">${escapeHtml(t('set.summaryDefaultDesc'))}</div>
                                </div>
                                <input type="checkbox" id="stlb-set-summary" ${s.summaryDefault ? 'checked' : ''} aria-labelledby="stlb-label-summary" aria-describedby="stlb-desc-summary">
                            </div>

                            <div class="stlb_set_row stlb_set_col">
                                <div class="stlb_set_text">
                                    <div class="stlb_set_label" id="stlb-label-prompt">${escapeHtml(t('set.summaryPrompt'))}</div>
                                    <div class="stlb_set_desc" id="stlb-desc-prompt">${escapeHtml(t('set.summaryPromptHint'))}</div>
                                </div>
                                <textarea id="stlb-set-prompt" class="text_pole stlb_textarea" rows="4" aria-labelledby="stlb-label-prompt" aria-describedby="stlb-desc-prompt">${escapeHtml(s.summaryPrompt)}</textarea>
                            </div>

                            <div class="stlb_set_row">
                                <div class="stlb_set_text">
                                    <div class="stlb_set_label" id="stlb-label-limit">${escapeHtml(t('set.summaryLimit'))}</div>
                                    <div class="stlb_set_desc" id="stlb-desc-limit">${escapeHtml(t('set.summaryLimitHint'))}</div>
                                </div>
                                <input type="number" min="500" step="500" id="stlb-set-limit" class="text_pole stlb_num" value="${s.summaryLimit}" aria-labelledby="stlb-label-limit" aria-describedby="stlb-desc-limit">
                            </div>
                        </div>

                        <div class="stlb_settings_section">
                            <div class="stlb_set_row stlb_set_col">
                                <div class="stlb_set_text">
                                    <div class="stlb_set_label" id="stlb-label-name">${escapeHtml(t('set.nameTemplate'))}</div>
                                    <div class="stlb_set_desc" id="stlb-desc-name">${escapeHtml(t('set.nameTemplateHint'))}</div>
                                </div>
                                <input type="text" id="stlb-set-name" class="text_pole" value="${escapeHtml(s.nameTemplate)}" aria-labelledby="stlb-label-name" aria-describedby="stlb-desc-name">
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
        host.insertAdjacentHTML('beforeend', html);

        const $set = $('#stlb-settings');
        $set.on('input', '#stlb-set-count', function () {
            const v = Math.max(1, Math.floor(Number(this.value) || 1));
            getSettings().defaultCount = v; save();
        });
        const syncToggleState = input => input.closest('.stlb_set_toggle')?.classList.toggle('stlb-checked', input.checked);
        $set.find('.stlb_set_toggle input[type="checkbox"]').each((_, input) => syncToggleState(input));
        $set.on('change', '#stlb-set-ask', function () { syncToggleState(this); getSettings().askEveryTime = this.checked; save(); });
        $set.on('change', '#stlb-set-jump', function () {
            syncToggleState(this);
            getSettings().showJumpBottom = this.checked;
            save();
            if (this.checked) updateJumpBottomButton();
            else document.getElementById(JUMP_BOTTOM_ID)?.remove();
            updateMessageActions();
        });
        $set.on('change', '#stlb-set-actions', function () {
            syncToggleState(this);
            getSettings().showMessageActions = this.checked;
            save();
            updateMessageActions();
        });
        $set.on('change', '#stlb-set-summary', function () { syncToggleState(this); getSettings().summaryDefault = this.checked; save(); });
        $set.on('input', '#stlb-set-prompt', function () { getSettings().summaryPrompt = this.value; save(); });
        $set.on('input', '#stlb-set-limit', function () {
            const v = Math.max(500, Math.floor(Number(this.value) || 500));
            getSettings().summaryLimit = v; save();
        });
        $set.on('input', '#stlb-set-name', function () { getSettings().nameTemplate = this.value; save(); });
        // Click anywhere on a toggle row flips its checkbox.
        $set.on('click', '.stlb_set_toggle', function (e) {
            if (e.target.tagName === 'INPUT') return;
            const cb = this.querySelector('input[type="checkbox"]');
            if (cb) { cb.checked = !cb.checked; $(cb).trigger('change'); }
        });
    }

    // =====================================================================
    // EVENT WIRING
    // =====================================================================
    const boundHandlers = [];
    const timers = new Set();
    let frameRequest = 0;
    function on(evt, fn) {
        if (!evt || !eventSource || typeof eventSource.on !== 'function') return;
        eventSource.on(evt, fn);
        boundHandlers.push([evt, fn]);
    }

    function later(fn, delay) {
        const timer = setTimeout(() => {
            timers.delete(timer);
            fn();
        }, delay);
        timers.add(timer);
        return timer;
    }

    document.addEventListener('click', onChatClick, true);
    document.addEventListener('keydown', onChatKeydown, true);
    document.addEventListener('click', onActionsOutsideClick);
    document.addEventListener('keydown', onActionsKeydown, true);
    const chatEl = document.getElementById('chat');
    ensureJumpBottomButton();
    const scheduleFloatingUpdate = () => {
        if (frameRequest || disposed) return;
        frameRequest = requestAnimationFrame(() => {
            frameRequest = 0;
            if (!disposed) {
                updateJumpBottomButton();
                updateMessageActions();
            }
        });
    };
    const scheduleJumpBottomUpdate = scheduleFloatingUpdate;
    const onChatScroll = scheduleJumpBottomUpdate;
    const onWindowResize = scheduleJumpBottomUpdate;
    chatEl?.addEventListener('scroll', onChatScroll, { passive: true });
    window.addEventListener('resize', onWindowResize, { passive: true });
    window.visualViewport?.addEventListener('resize', onWindowResize, { passive: true });
    window.visualViewport?.addEventListener('scroll', onWindowResize, { passive: true });
    const chatResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleFloatingUpdate) : null;
    if (chatEl) chatResizeObserver?.observe(chatEl);

    const reinjectDebounced = (() => {
        let tmr = null;
        return () => {
            if (tmr) {
                clearTimeout(tmr);
                timers.delete(tmr);
            }
            tmr = later(() => {
                tmr = null;
                injectAllButtons();
                renderPinNavigator();
                updateJumpBottomButton();
                updateMessageActions();
            }, 80);
        };
    })();

    const reconcileDebounced = (() => {
        let tmr = null;
        return () => {
            if (tmr) {
                clearTimeout(tmr);
                timers.delete(tmr);
            }
            tmr = later(() => {
                tmr = null;
                reconcilePins();
            }, 120);
        };
    })();

    on(event_types.CHARACTER_MESSAGE_RENDERED, (idx) => {
        if (typeof idx === 'number') {
            const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
            if (el) injectButton(el);
        } else { reinjectDebounced(); }
        scheduleJumpBottomUpdate();
    });
    on(event_types.USER_MESSAGE_RENDERED, (idx) => {
        if (typeof idx === 'number') {
            const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
            if (el) injectButton(el);
        } else { reinjectDebounced(); }
        scheduleJumpBottomUpdate();
    });
    on(event_types.MORE_MESSAGES_LOADED, reinjectDebounced);
    on(event_types.MESSAGE_SWIPED, () => { reinjectDebounced(); reconcileDebounced(); });
    on(event_types.MESSAGE_EDITED, () => { reinjectDebounced(); renderPinNavigator(); });
    on(event_types.MESSAGE_UPDATED, () => { reinjectDebounced(); renderPinNavigator(); });
    on(event_types.MESSAGE_DELETED, () => { reconcileDebounced(); scheduleFloatingUpdate(); });
    on(event_types.CHAT_CHANGED, () => {
        closeMessageActions();
        actionsOffset = 0;
        jumpToken++;
        activePinIndex = 0;
        reinjectDebounced();
        reconcileDebounced();
        scheduleJumpBottomUpdate();
    });
    on(event_types.APP_READY, () => { reinjectDebounced(); reconcileDebounced(); });

    const chatObserver = new MutationObserver(mutations => {
        if (!disposed) {
            injectAddedMessages(mutations);
            scheduleJumpBottomUpdate();
        }
    });
    const observedChat = document.getElementById('chat');
    if (observedChat) {
        chatObserver.observe(observedChat, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });
    }

    // =====================================================================
    // SLASH COMMAND — /litebranch [N] [mes=id] [summary=on|off]
    // =====================================================================
    try {
        const c = ctx();
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = c;
        if (SlashCommandParser && SlashCommand) {
            const named = [];
            const unnamed = [];
            if (SlashCommandNamedArgument && ARGUMENT_TYPE) {
                named.push(SlashCommandNamedArgument.fromProps({
                    name: 'mes',
                    description: 'anchor message id (defaults to the last message)',
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    isRequired: false,
                }));
                named.push(SlashCommandNamedArgument.fromProps({
                    name: 'summary',
                    description: 'generate an AI summary of the older part',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    isRequired: false,
                }));
            }
            if (SlashCommandArgument && ARGUMENT_TYPE) {
                unnamed.push(SlashCommandArgument.fromProps({
                    description: 'number of messages to carry over (defaults to your setting)',
                    typeList: [ARGUMENT_TYPE.NUMBER],
                    isRequired: false,
                }));
            }
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'litebranch',
                aliases: ['lbranch'],
                namedArgumentList: named,
                unnamedArgumentList: unnamed,
                helpString: 'Create a lightweight branch keeping only the last N messages. '
                    + 'Usage: /litebranch [N] [mes=id] [summary=on|off]',
                callback: async (args, value) => {
                    const s = getSettings();
                    const chat = getChatArray();
                    const count = (value !== undefined && value !== '' && Number(value) > 0)
                        ? Math.floor(Number(value)) : s.defaultCount;
                    const mesId = (args && args.mes !== undefined && args.mes !== '')
                        ? Math.floor(Number(args.mes)) : (chat.length - 1);
                    let summary = s.summaryDefault;
                    if (args && args.summary !== undefined && args.summary !== '') {
                        summary = String(args.summary).toLowerCase() === 'true'
                            || String(args.summary).toLowerCase() === 'on';
                    }
                    await createBranch(mesId, count, summary);
                    return '';
                },
            }));
        }
    } catch (e) { console.error(`${LOG_PREFIX} slash command registration failed`, e); }

    // =====================================================================
    // INIT
    // =====================================================================
    addSettingsCard();
    ensurePinNavigator();
    ensureJumpBottomButton();
    later(() => {
        injectAllButtons();
        reconcilePins();
        updateJumpBottomButton();
        updateMessageActions();
    }, 600);

    console.log(`${LOG_PREFIX} initialized.`);

    // =====================================================================
    // DISPOSE (hot-reload)
    // =====================================================================
    window.__stLiteBranchDispose = function () {
        disposed = true;
        try {
            boundHandlers.forEach(([evt, fn]) => {
                try { eventSource.removeListener?.(evt, fn); } catch (_) { /* noop */ }
            });
            jumpToken++;
            closeMessageActions();
            actionsDrag = null;
            chatObserver.disconnect();
            chatResizeObserver?.disconnect();
            timers.forEach(timer => clearTimeout(timer));
            timers.clear();
            if (frameRequest) cancelAnimationFrame(frameRequest);
            frameRequest = 0;
            document.removeEventListener('click', onChatClick, true);
            document.removeEventListener('keydown', onChatKeydown, true);
            document.removeEventListener('click', onActionsOutsideClick);
            document.removeEventListener('keydown', onActionsKeydown, true);
            chatEl?.removeEventListener('scroll', onChatScroll);
            window.removeEventListener('resize', onWindowResize);
            window.visualViewport?.removeEventListener('resize', onWindowResize);
            window.visualViewport?.removeEventListener('scroll', onWindowResize);
            document.querySelectorAll(`.${BTN_CLASS}, .${PIN_BTN_CLASS}`).forEach(el => el.remove());
            document.querySelectorAll('.stlb-pin-highlight').forEach(el => el.classList.remove('stlb-pin-highlight'));
            document.getElementById(NAV_ID)?.remove();
            document.getElementById(JUMP_BOTTOM_ID)?.remove();
            document.getElementById(ACTIONS_ID)?.remove();
            $('#stlb-settings').remove();
        } catch (e) { console.error(`${LOG_PREFIX} dispose error`, e); }
        if (window.__stLiteBranchInstance === instanceToken) {
            window.__stLiteBranchInitialized = false;
            window.__stLiteBranchInstance = null;
        }
    };
});
