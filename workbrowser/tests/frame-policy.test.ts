import { expect, it } from 'vitest';
import { captureTier1 } from '../src/browser-control/core/perception/capture';
import type { CdpPort, TopologyPort } from '../src/browser-control/core/ports';
import { Session, type Controller } from '../src/browser-control/core/controller';
import { LayerError } from '../src/browser-control/protocol/errors';

it('does not observe a frame excluded by the administrator origin policy', async () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const cdp = {
    async send(_session: string | undefined, method: string, args: Record<string, unknown> = {}) {
      calls.push({ method, args });
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'DOMSnapshot.captureSnapshot') return { documents: [], strings: [] };
      if (method === 'Page.getLayoutMetrics') throw new Error('not needed');
      return {};
    },
  } as unknown as CdpPort;
  const topology = {
    async frames() { return [
      { frameId: 'main', parentFrameId: null, sessionId: undefined, loaderId: 'a', url: 'https://allowed.test', depth: 0 },
      { frameId: 'secret', parentFrameId: 'main', sessionId: 'child', loaderId: 'b', url: 'https://excluded.test', depth: 1 },
    ]; },
  } as unknown as TopologyPort;
  const capture = await captureTier1(1, cdp, topology, { enabledSessions: new Set(), allowFrame: url => new URL(url).origin === 'https://allowed.test' });
  expect(capture.frames[0].status).toBe('captured');
  expect(capture.frames[1]).toMatchObject({ status: 'skipped', nodes: [], reason: 'origin excluded by administrator policy' });
  expect(calls.filter(c => c.method === 'Accessibility.getFullAXTree').map(c => c.args.frameId)).toEqual(['main']);
});

function bootstrapSession() {
  let url = 'about:blank', attachments = 0, loads = 0;
  const state = { tabId: 1, rev: 0, actionSeq: 0, pending: [], secrets: new Set<string>() };
  const controller = {
    host: { tabs: {
      get: async () => ({ url, title: 'Destination' }),
      load: async (_id: number, target: string) => { url = target; loads++; },
    } },
    tabState: () => state, held: () => undefined, syncPolicies: async () => undefined,
    allowedFor: () => (target: string) => target.startsWith('https://allowed.test/'),
    locks: { run: async (_id: number, run: () => unknown) => run() }, audit: () => undefined,
    attach: async () => {
      attachments++;
      if (url === 'about:blank') throw new LayerError('PAGE_NOT_SUPPORTED', 'Blank page');
      return { cdp: { send: async () => ({}) } };
    },
  } as unknown as Controller;
  const session = new Session(controller, 'bootstrap', { urlPolicy: { allow: ['https://allowed.test'], deny: [] } });
  session.shareTab(1);
  return { session, attachments: () => attachments, loads: () => loads };
}

it('allows explicit navigation out of a blank page after checking the destination', async () => {
  const h = bootstrapSession();
  const result = await h.session.call('navigate', { url: 'https://allowed.test/reports' });
  expect(result.ok).toBe(true);
  expect(result.page?.url).toBe('https://allowed.test/reports');
  expect(h.loads()).toBe(1);
  expect(h.attachments()).toBe(2);
});

it.each([
  ['snapshot', {}], ['read', {}], ['navigate', { action: 'back' }], ['navigate', { url: 'https://blocked.test/' }],
])('never observes or acts on a blank/unapproved page through %s', async (tool, args) => {
  const h = bootstrapSession();
  const result = await h.session.call(tool as string, args);
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe('URL_NOT_ALLOWED');
  expect(h.loads()).toBe(0);
  expect(h.attachments()).toBe(0);
});

it('invalidates cached page data immediately when a policy changes', async () => {
  const { Session } = await import('../src/browser-control/core/controller');
  const state = { detachedByUser: false, last: { observation: { secret: true } } };
  const controller = {
    host: { tabs: { get: async () => ({ url: 'https://allowed.test' }) } },
    tabState: () => state,
    held: () => undefined,
    syncPolicies: async () => undefined,
  } as unknown as import('../src/browser-control/core/controller').Controller;
  const session = new Session(controller, 'test', { urlPolicy: { allow: ['https://allowed.test', 'https://child.test'], deny: [] } });
  await session.share(1);
  await session.setUrlPolicy({ allow: ['https://allowed.test'], deny: [] });
  expect(state.last).toBeUndefined();
});
