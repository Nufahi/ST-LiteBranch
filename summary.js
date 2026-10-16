// History budgets are character budgets for transcript text, not model tokens.
export function buildSummaryPlan(chat, start, { summaryLimit, summaryMode }) {
    const limit = Math.max(500, Math.floor(Number(summaryLimit) || 12000));
    const entries = [];
    for (let i = 0; i < start; i++) {
        const m = chat[i];
        if (!m || m.is_system || m.is_hidden || m.extra?.hidden || m.extra?.is_hidden || m.extra?.isSmallSys) continue;
        const body = String(m.mes || '').trim();
        if (body) entries.push(`${m.name || (m.is_user ? 'User' : 'Char')}: ${body}`);
    }
    const total = entries.length;
    const skipped = start - total;
    if (summaryMode === 'staged') {
        const chunks = [];
        let current = '';
        for (const entry of entries) {
            // Oversized individual messages are split, never silently discarded.
            let text = entry;
            if (current && current.length + 2 + text.length > limit) {
                chunks.push(current); current = '';
            }
            while (text.length > limit) {
                chunks.push(text.slice(0, limit)); text = text.slice(limit);
            }
            if (text) current += (current ? '\n\n' : '') + text;
        }
        if (current) chunks.push(current);
        return { chunks, total, included: total, omitted: 0, partial: 0, skipped, chars: chunks.reduce((n, x) => n + x.length, 0) };
    }
    const selected = [];
    let remaining = limit;
    let partial = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const separator = selected.length ? 2 : 0;
        if (remaining <= separator) break;
        remaining -= separator;
        const text = entries[i];
        selected.push(text.slice(-remaining));
        if (text.length > remaining) partial++;
        remaining -= Math.min(text.length, remaining);
    }
    const text = selected.reverse().join('\n\n');
    return { chunks: text ? [text] : [], total, included: selected.length, omitted: total - selected.length, partial, skipped, chars: text.length };
}

export function summaryControls(s, t, escapeHtml, prefix) {
    const label = key => escapeHtml(t(key));
    return `
        <label class="stlb-field"><span class="stlb-label">${label('summary.mode')}</span>
            <select id="${prefix}-mode" class="text_pole">
                <option value="tail" ${s.summaryMode === 'tail' ? 'selected' : ''}>${label('summary.tail')}</option>
                <option value="staged" ${s.summaryMode === 'staged' ? 'selected' : ''}>${label('summary.staged')}</option>
            </select>
        </label>
        <label class="stlb-field"><span class="stlb-label">${label('summary.budget')}</span>
            <input id="${prefix}-budget" type="number" class="text_pole" min="500" step="500" value="${s.summaryLimit}">
            <span class="stlb-hint">${label('summary.budgetHint')}</span>
        </label>
        <label class="stlb-check"><input id="${prefix}-preview" type="checkbox" ${s.summaryPreview ? 'checked' : ''}>
            <span>${label('summary.previewOption')}</span></label>
        <label class="stlb-check"><input id="${prefix}-lorebooks" type="checkbox" ${s.summaryLorebooks ? 'checked' : ''}>
            <span>${label('summary.lorebooks')}</span></label>
        <div class="stlb-hint">${label('summary.lorebooksHint')}</div>`;
}

export function readSummaryOptions(dom, prefix) {
    return {
        summaryMode: dom.querySelector(`#${prefix}-mode`).value,
        summaryLimit: Number(dom.querySelector(`#${prefix}-budget`).value),
        summaryPreview: dom.querySelector(`#${prefix}-preview`).checked,
        summaryLorebooks: dom.querySelector(`#${prefix}-lorebooks`).checked,
    };
}

export function renderCoverage(plan, t) {
    return t('summary.coverage', { ...plan, steps: plan.chunks.length });
}

export function createSummaryService({ ctx, t, escapeHtml }) {
    async function preview(text, plan) {
        const c = ctx();
        if (!c.Popup) throw new Error('Summary preview requires the SillyTavern Popup API');
        const dom = document.createElement('div');
        dom.innerHTML = `<div class="stlb-dialog">
            <p>${escapeHtml(renderCoverage(plan, t))}</p>
            <label class="stlb-field"><span>${escapeHtml(t('summary.edit'))}</span>
                <textarea class="text_pole" rows="16"></textarea></label>
            <div role="alert" class="stlb-hint"></div></div>`;
        const input = dom.querySelector('textarea');
        input.value = text;
        const popup = new c.Popup(dom, c.POPUP_TYPE?.TEXT ?? 1, t('summary.previewTitle'), {
            okButton: t('dlg.create'), cancelButton: t('dlg.cancel'), wide: true,
            onClosing: popup => {
                if (popup.result === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1) && !input.value.trim()) {
                    dom.querySelector('[role="alert"]').textContent = t('summary.empty');
                    return false;
                }
                return true;
            },
        });
        if (await popup.show() !== (c.POPUP_RESULT?.AFFIRMATIVE ?? 1)) return null;
        if (!input.value.trim()) throw new Error('Empty summary');
        return input.value.trim();
    }

    async function generate(plan, options, source, isSameSource) {
        if (!plan.chunks.length) return null;
        const c = ctx();
        const progress = document.createElement('div');
        progress.className = 'stlb-summary-progress';
        progress.setAttribute('role', 'status');
        const status = document.createElement('span');
        const cancel = document.createElement('button');
        cancel.className = 'menu_button';
        cancel.textContent = t('dlg.cancel');
        let cancelled = false;
        cancel.onclick = () => { cancelled = true; cancel.disabled = true; status.textContent = t('summary.cancelling'); };
        progress.append(status, cancel);
        document.body.append(progress);
        const check = () => {
            if (cancelled) throw new Error(t('summary.cancelled'));
            if (!isSameSource(source)) throw new Error(t('toast.sourceChanged'));
        };
        try {
            let text = '';
            for (let i = 0; i < plan.chunks.length; i++) {
                check();
                status.textContent = t('summary.progress', { current: i + 1, total: plan.chunks.length });
                const prior = text ? `\n\nPrevious continuity summary:\n${text}\n\nUpdate it with the next chronological transcript chunk. Preserve relevant earlier facts; return a complete replacement summary, not just the new events.` : '';
                const quietPrompt = `${options.summaryPrompt}${prior}\n\nTranscript (${i + 1}/${plan.chunks.length}):\n---\n${plan.chunks[i]}\n---`;
                // Native quiet generation scans enabled WI using its normal activation/budget rules.
                // skipWIAN also affects Author's Note, as defined by SillyTavern.
                text = String(await c.generateQuietPrompt({ quietPrompt, skipWIAN: !options.summaryLorebooks }) || '').trim();
                check();
                if (!text) throw new Error(t('summary.empty'));
            }
            progress.remove();
            if (options.summaryPreview) text = await preview(text, plan);
            check();
            if (text === null) return null;
            return {
                name: source.groupId ? 'Narrator' : source.characterName || 'System',
                is_user: false, is_system: false, send_date: Date.now(),
                mes: `[ Story so far ]\n\n${text}`,
                extra: { litebranch_summary: true, ...(source.groupId ? { type: 'narrator' } : {}) },
            };
        } finally {
            progress.remove();
        }
    }
    return { generate };
}
