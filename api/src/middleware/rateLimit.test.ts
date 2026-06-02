import express from 'express';
import request from 'supertest';
import { rateLimit, __resetRateLimitForTests } from './rateLimit';

function makeApp() {
  const app = express();
  app.use(rateLimit);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rateLimit middleware', () => {
  beforeEach(() => __resetRateLimitForTests());

  it('lets calls through under the limit', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 with Retry-After once the limit is exceeded', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await request(app).get('/ping');
    const res = await request(app).get('/ping');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.body.error).toBe('Too Many Requests');
  });
});
