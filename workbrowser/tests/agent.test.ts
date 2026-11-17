import { describe, expect, it, vi } from 'vitest';
import { runAgent, trimContext, type AgentPorts } from '../src/agent/loop';
import { agentTools, validateCall } from '../src/agent/tools';
import type { AgentCall, AgentImage, AgentRequest, AgentTurn, ConversationTurn } from '../src/shared/agent';
import type { Result } from '../src/browser-control';

function turn(name: AgentCall['name'], args: Record<string, unknown> = {}): AgentTurn {
  return { content: { role: 'model', parts: [{ functionCall: { name, args, id: `call-${name}` }, thoughtSignature: 'opaque-signature' }] } };
}
function harness(responses: AgentTurn[], options: { url?: string; canObserve?: boolean; maxSteps?: number } = {}) {
  let index = 0, url = options.url ?? 'https://example.test/';
  const contexts: AgentRequest[] = [];
  const abort = new AbortController();
  const call = vi.fn(async (tool: string, args: Record<string, unknown>): Promise<Result> => {
    if (tool === 'navigate') url = args.url as string;
    return { ok: true, text: `Observed ${url}: Revenue: 42 million. link [e1] Details`, data: { content: 'Revenue: 42 million.' } };
  });
  const ports: AgentPorts = {
    signal: abort.signal,
    checkpoint: vi.fn(async () => ({ url, maxSteps: options.maxSteps ?? 30, canObserve: options.canObserve ?? true })),
    model: vi.fn(async context => { contexts.push(context); return responses[index++]; }),
    call, progress: vi.fn(async () => undefined), capture: vi.fn(async () => undefined),
  };
  return { ports, contexts, call, abort };
}
const answer = (text: string) => turn('done', { outcome: 'success', answer: text });

