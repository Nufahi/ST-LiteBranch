const assert = require('node:assert/strict');
const { test } = require('node:test');

test('tail coverage counts partial and omitted messages and excludes hidden content', async () => {
    const { buildSummaryPlan } = await import('../summary.js');
    const chat = Array.from({ length: 4 }, (_, i) => ({ name: 'A', mes: `${i}`.repeat(300) }));
    chat.push({ mes: 'secret', is_hidden: true });
    const plan = buildSummaryPlan(chat, 5, { summaryLimit: 500, summaryMode: 'tail' });
    assert.equal(plan.included, 2);
    assert.equal(plan.partial, 1);
    assert.equal(plan.omitted, 2);
    assert.equal(plan.skipped, 1);
    assert.equal(plan.chars, 500);
    assert.ok(plan.chunks[0].endsWith('3'.repeat(300)));
    assert.ok(!plan.chunks[0].includes('secret'));
});

test('staged plan includes every character of oversized messages in order', async () => {
    const { buildSummaryPlan } = await import('../summary.js');
    const mes = 'begin' + 'x'.repeat(1700) + 'end';
    const plan = buildSummaryPlan([{ name: 'A', mes }], 1, { summaryLimit: 500, summaryMode: 'staged' });
    assert.equal(plan.omitted, 0);
    assert.equal(plan.partial, 0);
    assert.equal(plan.chunks.length, 4);
    assert.ok(plan.chunks.every(x => x.length <= 500));
    assert.equal(plan.chunks.join(''), 'A: ' + mes);
});

function documentStub() {
    const elements = [];
    global.document = {
        createElement: tag => {
            const el = { tag, setAttribute() {}, append() {}, remove() { this.removed = true; } };
            elements.push(el); return el;
        }, body: { append() {} },
    };
    return elements;
}

test('staged generation carries previous recap and enables native lorebook activation', async () => {
    const { createSummaryService } = await import('../summary.js');
    const elements = documentStub();
    const calls = [];
    const ctx = () => ({ generateQuietPrompt: async args => { calls.push(args); return `recap ${calls.length}`; } });
    const service = createSummaryService({ ctx, t: x => x });
    const result = await service.generate({ chunks: ['old', 'new'] },
        { summaryPrompt: 'Russian please', summaryLorebooks: true }, { groupId: 'g' }, () => true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].skipWIAN, false);
    assert.ok(calls[1].quietPrompt.includes('recap 1'));
    assert.ok(calls[1].quietPrompt.includes('new'));
    assert.ok(!calls[1].quietPrompt.includes('in English'));
    assert.equal(result.extra.type, 'narrator');
    assert.ok(result.mes.endsWith('recap 2'));
    assert.ok(elements[0].removed);
});

test('failure is not retried, cancellation stops subsequent stages', async () => {
    const { createSummaryService } = await import('../summary.js');
    let calls = 0;
    documentStub();
    let service = createSummaryService({ ctx: () => ({ generateQuietPrompt: async () => { calls++; throw new Error('offline'); } }), t: x => x });
    await assert.rejects(service.generate({ chunks: ['a', 'b'] }, {}, {}, () => true), /offline/);
    assert.equal(calls, 1);
    const elements = documentStub();
    service = createSummaryService({ ctx: () => ({ generateQuietPrompt: async args => {
        assert.equal(args.skipWIAN, true);
        elements.find(x => x.tag === 'button').onclick(); return 'recap';
    } }), t: x => x });
    await assert.rejects(service.generate({ chunks: ['a', 'b'] }, { summaryLorebooks: false }, {}, () => true), /summary.cancelled/);
});
