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

    // ---------------------------------------------------------------------
    // Settings + storage
    // ---------------------------------------------------------------------
    const DEFAULT_SUMMARY_PROMPT =
        'Summarize the roleplay so far in a concise recap that preserves the important '
        + 'facts, relationships, ongoing plot threads and the current situation. '
        + 'Write it as neutral notes, not as a message in character. Do not add anything '
        + 'that did not happen.';

    const DEFAULT_SETTINGS = {
        defaultCount: 50,
        askEveryTime: true,
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
        if (typeof s.summaryDefault !== 'boolean') s.summaryDefault = false;
        if (typeof s.summaryPrompt !== 'string' || !s.summaryPrompt.trim()) s.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
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

    function buildBranchName(mesId) {
        const s = getSettings();
        const c = ctx();
        const date = (typeof c.humanizedDateTime === 'function')
            ? c.humanizedDateTime()
            : new Date().toISOString().replace(/[:.]/g, '-');
        const out = s.nameTemplate
            .replace(/\{chat\}/g, getSourceChatName())
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
    async function makeSummaryMessage(startIdx) {
        const s = getSettings();
        const c = ctx();
        const chat = getChatArray();
        if (startIdx <= 0) return null; // nothing older to summarize

        const older = chat.slice(0, startIdx);
        if (!older.length) return null;

        // Flatten older messages to plain text, trimmed to summaryLimit chars
        // (kept from the END, which is the most recent / most relevant part).
        let text = older
            .map(m => `${m.name || (m.is_user ? 'User' : 'Char')}: ${String(m.mes || '').trim()}`)
            .join('\n\n');
        if (text.length > s.summaryLimit) {
            text = '…\n' + text.slice(text.length - s.summaryLimit);
        }

        const prompt = `${s.summaryPrompt}\n\n---\n${text}\n---`;

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
            name: (c.characters?.[c.characterId]?.name) || c.name2 || 'System',
            is_user: false,
            is_system: false, // false so it DOES get sent to the model as context
            send_date: now,
            mes: `${t('summary.header')}\n\n${summary}`,
            extra: { litebranch_summary: true },
        };
    }

    // Save an arbitrary message array under a new chat file for the current
    // character via the server endpoint, then open it. Solo chats only.
    async function saveAndOpenBranch(branchName, messages, sourceName, pinnedUids = []) {
        const c = ctx();
        const char = c.characters?.[c.characterId];
        if (!char) throw new Error('No active character.');

        // Fresh metadata: link to the parent, drop any integrity slug so the
        // brand-new file passes the server's integrity check.
        const metadata = {
            main_chat: sourceName,
            litebranch: {
                source: sourceName,
                created: new Date().toISOString(),
                count: messages.length,
            },
        };
        if (pinnedUids.length) {
            metadata[SETTINGS_KEY] = {
                pinnedMessages: pinnedUids.map(uid => ({ uid, pinnedAt: Date.now() })),
            };
        }
        const chatHeader = {
            chat_metadata: metadata,
            user_name: 'unused',
            character_name: 'unused',
        };

        const res = await fetch('/api/chats/save', {
            method: 'POST',
            cache: 'no-cache',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({
                ch_name: char.name,
                file_name: branchName,
                chat: [chatHeader, ...messages],
                avatar_url: char.avatar,
                force: false,
            }),
        });
        if (!res.ok) {
            let detail = res.statusText;
            try { detail = (await res.json())?.error || detail; } catch (_) { /* noop */ }
            throw new Error(`save failed: ${detail}`);
        }

        // Switch to the freshly created chat.
        await c.openCharacterChat(branchName);
    }

    // The whole flow. `mesId` is the anchor (inclusive, branch goes back from it).
    async function createBranch(mesId, count, withSummary) {
        const c = ctx();
        if (!hasOpenChat()) { toast(t('toast.noChat'), 'warning'); return false; }
        if (isGroup()) { toast(t('toast.groupUnsupported'), 'warning'); return false; }

        const chat = getChatArray();
        if (!chat.length) { toast(t('toast.empty'), 'warning'); return false; }

        mesId = clamp(Number(mesId), 0, chat.length - 1);
        count = Math.max(1, Math.floor(Number(count) || 1));

        const { start, end } = computeRange(mesId, count);
        const sourceName = getSourceChatName();

        toast(t('toast.creating'), 'info');

        // Make sure the current chat is persisted before we read from it.
        try { await c.saveChat(); } catch (_) { /* best effort */ }

        const carried = structuredClone(chat.slice(start, end + 1));

        let messages = carried;
        const pinnedUids = [];
        if (withSummary) {
            let summaryMsg = null;
            try { summaryMsg = await makeSummaryMessage(start); }
            catch (e) { console.error(`${LOG_PREFIX}`, e); }
            if (summaryMsg) {
                summaryMsg.stlb_uid = createUid();
                pinnedUids.push(summaryMsg.stlb_uid);
                messages = [summaryMsg, ...carried];
            } else if (start > 0) {
                toast(t('toast.summaryFailed'), 'warning');
            }
        }

        const branchName = buildBranchName(mesId);
        try {
            await saveAndOpenBranch(branchName, messages, sourceName, pinnedUids);
        } catch (e) {
            console.error(`${LOG_PREFIX} createBranch failed`, e);
            toast(t('toast.failed'), 'error');
            return false;
        }

        toast(t('toast.done', { n: carried.length }), 'success');
        return true;
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

            <div class="stlb-range" id="stlb-range">${escapeHtml(buildRangeText(defCount))}</div>

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

        const popup = new Popup(dom, POPUP_TYPE.TEXT ?? 1, '', {
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
        return getPinRecords()
            .map(record => ({ record, messageIndex: findMessageIndex(record.uid) }))
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
        nav.querySelectorAll('[data-stlb-pin-action]').forEach(control => {
            control.setAttribute('aria-label', control.title);
        });
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
        if (!hasActiveChat()) return;
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

        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
                                <div class="stlb_set_label">${escapeHtml(t('set.defaultCount'))}</div>
                                <div class="stlb_set_desc">${escapeHtml(t('set.defaultCountDesc'))}</div>
                            </div>
                            <input type="number" min="1" step="1" id="stlb-set-count" class="text_pole stlb_num" value="${s.defaultCount}">
                        </div>

                        <div class="stlb_set_row stlb_set_toggle">
                            <div class="stlb_set_text">
                                <div class="stlb_set_label">${escapeHtml(t('set.askEveryTime'))}</div>
                                <div class="stlb_set_desc">${escapeHtml(t('set.askEveryTimeDesc'))}</div>
                            </div>
                            <input type="checkbox" id="stlb-set-ask" ${s.askEveryTime ? 'checked' : ''}>
                        </div>

                        <div class="stlb_settings_section">
                            <div class="stlb_settings_heading">${escapeHtml(t('set.summaryHeading'))}</div>

                            <div class="stlb_set_row stlb_set_toggle">
                                <div class="stlb_set_text">
                                    <div class="stlb_set_label">${escapeHtml(t('set.summaryDefault'))}</div>
                                    <div class="stlb_set_desc">${escapeHtml(t('set.summaryDefaultDesc'))}</div>
                                </div>
                                <input type="checkbox" id="stlb-set-summary" ${s.summaryDefault ? 'checked' : ''}>
                            </div>

                            <div class="stlb_set_block">
                                <div class="stlb_set_label">${escapeHtml(t('set.summaryPrompt'))}</div>
                                <textarea id="stlb-set-prompt" class="text_pole stlb_textarea" rows="4">${escapeHtml(s.summaryPrompt)}</textarea>
                                <div class="stlb_set_desc">${escapeHtml(t('set.summaryPromptHint'))}</div>
                            </div>

                            <div class="stlb_set_block">
                                <div class="stlb_set_label">${escapeHtml(t('set.summaryLimit'))}</div>
                                <input type="number" min="500" step="500" id="stlb-set-limit" class="text_pole stlb_num" value="${s.summaryLimit}">
                                <div class="stlb_set_desc">${escapeHtml(t('set.summaryLimitHint'))}</div>
                            </div>
                        </div>

                        <div class="stlb_settings_section">
                            <div class="stlb_set_block">
                                <div class="stlb_set_label">${escapeHtml(t('set.nameTemplate'))}</div>
                                <input type="text" id="stlb-set-name" class="text_pole" value="${escapeHtml(s.nameTemplate)}">
                                <div class="stlb_set_desc">${escapeHtml(t('set.nameTemplateHint'))}</div>
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
        $set.on('change', '#stlb-set-ask', function () { getSettings().askEveryTime = this.checked; save(); });
        $set.on('change', '#stlb-set-summary', function () { getSettings().summaryDefault = this.checked; save(); });
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
    });
    on(event_types.USER_MESSAGE_RENDERED, (idx) => {
        if (typeof idx === 'number') {
            const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
            if (el) injectButton(el);
        } else { reinjectDebounced(); }
    });
    on(event_types.MORE_MESSAGES_LOADED, reinjectDebounced);
    on(event_types.MESSAGE_SWIPED, reinjectDebounced);
    on(event_types.MESSAGE_EDITED, () => { reinjectDebounced(); renderPinNavigator(); });
    on(event_types.MESSAGE_UPDATED, () => { reinjectDebounced(); renderPinNavigator(); });
    on(event_types.MESSAGE_DELETED, reconcileDebounced);
    on(event_types.MESSAGE_SENT, reconcileDebounced);
    on(event_types.MESSAGE_RECEIVED, reconcileDebounced);
    on(event_types.CHAT_CHANGED, () => {
        jumpToken++;
        activePinIndex = 0;
        reinjectDebounced();
        reconcileDebounced();
    });
    on(event_types.APP_READY, () => { reinjectDebounced(); reconcileDebounced(); });

    const chatObserver = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => mutation.type === 'childList'
            || (mutation.type === 'attributes' && mutation.attributeName === 'mesid'));
        if (relevant) {
            reinjectDebounced();
            reconcileDebounced();
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
    await loadI18n();
    addSettingsCard();
    ensurePinNavigator();
    later(() => {
        injectAllButtons();
        reconcilePins();
    }, 600);

    console.log(`${LOG_PREFIX} initialized.`);

    // =====================================================================
    // DISPOSE (hot-reload)
    // =====================================================================
    window.__stLiteBranchDispose = function () {
        try {
            boundHandlers.forEach(([evt, fn]) => {
                try { eventSource.removeListener?.(evt, fn); } catch (_) { /* noop */ }
            });
            jumpToken++;
            chatObserver.disconnect();
            timers.forEach(timer => clearTimeout(timer));
            timers.clear();
            document.removeEventListener('click', onChatClick, true);
            document.removeEventListener('keydown', onChatKeydown, true);
            document.querySelectorAll(`.${BTN_CLASS}, .${PIN_BTN_CLASS}`).forEach(el => el.remove());
            document.querySelectorAll('.stlb-pin-highlight').forEach(el => el.classList.remove('stlb-pin-highlight'));
            document.getElementById(NAV_ID)?.remove();
            $('#stlb-settings').remove();
        } catch (e) { console.error(`${LOG_PREFIX} dispose error`, e); }
        window.__stLiteBranchInitialized = false;
    };
});
