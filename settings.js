export const DEFAULT_SUMMARY_PROMPT =
    'Write a compact continuity summary of the roleplay transcript for use as context '
    + 'in a continued chat. Preserve established facts, character identities and relationships, '
    + 'important decisions, promises, inventory or status changes, unresolved goals, and the '
    + 'current location and situation. Give recent and ongoing events priority over obsolete detail. '
    + 'Use dense, clear bullet points in the language of the transcript. Do not roleplay, address '
    + 'the user or invent information. Lorebook information is background, not evidence that '
    + 'an event happened. Output only the summary.';

export const DEFAULT_SETTINGS = {
    defaultCount: 50,
    askEveryTime: true,
    showJumpBottom: true,
    showMessageActions: true,
    summaryDefault: false,
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    summaryLimit: 12000,
    summaryPreview: false,
    summaryLorebooks: true,
    summaryMode: 'tail',
    nameTemplate: '{chat} — lite @{mes} {date}',
};

export function createSettingsStore(ctx, key) {
    function getSettings() {
        const settings = ctx().extensionSettings;
        if (!settings[key] || typeof settings[key] !== 'object') settings[key] = {};
        const s = settings[key];
        for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (typeof s[name] !== typeof value) s[name] = value;
        }
        if (!Number.isFinite(s.defaultCount) || s.defaultCount < 1) s.defaultCount = 50;
        if (!Number.isFinite(s.summaryLimit) || s.summaryLimit < 500) s.summaryLimit = 12000;
        s.summaryLimit = Math.floor(s.summaryLimit);
        if (!['tail', 'staged'].includes(s.summaryMode)) s.summaryMode = 'tail';
        if (!s.summaryPrompt.trim()
            || s.summaryPrompt.startsWith('Summarize the roleplay so far in a concise recap')
            || s.summaryPrompt.startsWith('Write a compact English continuity summary of the roleplay transcript')) {
            s.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
        }
        if (!s.nameTemplate.trim()) s.nameTemplate = DEFAULT_SETTINGS.nameTemplate;
        return s;
    }
    return { getSettings, save: () => ctx().saveSettingsDebounced() };
}
