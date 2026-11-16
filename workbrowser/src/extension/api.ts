import { originOf, type Connection } from '../shared/contracts';

export function localConnection(connection: Connection): Connection {
  const origin = originOf(connection.serverUrl);
  if (!origin || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) throw new Error('This version connects to a local server only.');
  if (connection.serverUrl !== origin) throw new Error('Enter a server origin without a path.');
  return { ...connection, serverUrl: origin };
}
export async function api<T>(connection: Connection, path: string, init: RequestInit = {}): Promise<T> {
  localConnection(connection);
  const response = await fetch(connection.serverUrl + path, {
    ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...init.headers, Authorization: `Bearer ${connection.token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  return body as T;
}
