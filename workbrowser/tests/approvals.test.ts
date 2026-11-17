import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../src/extension/approvals';
import type { ConfirmRequest } from '../src/browser-control';
import type { PendingApproval } from '../src/shared/contracts';

const request: ConfirmRequest = { id: 'c1', tabId: 1, category: 'submit', action: 'click', target: 'button "Save"', origin: 'https://example.test', site: 'example.test', reason: 'Save submits the form', canRemember: true };
function setup() {
  let pending: PendingApproval | null = null;
  const publish = vi.fn(async (value: PendingApproval | null) => { pending = value; });
  const broker = new ApprovalBroker(publish);
  const abort = new AbortController();
  const authorize = vi.fn(async (): Promise<void> => undefined);
  return { broker, publish, abort, authorize, pending: () => pending };
}

describe('approval lifecycle', () => {
  it('binds one approval to a fresh ID and run, authorizes once, and rejects duplicate/stale answers', async () => {
    const h = setup();
    const result = h.broker.request('run-a', request, h.abort.signal, h.authorize);
    await vi.waitFor(() => expect(h.pending()).not.toBeNull());
    const pending = h.pending()!;
    expect(pending.id).not.toBe(request.id);
    await expect(h.broker.answer(pending.id, 'another-run', 'approve')).rejects.toThrow('no longer active');
    expect(h.authorize).not.toHaveBeenCalled();
    await h.broker.answer(pending.id, 'run-a', 'approve');
    expect(await result).toBe('approve');
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.pending()).toBeNull();
    await expect(h.broker.answer(pending.id, 'run-a', 'approve')).rejects.toThrow('no longer active');
  });
  it('declines without invoking authorization or allowing the action', async () => {
    const h = setup();
    const result = h.broker.request('run-a', request, h.abort.signal, h.authorize);
    await vi.waitFor(() => expect(h.pending()).not.toBeNull());
    await h.broker.answer(h.pending()!.id, 'run-a', 'decline');
    expect(await result).toBe('decline');
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.pending()).toBeNull();
  });
  it('withdraws requests on Stop and prevents a late approval', async () => {
    const h = setup();
    const result = h.broker.request('run-a', request, h.abort.signal, h.authorize).catch(error => error);
    await vi.waitFor(() => expect(h.pending()).not.toBeNull());
    const id = h.pending()!.id;
    h.abort.abort(new Error('Stopped'));
    expect((await result).message).toBe('Stopped');
    expect(h.pending()).toBeNull();
    await expect(h.broker.answer(id, 'run-a', 'approve')).rejects.toThrow('no longer active');
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it('does not complete approval if Stop arrives while the latest settings are being checked', async () => {
    const h = setup();
    let finishCheck!: () => void;
    h.authorize.mockImplementation(() => new Promise<void>(resolve => { finishCheck = resolve; }));
    const result = h.broker.request('run-a', request, h.abort.signal, h.authorize).catch(error => error);
    await vi.waitFor(() => expect(h.pending()).not.toBeNull());
    const answer = h.broker.answer(h.pending()!.id, 'run-a', 'approve').catch(error => error);
    h.abort.abort(new Error('Stopped during approval'));
    finishCheck();
    expect((await result).message).toContain('Stopped');
    expect((await answer).message).toContain('Stopped');
    expect(h.pending()).toBeNull();
  });
  it('cannot remember permission when the site is explicitly Ask', async () => {
    const h = setup();
    const result = h.broker.request('run-a', { ...request, canRemember: false }, h.abort.signal, h.authorize);
    await vi.waitFor(() => expect(h.pending()).not.toBeNull());
    const id = h.pending()!.id;
    await expect(h.broker.answer(id, 'run-a', 'approve-remember')).rejects.toThrow('each action');
    expect(h.authorize).not.toHaveBeenCalled();
    await h.broker.answer(id, 'run-a', 'approve');
    expect(await result).toBe('approve');
  });
  it('rejects an approval when permissions have been revoked and clears the card', async () => {
    const h = setup();
    h.authorize.mockRejectedValue(new Error('Site is now blocked'));
    const result = h.broker.request('run-a', request, h.abort.signal, h.authorize).catch(error => error);
    await vi.waitFor(() => expect(h.pending()).not.toBeNull());
    await expect(h.broker.answer(h.pending()!.id, 'run-a', 'approve')).rejects.toThrow('now blocked');
    expect((await result).message).toContain('now blocked');
    expect(h.pending()).toBeNull();
  });
});
