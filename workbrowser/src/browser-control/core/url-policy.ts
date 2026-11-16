// Derived from Nanobrowser; modified for Workbrowser exact-origin, default-deny policy.
import { siteOf } from './site';

export interface UrlPolicy {
  allow: string[];
  deny: string[];
  /**
   * Blocked sites, matched with `siteOf`: the exact host, so a row covers the same addresses as an Allow or Ask row.
   * The deny and allow lists keep their own rules for the test panel.
   */
  blocked?: string[];
}

export const EMPTY_POLICY: UrlPolicy = { allow: [], deny: [], blocked: [] };

/** A site as a user may type it ("Example.com", "https://www.example.com/x", "localhost:3000"), as `siteOf` keys it. */
export function siteKey(entry: string): string {
  const e = entry.trim();
  if (!e) return '';
  return siteOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(e) ? e : `http://${e}`);
}

/** Whether an address loads a blocked site: its own site, or for a blob: URL the site that made it. */
export function isBlockedSite(url: string, blocked: readonly string[] | undefined): boolean {
  if (!blocked?.length) return false;
  const trimmed = url.trim();
  const site = siteOf(trimmed.toLowerCase().startsWith('blob:') ? trimmed.slice(5) : trimmed);
  return !!site && blocked.includes(site);
}

// Modified for Workbrowser: exact origins (scheme, host and port), no implicit subdomains.
// An empty allow list denies access. Only the host may supply '*' for a timed admin override.
export function isUrlAllowed(url: string, allowList: string[], denyList: string[]): boolean {
  if (url === 'about:blank') return true; // only a transient navigation destination; never observed by the host
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    if (parsed.hostname === 'chromewebstore.google.com') return false;
    if (denyList.includes(parsed.origin)) return false;
    return allowList.includes('*') || allowList.includes(parsed.origin);
  } catch { return false; }
}
export function normalizePolicy(policy: UrlPolicy): UrlPolicy {
  return { allow: [...new Set(policy.allow)], deny: [...new Set(policy.deny)], blocked: policy.blocked ?? [] };
}

/** Layer 3 runs only when a list is configured; the always-blocked schemes are covered by layers 1, 2 and 4. */
export function hasLists(policy: UrlPolicy): boolean {
  return policy.allow.length > 0 || policy.deny.length > 0 || (policy.blocked?.length ?? 0) > 0;
}

/** The most restrictive combination: a URL passes only if every policy allows it. */
export function combinePolicies(policies: UrlPolicy[]): (url: string) => boolean {
  return url => policies.every(p => allows(p, url)) && isUrlAllowed(url, ['*'], []);
}

export function allows(policy: UrlPolicy, url: string): boolean {
  return !isBlockedSite(url, policy.blocked) && isUrlAllowed(url, policy.allow, policy.deny);
}