describe('autonomous observe/action/result loop', () => {
  it.each([
    ['Summarize this page.', 'Revenue is 42 million.'],
    ['このページの売上を要約して。', '売上は4,200万です。'],
    ['Résume cette page.', 'Le chiffre d’affaires est de 42 millions.'],
    ['Resume esta página.', 'Los ingresos son de 42 millones.'],
  ])('passes multilingual instructions and returns the model answer: %s', async (prompt, output) => {
    const h = harness([turn('read'), answer(output)]);
    const result = await runAgent(prompt, h.ports);
    expect(h.contexts[0].prompt).toBe(prompt);
    expect(h.contexts[0].initial?.text).toContain('Revenue: 42');
    expect(h.contexts[1].history[0].results[0].text).toContain('Revenue: 42');
    expect(result.answer).toBe(output);
    expect(result.sources).toEqual(['https://example.test/']);
    expect(h.call.mock.calls.map(c => c[0])).toEqual(['snapshot', 'read']);
  });
  it('navigates, observes linked pages, preserves notes and synthesizes the collected result', async () => {
    const h = harness([
      turn('navigate', { url: 'https://example.test/reports' }), turn('read'),
      turn('remember', { notes: 'Report: revenue 42 million. Source https://example.test/reports' }),
      turn('click', { target: { role: 'link', name: 'Details' } }), turn('read'),
      answer('Revenue: 42 million. Source https://example.test/reports'),
    ]);
    const result = await runAgent('Visit the reports page, follow details, and compare figures.', h.ports);
    expect(h.call.mock.calls.map(c => c[0])).toEqual(['snapshot', 'navigate', 'read', 'click', 'read']);
    expect(h.contexts[3].notes).toContain('42 million');
    expect(h.contexts[1].history[0].model.parts[0].thoughtSignature).toBe('opaque-signature');
    expect(result.outcome).toBe('success');
  });
  it('can start from a new-tab page without observing it', async () => {
    const h = harness([turn('navigate', { url: 'https://example.test/' }), answer('Observed the site.')], { url: 'chrome://newtab/', canObserve: false });
    // The newly navigated page is approved after the first call.
    h.ports.checkpoint = vi.fn(async () => ({ url: h.call.mock.calls.length ? 'https://example.test/' : 'chrome://newtab/', maxSteps: 10, canObserve: h.call.mock.calls.length > 0 }));
    expect((await runAgent('Go to https://example.test/', h.ports)).outcome).toBe('success');
    expect(h.call.mock.calls[0][0]).toBe('navigate');
    expect(h.contexts[0].initial).toBeUndefined();
  });
  it('feeds safe pre-dispatch failures back so the model can observe and recover', async () => {
    const h = harness([turn('click', { target: { ref: 'old' } }), turn('snapshot'), turn('click', { target: { ref: 'e1' } }), answer('Found it.')]);
    h.call.mockImplementationOnce(async () => ({ ok: true, text: 'initial' }));
    h.call.mockImplementationOnce(async () => ({ ok: false, text: 'STALE_DOCUMENT', error: { code: 'STALE_DOCUMENT', message: 'stale', delivered: false, hint: 'snapshot' } }));
    expect((await runAgent('Find details.', h.ports)).outcome).toBe('success');
    expect(h.contexts[1].history[0].results[0]).toMatchObject({ ok: false, text: 'STALE_DOCUMENT' });
  });
  it('does not dispatch another action after uncertain delivery', async () => {
    const h = harness([turn('click', { target: { ref: 'e1' } }), turn('click', { target: { ref: 'e1' } })]);
    h.call.mockImplementationOnce(async () => ({ ok: true, text: 'initial' }));
    h.call.mockImplementationOnce(async () => ({ ok: false, text: 'timeout', error: { code: 'TIMEOUT', message: 'timeout', delivered: 'unknown', hint: 'check' } }));
    await expect(runAgent('Find details.', h.ports)).rejects.toThrow('avoid repeating');
    expect(h.ports.model).toHaveBeenCalledTimes(1);
  });
  it('matches skipped parallel calls without executing them after a navigation', async () => {
    const first = turn('navigate', { url: 'https://example.test/other' });
    first.content.parts.push({ functionCall: { name: 'click', args: { target: { ref: 'old' } }, id: 'skip-id' } });
    const h = harness([first, answer('Done.')]);
    await runAgent('Research.', h.ports);
    expect(h.call.mock.calls.map(c => c[0])).toEqual(['snapshot', 'navigate']);
    expect(h.contexts[1].history[0].results[1]).toMatchObject({ name: 'click', id: 'skip-id', ok: false });
  });
  it('reserves a final answer at the limit and reports partial coverage', async () => {
    const h = harness([turn('read'), answer('One page was collected.')], { maxSteps: 2 });
    const result = await runAgent('Read every page.', h.ports);
    expect(h.contexts[1].finishOnly).toBe(true);
    expect(result.outcome).toBe('partial');
  });
  it('stops repeated no-effect operations and requests a partial answer', async () => {
    const h = harness([...Array.from({ length: 6 }, () => turn('click', { target: { ref: 'e1' } })), answer('No further progress.')]);
    h.call.mockImplementation(async tool => tool === 'snapshot' ? { ok: true, text: 'button [e1]' } : {
      ok: true, text: 'No effect', receipt: { action: 'click', dispatched: true, mechanism: 'pointer', effect: { verdict: 'none', signals: [] } },
    });
    const result = await runAgent('Find details.', h.ports);
    expect(result.outcome).toBe('partial');
    expect(h.ports.model).toHaveBeenCalledTimes(5);
  });
  it('aborts while a model call is pending without dispatching the returned action', async () => {
    const h = harness([]);
    h.ports.model = async () => { h.abort.abort(); return turn('click', { target: { ref: 'e1' } }); };
    await expect(runAgent('Read details.', h.ports)).rejects.toThrow();
    expect(h.call.mock.calls.map(c => c[0])).toEqual(['snapshot']);
  });
  it('rechecks policy after a model call before dispatch', async () => {
    const h = harness([turn('click', { target: { ref: 'e1' } })]);
    const original = h.ports.checkpoint;
    let checks = 0;
    h.ports.checkpoint = async sources => { if (++checks > 1) throw new Error('Revoked'); return original(sources); };
    await expect(runAgent('Read details.', h.ports)).rejects.toThrow('Revoked');
    expect(h.call.mock.calls.map(c => c[0])).toEqual(['snapshot']);
  });
  it('returns manual-step partial results in the requested language without another browser action', async () => {
    const h = harness([turn('click', { target: { ref: 'e1' } }), answer('ログインが必要です。先に取得できた情報を示します。')]);
    h.call.mockImplementationOnce(async () => ({ ok: true, text: 'initial' }));
    h.call.mockImplementationOnce(async () => ({ ok: false, text: 'Sign-in required', error: { code: 'USER_STEP', message: 'Sign-in required', delivered: false, hint: 'manual' } }));
    const result = await runAgent('このサイトを調べて。', h.ports);
    expect(result.outcome).toBe('partial');
    expect(result.answer).toContain('ログイン');
    expect(h.contexts[1].finishOnly).toBe(true);
    expect(h.call.mock.calls.map(c => c[0])).toEqual(['snapshot', 'click']);
  });
});

