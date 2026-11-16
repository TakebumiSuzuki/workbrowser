import { DEFAULT_CONNECTION, type AppState, type Connection, type Run } from '../shared/contracts';

export async function connection(): Promise<Connection> {
  return { ...DEFAULT_CONNECTION, ...(await chrome.storage.local.get<{ connection?: Partial<Connection> }>('connection')).connection };
}
export async function state(): Promise<AppState> {
  const value = await chrome.storage.local.get<{ run?: Run; history?: Run[] }>(['run', 'history']);
  return { connection: await connection(), run: value.run ?? null, history: value.history ?? [] };
}
export async function saveRun(run: Run): Promise<void> { await chrome.storage.local.set({ run }); }
export async function finishRun(run: Run): Promise<void> {
  const old = (await state()).history;
  await chrome.storage.local.set({ run, history: [run, ...old.filter(r => r.id !== run.id)].slice(0, 20) });
}
