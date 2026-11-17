import { defineBackground } from 'wxt/utils/define-background';
import { z } from 'zod';
import { answerApproval, begin, ready, stop } from '../src/extension/runner';
import { api, localConnection } from '../src/extension/api';
import { connection, openConversation, state } from '../src/extension/storage';
import { PolicySchema } from '../src/shared/contracts';

const MessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('answer-approval'), id: z.string().uuid(), runId: z.string().uuid(), answer: z.enum(['approve', 'approve-remember', 'decline']) }),
  z.strictObject({ type: z.literal('connect'), serverUrl: z.string(), token: z.string().max(1000) }),
  z.strictObject({ type: z.literal('identity') }),
  z.strictObject({ type: z.literal('agent-info') }),
  z.strictObject({ type: z.literal('test-model') }),
  z.strictObject({ type: z.literal('policy') }),
  z.strictObject({ type: z.literal('save-policy'), policy: PolicySchema }),
  z.strictObject({ type: z.literal('start'), prompt: z.string().trim().min(1).max(8000), tabId: z.number().int().positive(), mode: z.enum(['agent', 'mock']).default('agent') }),
  z.strictObject({ type: z.literal('clear-history') }),
  z.strictObject({ type: z.literal('open-conversation'), id: z.string().min(1).max(100).optional() }),
]);
export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.runtime.onInstalled.addListener(() => { void chrome.runtime.openOptionsPage(); });
  chrome.runtime.onMessage.addListener((raw, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
    void (async () => {
      await ready;
      const message = MessageSchema.parse(raw);
      switch (message.type) {
        case 'state': return state();
        case 'stop': await stop(); return null;
        case 'answer-approval': await answerApproval(message.id, message.runId, message.answer); return null;
        case 'identity': return api(await connection(), '/api/me');
        case 'agent-info': return api(await connection(), '/api/agent/info');
        case 'test-model': {
          const heartbeat = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20000);
          try { return await api(await connection(), '/api/agent/test', { method: 'POST', signal: AbortSignal.timeout(100000) }); }
          finally { clearInterval(heartbeat); }
        }
        case 'policy': return api(await connection(), '/api/policy');
        case 'save-policy': return api(await connection(), '/api/policy', { method: 'PUT', body: JSON.stringify(message.policy) });
        case 'connect': {
          const value = localConnection({ serverUrl: message.serverUrl, token: message.token });
          const identity = await api(value, '/api/me');
          if ((await state()).run?.status === 'running') throw new Error('Wait until the task finishes before changing the connection.');
          await chrome.storage.local.set({ connection: value });
          return identity;
        }
        case 'start': await begin(message.prompt, message.tabId, message.mode); return null;
        case 'open-conversation': await openConversation(message.id); return null;
        case 'clear-history':
          if ((await state()).run?.status === 'running') throw new Error('Stop the task before deleting its history.');
          await chrome.storage.local.remove(['run', 'history', 'conversationId']); return null;
      }
    })().then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error instanceof Error ? error.message : '処理に失敗しました。' }));
    return true;
  });
});
