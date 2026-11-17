import type { Run } from './contracts';
import type { ConversationTurn } from './agent';

export const conversationIdOf = (run: Run): string => run.conversationId ?? run.id;

export function conversationTurns(history: Run[], conversationId: string): ConversationTurn[] {
  return history.filter(run => conversationIdOf(run) === conversationId && run.mode !== 'mock' && run.status !== 'running')
    .slice(0, 20).reverse().map(run => ({
      prompt: run.prompt, answer: run.output ?? run.message, notes: run.notes ?? '',
      activity: run.trace ?? run.events.map(event => `${event.status}: ${event.label}`).join('\n').slice(0, 24000),
      sources: run.sources ?? [], status: run.status as ConversationTurn['status'],
    }));
}

/** Keep the first evidence and the latest actions, and make any truncation explicit. Images are never archived. */
export function appendTrace(previous: string | undefined, tool: string, args: Record<string, unknown>, result: { ok: boolean; text: string }): string {
  const clip = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, limit) + ' [truncated]';
  const entry = `${tool} ${clip(JSON.stringify(args), 2000)}\n${result.ok ? 'OK' : 'ERROR'}: ${clip(result.text, 6000)}\n`;
  const trace = (previous ?? '') + entry;
  return trace.length <= 24000 ? trace : trace.slice(0, 8000) + '\n[Earlier activity truncated; latest actions follow.]\n' + trace.slice(-15900);
}
