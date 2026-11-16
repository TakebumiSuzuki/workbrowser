import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicySchema, PlanSchema, unrestricted, urlAllowed } from '../src/shared/contracts';
import { isUrlAllowed, combinePolicies } from '../src/browser-control/core/url-policy';
import { mockPlan } from '../server/planner';
import { localConnection } from '../src/extension/api';

describe('origin restrictions', () => {
  const policy = { ...DEFAULT_POLICY, allowedOrigins: ['https://crm.example.com'] };
  it.each(['https://crm.example.com/customers', 'https://crm.example.com:443/path'])('allows exact origin %s', url => {
    expect(urlAllowed(policy, 'user@example.com', url)).toBe(true);
    expect(isUrlAllowed(url, policy.allowedOrigins, [])).toBe(true);
  });
  it.each(['https://crm.example.com.attacker.test', 'https://sub.crm.example.com', 'http://crm.example.com', 'https://crm.example.com:444', 'https://user:pass@crm.example.com', 'file:///tmp/x', 'javascript:alert(1)', 'data:text/plain,x', 'blob:https://crm.example.com/id'])('denies %s', url => {
    expect(urlAllowed(policy, 'user@example.com', url)).toBe(false);
    expect(isUrlAllowed(url, policy.allowedOrigins, [])).toBe(false);
  });
  it('denies an empty allowlist in both enforcement layers', () => {
    expect(urlAllowed({ ...policy, allowedOrigins: [] }, 'u@example.com', 'https://crm.example.com')).toBe(false);
    expect(isUrlAllowed('https://crm.example.com', [], [])).toBe(false);
    expect(combinePolicies([{ allow: [], deny: [] }])('https://crm.example.com')).toBe(false);
  });
  it('expires per-user overrides and still denies non-web schemes', () => {
    const overridden = { ...policy, overrides: [{ user: 'u@example.com', expiresAt: new Date(Date.now() + 60000).toISOString() }] };
    expect(urlAllowed(overridden, 'u@example.com', 'https://elsewhere.test')).toBe(true);
    expect(urlAllowed(overridden, 'other@example.com', 'https://elsewhere.test')).toBe(false);
    expect(urlAllowed(overridden, 'u@example.com', 'file:///tmp/x')).toBe(false);
    expect(unrestricted(overridden, 'u@example.com', Date.now() + 120000)).toBe(false);
  });
  it('rejects paths in administrator origin entries', () => {
    expect(PolicySchema.safeParse({ ...policy, allowedOrigins: ['https://crm.example.com/path'] }).success).toBe(false);
  });
  it('never sends the development token to a remote or credentialed URL', () => {
    expect(() => localConnection({ serverUrl: 'https://remote.test', token: 'secret' })).toThrow();
    expect(() => localConnection({ serverUrl: 'http://localhost:8787/path', token: 'secret' })).toThrow();
    expect(() => localConnection({ serverUrl: 'http://user:pass@localhost:8787', token: 'secret' })).toThrow();
  });
});
describe('mock planner', () => {
  it('builds sequential actions for all 100 records', () => {
    const plan = mockPlan('100件を順番に処理', 'http://localhost:8787/demo');
    expect(plan.steps).toHaveLength(201);
    expect(plan.steps[0].args).toMatchObject({ target: { name: '顧客 001' } });
    expect(plan.steps[198].args).toMatchObject({ target: { name: '顧客 100' } });
    expect(plan.steps[199].args).toMatchObject({ expect: { text: '顧客 100を処理しました' } });
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });
  it('does not pretend to understand an arbitrary instruction', () => {
    expect(mockPlan('航空券を予約して', 'http://localhost:8787/demo').steps).toEqual([]);
  });
  it('excludes screenshots and arbitrary scripts from the transport', () => {
    for (const tool of ['screenshot', 'evaluate', 'devtools', 'upload', 'tabs']) {
      expect(PlanSchema.safeParse({ mode: 'mock', message: '', steps: [{ tool, args: {}, label: '' }] }).success).toBe(false);
    }
  });
});
