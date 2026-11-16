import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Identity } from '../src/shared/contracts';

const keys = createRemoteJWKSet(new URL('https://www.gstatic.com/iap/verify/public_key-jwk'));
export interface AuthConfig {
  mode: 'local' | 'iap'; token: string; localEmail: string; localAdmin: boolean;
  iapAudience?: string; workspaceDomain?: string; adminEmails?: string[];
}
export async function authenticate(headers: Headers, config: AuthConfig): Promise<Identity | null> {
  if (config.mode === 'local') {
    const supplied = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const a = Buffer.from(supplied), b = Buffer.from(config.token);
    if (!b.length || a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { email: config.localEmail, admin: config.localAdmin, mode: 'local' };
  }
  if (!config.iapAudience || !config.workspaceDomain) return null;
  const assertion = headers.get('x-goog-iap-jwt-assertion');
  if (!assertion) return null;
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      issuer: 'https://cloud.google.com/iap', audience: config.iapAudience, algorithms: ['ES256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (email.split('@')[1] !== config.workspaceDomain.toLowerCase()) return null;
    return { email, admin: (config.adminEmails ?? []).map(e => e.toLowerCase()).includes(email), mode: 'iap' };
  } catch { return null; }
}