describe('tool and context boundaries', () => {
  it('offers labelled viewport screenshots while keeping tab selection, scripts, coordinates and selectors unavailable', () => {
    const definitions = agentTools();
    const names = definitions.map(t => t.name);
    expect(names).toContain('done'); expect(names).toContain('remember');
    expect(names).toContain('screenshot');
    for (const name of ['evaluate', 'tabs', 'upload', 'devtools']) expect(names).not.toContain(name);
    for (const definition of definitions) {
      const schema = JSON.stringify(definition.parametersJsonSchema);
      expect(schema).not.toContain('"tabId"');
      expect(schema).not.toContain('"selector"');
      expect(schema).not.toContain('"x"');
    }
    expect(() => validateCall({ name: 'click', args: { target: { ref: 'e1' }, tabId: 99 } })).toThrow();
    expect(() => validateCall({ name: 'click', args: { target: { selector: '#secret' } } })).toThrow();
    expect(() => validateCall({ name: 'press', args: { keys: 'Enter' } })).toThrow();
    expect(validateCall({ name: 'screenshot', args: {} })).toMatchObject({ labels: true, fullPage: false });
    expect(() => validateCall({ name: 'screenshot', args: { labels: false } })).toThrow();
    expect(() => validateCall({ name: 'screenshot', args: { fullPage: true } })).toThrow();
  });
  it('preserves the prompt, working notes, recent evidence and opaque signatures during elision', () => {
    const context: AgentRequest = { prompt: 'Keep this full instruction.', currentUrl: 'https://example.test/', sources: [], notes: 'Revenue 42, source https://example.test/', finishOnly: false,
      history: Array.from({ length: 20 }, () => ({ model: turn('read').content, results: [{ name: 'read', ok: true, text: 'x'.repeat(16000), url: 'https://example.test/' }] })),
    };
    trimContext(context);
    expect(context.prompt).toBe('Keep this full instruction.');
    expect(context.notes).toContain('Revenue 42');
    expect(context.history[0].results[0].text).toContain('elided');
    expect(context.history.at(-1)?.results[0].text).toHaveLength(16000);
    expect(context.history[0].model.parts[0].thoughtSignature).toBe('opaque-signature');
  });
});

