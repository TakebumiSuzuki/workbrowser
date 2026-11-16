import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createModel } from '../server/model';
import { DoneSchema } from '../src/shared/agent';

if (existsSync('.env')) loadEnvFile('.env');
try {
  const model = createModel();
  const result = await model.turn({ prompt: 'Connection test only. Call done with outcome success and answer "Connection successful". No browser access.', currentUrl: '', notes: '', sources: [], history: [], finishOnly: true }, AbortSignal.timeout(90000));
  const call = result.content.parts.find(part => part.functionCall?.name === 'done')?.functionCall;
  if (!call || DoneSchema.parse(call.args).outcome !== 'success') throw new Error('The model did not complete the function-calling check.');
  console.info(`PASS: ${model.info.provider} / ${model.info.model} — authentication and function calling verified.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'AI connection failed.');
  process.exitCode = 1;
}
