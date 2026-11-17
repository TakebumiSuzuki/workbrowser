import { DEFAULT_CONNECTION, type AppState, type Connection, type PendingApproval, type Run } from '../shared/contracts';
import { conversationIdOf } from '../shared/conversation';

export async function connection(): Promise<Connection> {
  return { ...DEFAULT_CONNECTION, ...(await chrome.storage.local.get<{ connection?: Partial<Connection> }>('connection')).connection };
}
export async function state(): Promise<AppState> {
  const value = await chrome.storage.local.get<{ run?: Run | null; history?: Run[]; conversationId?: string; pendingApproval?: PendingApproval }>(['run', 'history', 'conversationId', 'pendingApproval']);
  return { connection: await connection(), run: value.run ?? null, history: value.history ?? [], conversationId: value.conversationId ?? (value.run ? conversationIdOf(value.run) : null), pendingApproval: value.pendingApproval ?? null };
}
export async function saveRun(run: Run): Promise<void> { await chrome.storage.local.set({ run, conversationId: conversationIdOf(run) }); }
export async function finishRun(run: Run): Promise<void> {
  const old = (await state()).history;
  await chrome.storage.local.set({ run, history: [run, ...old.filter(r => r.id !== run.id)].slice(0, 20) });
}
export async function openConversation(id?: string): Promise<void> {
  const current = await state();
  if (current.run?.status === 'running') throw new Error('Stop the task before switching conversations.');
  const run = id ? current.history.find(item => conversationIdOf(item) === id) : undefined;
  if (id && !run) throw new Error('This conversation is no longer in local history.');
  await chrome.storage.local.set({ run: run ?? null, conversationId: id ?? crypto.randomUUID() });
}
