import { describe, expect, it } from 'vitest';
import { activityEvent, appendEvent } from '../src/shared/activity';
import type { ActionReceipt } from '../src/browser-control';
import type { Run } from '../src/shared/contracts';

const receipt = (patch: Partial<ActionReceipt> = {}): ActionReceipt => ({ action: 'click', target: '[a7] button «Open plans»', mechanism: 'pointer', dispatched: true, reachedTarget: true, effect: { verdict: 'changed', signals: ['DOM changed'] }, ...patch });

describe('readable browser activity', () => {
  it('records the actual destination, including redirects, instead of a bare navigate label', () => {
    const event = activityEvent('navigate', { url: 'https://example.test/start' }, { ok: true, text: 'navigate', data: { url: 'https://example.test/plans' } });
    expect(event.label).toBe('Opened page');
    expect(event.action).toMatchObject({ tool: 'navigate', target: 'https://example.test/start', url: 'https://example.test/plans' });
    expect(activityEvent('navigate', { url: 'https://example.test/plans' }, { ok: true, text: '', data: { url: 'https://example.test/plans' } }).action?.target).toBeUndefined();
  });
  it('uses the browser-resolved control name for a click that the AI specified only by ref', () => {
    const event = activityEvent('click', { target: { ref: 'a7' } }, { ok: true, text: 'click', receipt: receipt({ navigation: { url: 'https://example.test/plans', kind: 'new-document' } }) });
    expect(event.action?.target).toBe('[a7] button «Open plans»');
    expect(event.action?.url).toBe('https://example.test/plans');
    expect(event.status).toBe('ok');
  });
  it('shows actual read-back values and selected option labels without echoing raw input arguments', () => {
    const input = activityEvent('set', { target: { ref: 'a2' }, value: 'raw-secret-must-not-be-logged' }, {
      ok: true, text: '', receipt: receipt({ action: 'set', target: '[a2] textbox «Verification»', mechanism: 'insert-text', postcondition: { status: 'met', detail: 'value is masked' } }),
    });
    expect(input.action?.detail).toBe('value is masked');
    expect(JSON.stringify(input)).not.toContain('raw-secret-must-not-be-logged');
    const select = activityEvent('set', { target: { ref: 'a3' }, value: 'internal-region-id' }, {
      ok: true, text: '', receipt: receipt({ action: 'set', target: '[a3] combobox «Region»', mechanism: 'select-option', postcondition: { status: 'met', detail: 'selected «West»' } }),
    });
    expect(select.label).toBe('Selected option');
    expect(select.action?.detail).toContain('West');
    expect(JSON.stringify(select)).not.toContain('internal-region-id');
  });
  it('distinguishes a refused action, uncertain input and a successful click with no visible change', () => {
    const failed = activityEvent('click', { target: { role: 'button', name: 'Missing button' } }, { ok: false, text: 'no match', error: { code: 'NO_MATCH', message: 'No element matches', delivered: false, hint: 'Observe' } });
    expect(failed).toMatchObject({ label: 'Click failed', status: 'error', action: { target: 'button “Missing button”' } });
    expect(failed.action?.detail).toContain('No input was sent');
    const uncertain = activityEvent('click', {}, { ok: true, text: '', receipt: receipt({ dispatched: 'unknown' }) });
    expect(uncertain.label).toBe('Could not verify click'); expect(uncertain.status).toBe('error');
    const noEffect = activityEvent('click', {}, { ok: true, text: '', receipt: receipt({ effect: { verdict: 'none', signals: [] } }) });
    expect(noEffect.label).toBe('Clicked'); expect(noEffect.action?.detail).toContain('No visible change');
  });
  it('preserves targets and read-back results for the completed fields of a partially failed form', () => {
    const event = activityEvent('fill_form', {}, {
      ok: false, text: '', data: { receipts: [receipt({ action: 'set', target: '[a1] textbox «Name»', postcondition: { status: 'met', detail: 'read back «Tokyo»' } })], failedAt: 1 },
      error: { code: 'NO_MATCH', message: 'Field 2 failed; field 1 was set.', delivered: true, hint: 'Do not repeat' },
    });
    expect(event.status).toBe('error'); expect(event.action?.target).toContain('Name');
    expect(event.action?.detail).toContain('Tokyo'); expect(event.action?.detail).toContain('Some input was sent');
  });
  it('does not turn an invalid URL into a clickable activity link or crash while logging invalid fields', () => {
    expect(activityEvent('navigate', { url: 'javascript:alert(1)' }, { ok: false, text: 'Invalid URL' }).action?.url).toBeUndefined();
    expect(() => activityEvent('fill_form', { fields: [null] }, { ok: false, text: 'Invalid arguments' })).not.toThrow();
  });
  it('bounds stored activity and explicitly marks omitted earlier entries', () => {
    const run: Run = { id: 'run', prompt: '', status: 'completed', tabId: 1, startedAt: '', completed: 0, total: 0, message: '', events: [] };
    for (let i = 0; i < 500; i++) appendEvent(run, activityEvent('read', {}, { ok: true, text: '' }, `https://example.test/${i}/${'あ'.repeat(200)}`));
    expect(run.activityTruncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(run.events)).length).toBeLessThan(100000);
    expect(run.events.at(-1)?.action?.url).toContain('/499/');
  });
});
