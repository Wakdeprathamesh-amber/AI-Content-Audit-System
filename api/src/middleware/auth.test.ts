import express from 'express';
import request from 'supertest';

// Force a known key for this suite, independent of test-setup ordering.
process.env.API_KEY = 'test-key';

import { apiKeyAuth } from './auth';

function makeApp() {
  const app = express();
  app.use(apiKeyAuth);
  app.get('/secret', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('apiKeyAuth middleware', () => {
  it('rejects missing header with 401', async () => {
    const res = await request(makeApp()).get('/secret');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects wrong header with 401', async () => {
    const res = await request(makeApp()).get('/secret').set('x-api-key', 'wrong');
    expect(res.status).toBe(401);
  });

  it('accepts correct header', async () => {
    const res = await request(makeApp()).get('/secret').set('x-api-key', 'test-key');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
