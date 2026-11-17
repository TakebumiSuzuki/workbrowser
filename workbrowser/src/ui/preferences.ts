export type ExecutionMode = 'agent' | 'mock';

export async function getExecutionMode(): Promise<ExecutionMode> {
  const { executionMode } = await chrome.storage.local.get('executionMode');
  return executionMode === 'mock' ? 'mock' : 'agent';
}

export async function setExecutionMode(mode: ExecutionMode): Promise<void> {
  await chrome.storage.local.set({ executionMode: mode });
}
