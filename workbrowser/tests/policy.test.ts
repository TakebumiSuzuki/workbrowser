import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicySchema, PlanSchema, modelAllowed, unrestricted, urlAllowed, writePermission } from '../src/shared/contracts';
import { classify } from '../src/browser-control/core/interaction/classify';
import type { FormFacts } from '../src/browser-control/probe';
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

describe('action permission settings', () => {
  it('loads existing policies with Ask as the default and no site rules', () => {
    const { writeMode: _mode, writeRules: _rules, ...legacy } = DEFAULT_POLICY;
    expect(PolicySchema.parse(legacy)).toMatchObject({ writeMode: 'ask', writeRules: [] });
  });
  it('uses exact-origin site rules before the global mode without granting browsing/AI access', () => {
    const policy = { ...DEFAULT_POLICY, writeMode: 'auto' as const, writeRules: [
      { origin: 'https://ask.test', rule: 'ask' as const }, { origin: 'https://block.test', rule: 'block' as const },
    ] };
    expect(writePermission(policy, 'https://ask.test/path')).toEqual({ rule: 'ask', canRemember: false });
    expect(writePermission(policy, 'https://block.test')).toEqual({ rule: 'block', canRemember: false });
    expect(writePermission(policy, 'https://ask.test:444')).toMatchObject({ rule: 'allow' });
    expect(writePermission({ ...DEFAULT_POLICY, writeRules: [{ origin: 'https://allow.test', rule: 'allow' }] }, 'https://allow.test')).toMatchObject({ rule: 'allow' });
    expect(modelAllowed(policy, 'u@example.test', 'https://ask.test')).toBe(false);
    expect(writePermission(policy, 'file:///tmp/x').rule).toBe('block');
  });
  it('rejects duplicate site rules and invalid modes', () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, writeMode: 'anything' }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, writeRules: [{ origin: 'https://a.test', rule: 'ask' }, { origin: 'https://a.test', rule: 'allow' }] }).success).toBe(false);
  });
  it.each(['Delete private note', 'Delete customer record', '私用メモを削除', '顧客レコードを削除'])('classifies %s as the same deletion category', name => {
    const facts: FormFacts = { tag: 'button', type: 'button', classes: '', isLink: false, submitter: false, field: false, form: null, money: '', textEntry: false, searchField: false };
    expect(classify({ mode: 'activate', name, role: 'button', facts }).category).toBe('delete');
  });
});
