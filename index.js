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
    async function saveAndOpenBranch(branchName, messages, sourceName) {
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
        if (withSummary) {
            let summaryMsg = null;
            try { summaryMsg = await makeSummaryMessage(start); }
            catch (e) { console.error(`${LOG_PREFIX}`, e); }
            if (summaryMsg) {
                messages = [summaryMsg, ...carried];
            } else if (start > 0) {
                toast(t('toast.summaryFailed'), 'warning');
            }
        }

        const branchName = buildBranchName(mesId);
        try {
            await saveAndOpenBranch(branchName, messages, sourceName);
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
    // MESSAGE BUTTON (in .extraMesButtons of every message)
    // =====================================================================
    const BTN_CLASS = 'stlb_mes_button';

    function injectButton(mesEl) {
        if (!(mesEl instanceof HTMLElement)) return;
        if (isGroup()) return; // solo only
        const holder = mesEl.querySelector('.extraMesButtons');
        if (!holder || holder.querySelector('.' + BTN_CLASS)) return;
        const btn = document.createElement('div');
        btn.className = `${BTN_CLASS} mes_button fa-solid fa-code-branch interactable`;
        btn.title = t('btn.message');
        btn.tabIndex = 0;
        holder.prepend(btn);
    }

    function injectAllButtons() {
        if (isGroup()) return;
        document.querySelectorAll('#chat .mes[mesid] .extraMesButtons').forEach(h => {
            injectButton(h.closest('.mes'));
        });
    }

    // Delegated click handler for the message button.
    function onChatClick(e) {
        const target = e.target;
        if (!(target instanceof Element)) return;
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
                    <b><i class="fa-solid fa-code-branch"></i> ${t('app.title')}</b>
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
    function on(evt, fn) {
        if (!evt || !eventSource || typeof eventSource.on !== 'function') return;
        eventSource.on(evt, fn);
        boundHandlers.push([evt, fn]);
    }

    document.addEventListener('click', onChatClick, true);

    const reinjectDebounced = (() => {
        let tmr = null;
        return () => { clearTimeout(tmr); tmr = setTimeout(injectAllButtons, 80); };
    })();

    on(event_types.CHARACTER_MESSAGE_RENDERED, (idx) => {
        if (isGroup()) return;
        if (typeof idx === 'number') {
            const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
            if (el) injectButton(el);
        } else { reinjectDebounced(); }
    });
    on(event_types.USER_MESSAGE_RENDERED, (idx) => {
        if (isGroup()) return;
        if (typeof idx === 'number') {
            const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
            if (el) injectButton(el);
        } else { reinjectDebounced(); }
    });
    on(event_types.MORE_MESSAGES_LOADED, reinjectDebounced);
    on(event_types.MESSAGE_SWIPED, reinjectDebounced);
    on(event_types.MESSAGE_EDITED, reinjectDebounced);
    on(event_types.MESSAGE_UPDATED, reinjectDebounced);
    on(event_types.CHAT_CHANGED, reinjectDebounced);
    on(event_types.APP_READY, reinjectDebounced);

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
    setTimeout(injectAllButtons, 600);

    console.log(`${LOG_PREFIX} initialized.`);

    // =====================================================================
    // DISPOSE (hot-reload)
    // =====================================================================
    window.__stLiteBranchDispose = function () {
        try {
            boundHandlers.forEach(([evt, fn]) => {
                try { eventSource.removeListener?.(evt, fn); } catch (_) { /* noop */ }
            });
            document.removeEventListener('click', onChatClick, true);
            document.querySelectorAll('.' + BTN_CLASS).forEach(el => el.remove());
            $('#stlb-settings').remove();
        } catch (e) { console.error(`${LOG_PREFIX} dispose error`, e); }
        window.__stLiteBranchInitialized = false;
    };
});
