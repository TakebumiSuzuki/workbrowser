export async function send<T>(message: unknown): Promise<T> {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error ?? 'バックグラウンドに接続できません。拡張を再読み込みしてください。');
  return result.data as T;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '処理に失敗しました。'; }
