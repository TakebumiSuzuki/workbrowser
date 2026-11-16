import { z } from 'zod';

export function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}
export const OriginSchema = z.string().max(300).refine(v => originOf(v) === v, 'https://example.com の形式で入力してください（パスなし）');
export const PolicySchema = z.strictObject({
  revision: z.number().int().min(0),
  allowedOrigins: z.array(OriginSchema).max(200),
  // Model access is explicit and is never widened by a browsing override.
  modelOrigins: z.array(OriginSchema).max(200).default([]),
  overrides: z.array(z.strictObject({
    user: z.string().email(),
    expiresAt: z.string().datetime(),
  })).max(200),
  maxSteps: z.number().int().min(1).max(500),
  maxMinutes: z.number().int().min(1).max(60),
});
export type Policy = z.infer<typeof PolicySchema>;
export const DEFAULT_POLICY: Policy = {
  revision: 0,
  allowedOrigins: ['http://localhost:8787', 'http://127.0.0.1:8787'],
  modelOrigins: [], overrides: [], maxSteps: 250, maxMinutes: 30,
};
export function unrestricted(policy: Policy, email: string, now = Date.now()): boolean {
  return policy.overrides.some(o => o.user.toLowerCase() === email.toLowerCase() && Date.parse(o.expiresAt) > now);
}
export function urlAllowed(policy: Policy, email: string, url: string): boolean {
  const origin = originOf(url);
  return !!origin && (unrestricted(policy, email) || policy.allowedOrigins.includes(origin));
}
export function modelAllowed(policy: Policy, email: string, url: string): boolean {
  const origin = originOf(url);
  return !!origin && urlAllowed(policy, email, url) && policy.modelOrigins.includes(origin);
}
export const SAFE_TOOLS = ['snapshot', 'read', 'find', 'click', 'set', 'fill_form', 'type', 'press', 'hover', 'scroll', 'wait', 'navigate'] as const;
export const StepSchema = z.strictObject({
  tool: z.enum(SAFE_TOOLS),
  args: z.record(z.string(), z.unknown()),
  label: z.string().max(200),
});
export const PlanRequestSchema = z.strictObject({ prompt: z.string().trim().min(1).max(8000), url: z.string().max(2000) });
export const PlanSchema = z.strictObject({ mode: z.literal('mock'), message: z.string(), steps: z.array(StepSchema).max(500) });
export type Plan = z.infer<typeof PlanSchema>;
export interface Identity { email: string; admin: boolean; mode: 'local' | 'iap' }
export interface Connection { serverUrl: string; token: string }
export const DEFAULT_CONNECTION: Connection = { serverUrl: 'http://localhost:8787', token: '' };
export interface Event { at: string; label: string; status: 'ok' | 'error' | 'info' }
export interface Run {
  id: string; prompt: string; status: 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
  tabId: number; startedAt: string; completed: number; total: number; message: string;
  events: Event[]; output?: string;
  mode?: 'agent' | 'mock'; outcome?: 'success' | 'partial' | 'failed';
  sources?: string[]; notes?: string; extracted?: string;
}
export interface AppState { connection: Connection; run: Run | null; history: Run[] }
