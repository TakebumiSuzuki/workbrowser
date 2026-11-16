import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { authenticate, type AuthConfig } from './auth';
import { PolicyStore } from './store';
import { mockPlan } from './planner';
import { DEMO_HTML, DEMO_JS } from './demo';
import { PlanRequestSchema, PolicySchema, modelAllowed, urlAllowed, type Identity } from '../src/shared/contracts';
import { AgentRequestSchema, DoneSchema } from '../src/shared/agent';
import { createModel, ModelError, type ModelProvider } from './model';

export function createApp(config: AuthConfig, store: PolicyStore, model: ModelProvider = createModel()) {
  const app = new Hono<{ Variables: { identity: Identity } }>();
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    // A token is still required: CORS is not authentication. No web-page origins are allowed.
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return c.json({ error: 'ORIGIN_DENIED' }, 403);
    return cors({ origin: origin ?? '', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'PUT', 'POST'], maxAge: 600 })(c, next);
  });
  app.get('/healthz', c => c.json({ ok: true, mode: config.mode }));
  app.get('/demo', c => c.html(DEMO_HTML));
  app.get('/demo.js', c => c.body(DEMO_JS, 200, { 'Content-Type': 'application/javascript' }));
  app.use('/api/*', async (c, next) => {
    const identity = await authenticate(c.req.raw.headers, config);
    if (!identity) return c.json({ error: 'UNAUTHENTICATED', message: '接続設定またはログイン状態を確認してください。' }, 401);
    c.set('identity', identity);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/me', c => c.json(c.get('identity')));
  app.get('/api/agent/info', c => c.json(model.info));
  app.post('/api/agent/test', async c => {
    const turn = await model.turn({ prompt: 'Connection test. Call done with outcome success and answer "Connection successful". Do not browse.', currentUrl: '', notes: '', history: [], sources: [], finishOnly: true }, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90000)]));
    return c.json({ ok: turn.content.parts.some(p => p.functionCall?.name === 'done' && DoneSchema.safeParse(p.functionCall.args).success), ...model.info });
  });
  app.post('/api/agent/turn', async c => {
    const parsed = AgentRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'INVALID_AGENT_REQUEST', message: 'Invalid or oversized agent context.' }, 400);
    const request = parsed.data;
    const policy = await store.read();
    if (request.history.length >= policy.maxSteps) return c.json({ error: 'STEP_LIMIT', message: 'Agent turn limit reached.' }, 400);
    // Re-evaluate every page represented in context, including previously captured content after revocation.
    const urls = [...request.sources, ...(request.initial ? [request.initial.url] : []), ...request.history.flatMap(e => e.results.flatMap(r => r.url ? [r.url] : []))];
    if (urls.some(url => !modelAllowed(policy, c.get('identity').email, url))) return c.json({ error: 'MODEL_DATA_DENIED', message: 'A source site is not approved for AI page access. Check administrator settings.' }, 403);
    return c.json(await model.turn(request, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(90000)])));
  });
  app.get('/api/policy', async c => c.json(await store.read()));
  app.put('/api/policy', async c => {
    if (!c.get('identity').admin) return c.json({ error: 'FORBIDDEN' }, 403);
    const parsed = PolicySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'INVALID_POLICY', message: parsed.error.issues.map(i => i.message).join(' / ') }, 400);
    if (parsed.data.overrides.some(o => Date.parse(o.expiresAt) > Date.now() + 24 * 3600_000)) return c.json({ error: 'OVERRIDE_TOO_LONG', message: '解除期限は24時間以内にしてください。' }, 400);
    try { return c.json(await store.save(parsed.data)); }
    catch (e) { if ((e as Error).message === 'CONFLICT') return c.json({ error: 'CONFLICT', message: '他の変更が保存されています。再読込してください。' }, 409); throw e; }
  });
  app.post('/api/agent/plan', async c => {
    if (config.mode !== 'local') return c.json({ error: 'MODEL_NOT_CONFIGURED', message: '本番AI接続は未設定です。' }, 503);
    const parsed = PlanRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: 'INVALID_REQUEST' }, 400);
    const policy = await store.read();
    if (!urlAllowed(policy, c.get('identity').email, parsed.data.url)) return c.json({ error: 'URL_NOT_ALLOWED', message: 'このサイトは許可されていません。' }, 403);
    const plan = mockPlan(parsed.data.prompt, parsed.data.url);
    if (plan.steps.length > policy.maxSteps) return c.json({ error: 'STEP_LIMIT', message: '操作数が管理者の上限を超えています。' }, 400);
    return c.json(plan);
  });
  app.onError((error, c) => {
    if (error instanceof ModelError) return c.json({ error: 'MODEL_ERROR', message: error.message }, error.status as 502 | 503);
    return c.json({ error: 'SERVER_ERROR', message: 'Request failed. Check settings and input.' }, 500);
  });
  return app;
}
