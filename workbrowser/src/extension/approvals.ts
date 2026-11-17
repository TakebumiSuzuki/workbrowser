import type { ConfirmAnswer, ConfirmRequest } from '../browser-control';
import type { PendingApproval } from '../shared/contracts';

interface Waiting {
  request: PendingApproval;
  signal: AbortSignal;
  resolve(answer: ConfirmAnswer): void;
  reject(error: unknown): void;
  authorize(answer: ConfirmAnswer): Promise<void>;
  abort(): void;
  answering: boolean;
}

/** Only the extension UI can answer. Persisted metadata never authorizes an action after a worker restart. */
export class ApprovalBroker {
  private waiting?: Waiting;
  private publications: Promise<void> = Promise.resolve();
  constructor(private publish: (request: PendingApproval | null) => Promise<void>) {}

  request(runId: string, request: ConfirmRequest, signal: AbortSignal, authorize: Waiting['authorize']): Promise<ConfirmAnswer> {
    signal.throwIfAborted();
    if (this.waiting) throw new Error('Another action is already awaiting approval.');
    return new Promise<ConfirmAnswer>((resolve, reject) => {
      const waiting: Waiting = {
        request: { ...request, id: crypto.randomUUID(), runId, requestedAt: new Date().toISOString() }, signal,
        resolve, reject, authorize, answering: false,
        abort: () => { void this.finish(waiting, undefined, signal.reason ?? new DOMException('Approval cancelled.', 'AbortError')); },
      };
      this.waiting = waiting;
      signal.addEventListener('abort', waiting.abort, { once: true });
      void this.publishNext(waiting.request).catch(error => this.finish(waiting, undefined, error));
    });
  }

  async answer(id: string, runId: string, answer: ConfirmAnswer): Promise<void> {
    const waiting = this.waiting;
    if (!waiting || waiting.request.id !== id || waiting.request.runId !== runId || waiting.signal.aborted) throw new Error('This approval request is no longer active.');
    if (waiting.answering) throw new Error('An answer is already being processed.');
    if (answer === 'approve-remember' && !waiting.request.canRemember) throw new Error('This site requires approval for each action.');
    waiting.answering = true;
    try {
      if (answer !== 'decline') await waiting.authorize(answer);
      waiting.signal.throwIfAborted();
      if (this.waiting !== waiting) throw new Error('This approval request is no longer active.');
      await this.finish(waiting, answer);
    } catch (error) {
      await this.finish(waiting, undefined, error);
      throw error;
    }
  }

  private publishNext(request: PendingApproval | null): Promise<void> {
    const next = this.publications.then(() => this.publish(request));
    this.publications = next.catch(() => undefined);
    return next;
  }

  private async finish(waiting: Waiting, answer?: ConfirmAnswer, error?: unknown): Promise<void> {
    if (this.waiting !== waiting) return;
    this.waiting = undefined;
    waiting.signal.removeEventListener('abort', waiting.abort);
    try { await this.publishNext(null); }
    catch (publishError) { waiting.reject(error ?? publishError); return; }
    if (answer) waiting.resolve(answer); else waiting.reject(error);
  }
}