describe('continuing conversations and visual fallback', () => {
  const previous: ConversationTurn = { prompt: 'Compare plans.', answer: 'Plan A costs 42.', notes: 'Check the monthly units next time.', activity: 'click {"target":{"ref":"e1"}}\nERROR: NO_MATCH', sources: ['https://example.test/plans'], status: 'completed' };
  const image: AgentImage = { mimeType: 'image/png', base64: 'aW1hZ2U=', width: 800, height: 600 };
  it('answers a follow-up from prior instructions, answers, corrections and activity even when the current page is unavailable', async () => {
    const h = harness([answer('The earlier click used the wrong target. Check monthly units.')], { canObserve: false, url: 'chrome://newtab/' });
    const result = await runAgent('Where did the previous task go wrong?', h.ports, [previous]);
    expect(result.outcome).toBe('success');
    expect(h.contexts[0].conversation).toEqual([previous]);
    expect(h.ports.checkpoint).toHaveBeenCalledWith(previous.sources);
    expect(h.call).not.toHaveBeenCalled();
  });
  it('checks historical source permissions before sending a follow-up', async () => {
    const h = harness([answer('Answer')]);
    h.ports.checkpoint = async sources => { expect(sources).toContain(previous.sources[0]); throw new Error('Historical source revoked'); };
    await expect(runAgent('Continue.', h.ports, [previous])).rejects.toThrow('revoked');
    expect(h.ports.model).not.toHaveBeenCalled();
  });
  it('automatically sends a labelled image after a safe DOM target failure and then executes the selected ref', async () => {
    const h = harness([turn('click', { target: { role: 'button', name: 'Search' } }), turn('click', { target: { ref: 'e7' } }), answer('Opened search.')]);
    let clicks = 0;
    h.call.mockImplementation(async tool => {
      if (tool === 'screenshot') return { ok: true, text: 'screenshot with ref e7', data: image };
      if (tool === 'click' && ++clicks === 1) return { ok: false, text: 'NO_MATCH', error: { code: 'NO_MATCH', message: 'No button name', delivered: false, hint: 'Observe' } };
      return { ok: true, text: 'Observed current page.' };
    });
    await runAgent('Click the search icon.', h.ports);
    expect(h.call.mock.calls.map(call => call[0])).toEqual(['snapshot', 'click', 'screenshot', 'click']);
    expect(h.call.mock.calls[2][1]).toMatchObject({ labels: true, fullPage: false });
    expect(h.contexts[1].history[0].results[0]).toMatchObject({ image, url: 'https://example.test/', ok: false });
    expect(h.contexts[2].history[0].results[0].image).toBeUndefined();
  });
  it('lets the model request an image after DOM observation and retains only the latest image', async () => {
    const h = harness([turn('screenshot'), turn('screenshot'), answer('The right icon is e7.')]);
    h.call.mockImplementation(async tool => ({ ok: true, text: tool, ...(tool === 'screenshot' ? { data: image } : {}) }));
    await runAgent('Identify this icon.', h.ports);
    expect(h.contexts[1].history[0].results[0].image).toEqual(image);
    expect(h.contexts[2].history[0].results[0].image).toBeUndefined();
    expect(h.contexts[2].history[1].results[0].image).toEqual(image);
  });
  it('does not use image fallback to bypass a protected operation or repeat uncertain input', async () => {
    for (const code of ['NEEDS_USER', 'USER_STEP', 'WRITE_BLOCKED', 'CONFIRMATION_TIMEOUT', 'TIMEOUT'] as const) {
      const h = harness([turn('click', { target: { ref: 'e1' } }), answer('Manual step required.')]);
      h.call.mockImplementation(async tool => tool === 'snapshot' ? { ok: true, text: 'initial' } : { ok: false, text: code, error: { code, message: code, delivered: code === 'TIMEOUT' ? 'unknown' : false, hint: 'manual' } });
      if (code === 'TIMEOUT') await expect(runAgent('Open it.', h.ports)).rejects.toThrow('avoid repeating');
      else expect((await runAgent('Open it.', h.ports)).outcome).toBe('partial');
      expect(h.call.mock.calls.map(call => call[0])).not.toContain('screenshot');
    }
  });
  it('answers general questions without requiring a browser observation', async () => {
    const h = harness([answer('A DOM is the document structure.')], { canObserve: false, url: 'chrome://newtab/' });
    expect((await runAgent('DOMとは何？', h.ports)).outcome).toBe('success');
    expect(h.call).not.toHaveBeenCalled();
  });
  it('does not observe the page again merely to explain earlier work', async () => {
    const h = harness([answer('The earlier target did not match.')]);
    await runAgent('Explain the previous mistake.', h.ports, [previous]);
    expect(h.call).not.toHaveBeenCalled();
    expect(h.contexts[0].initial).toBeUndefined();
  });
});
