import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_POLICY, PolicySchema, type Policy } from '../src/shared/contracts';

/** Single-process local store. A shared durable store is required before a Cloud Run release. */
export class PolicyStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  async read(): Promise<Policy> {
    try { return PolicySchema.parse(JSON.parse(await readFile(join(this.directory, 'policy.json'), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_POLICY); throw e; }
  }
  save(policy: Policy): Promise<Policy> {
    const task = this.queue.then(async () => {
      const current = await this.read();
      if (current.revision !== policy.revision) throw new Error('CONFLICT');
      const next = PolicySchema.parse({ ...policy, revision: current.revision + 1 });
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `policy-${crypto.randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, join(this.directory, 'policy.json'));
      return next;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
