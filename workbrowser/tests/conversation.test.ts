import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTrace, conversationIdOf, conversationTurns } from '../src/shared/conversation';
import { openConversation, saveRun, finishRun, state } from '../src/extension/storage';
import type { Run } from '../src/shared/contracts';

const run = (id: string, conversationId = 'chat-a'): Run => ({ id, conversationId, prompt: `Question ${id}`, output: `Answer ${id}`, status: 'completed', tabId: 1, startedAt: '2026-11-17T00:00:00Z', completed: 1, total: 1, message: 'Done', events: [], mode: 'agent', sources: ['https://example.test/'] });
let saved: Record<string, unknown>;
beforeEach(() => {
  saved = {};
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, saved[key]]))),
    set: vi.fn(async (value: object) => { Object.assign(saved, value); }),
  } } });
});

describe('persisted conversation context', () => {
  it('restores a conversation across reloads, opens historical conversations and starts fresh without erasing history', async () => {
    await saveRun(run('first')); await finishRun(run('first'));
    await saveRun(run('second')); await finishRun(run('second'));
    expect((await state()).conversationId).toBe('chat-a');
    expect(conversationTurns((await state()).history, 'chat-a').map(turn => turn.prompt)).toEqual(['Question first', 'Question second']);
    await openConversation();
    const fresh = await state();
    expect(fresh.run).toBeNull(); expect(fresh.conversationId).not.toBe('chat-a'); expect(fresh.history).toHaveLength(2);
    await openConversation('chat-a');
    expect((await state()).run?.id).toBe('second');
  });
  it('keeps conversations separate, supports legacy history and refuses switching during a run', async () => {
    const legacy = { ...run('legacy'), conversationId: undefined };
    expect(conversationIdOf(legacy)).toBe('legacy');
    const history = [run('other', 'chat-b'), run('latest'), run('oldest'), legacy];
    expect(conversationTurns(history, 'chat-a').map(turn => turn.prompt)).toEqual(['Question oldest', 'Question latest']);
    await saveRun({ ...run('active'), status: 'running' });
    await expect(openConversation()).rejects.toThrow('Stop');
  });
  it('retains failed operation evidence for reflection and marks truncation without saving images', () => {
    const trace = appendTrace(undefined, 'click', { target: { ref: 'e4' } }, { ok: false, text: 'NO_MATCH: expected Search' });
    expect(conversationTurns([{ ...run('failed'), status: 'failed', trace }], 'chat-a')[0].activity).toContain('NO_MATCH');
    const long = appendTrace(trace.repeat(1000), 'read', {}, { ok: true, text: 'latest result' });
    expect(long.length).toBeLessThanOrEqual(24000); expect(long).toContain('truncated'); expect(long).toContain('latest result');
  });
});
