import express from 'express';
import request from 'supertest';
import auditRoutes from './audit';
import { ExecutionEngine } from '../services/ExecutionEngine';

const fakeResult = {
  auditId: 'audit-1',
  timestamp: new Date().toISOString(),
  propertyId: 'p-1001',
  propertyName: 'Alpha House',
  auditType: 'text' as const,
  qualityScore: 72,
  imageResults: [],
  issues: [],
  summary: {
    totalImages: 0,
    criticalIssues: 0,
    warnings: 0,
    passedImages: 0,
  },
  textResults: {
    extraction: { claims: [], model: 'heuristic-v1', extractedAt: new Date().toISOString() },
    factChecks: [],
    issues: [],
    summary: {
      totalClaims: 0,
      verifiedClaims: 0,
      conflictingClaims: 0,
      missingEvidenceClaims: 0,
      missingFields: 0,
      score: 72,
    },
  },
};

describe('audit route text qc', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/audits', auditRoutes);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts auditType=text and forwards text checks', async () => {
    const spy = jest
      .spyOn(ExecutionEngine.prototype, 'executeSingleAudit')
      .mockResolvedValue(fakeResult as any);

    const res = await request(app).post('/api/v1/audits/single').send({
      propertyId: '170410',
      auditType: 'text',
      textChecks: ['extraction', 'fact_check'],
    });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      '170410',
      expect.objectContaining({
        auditType: 'text',
        textChecks: ['extraction', 'fact_check'],
      })
    );
  });

  it('rejects invalid text checks', async () => {
    const res = await request(app).post('/api/v1/audits/single').send({
      propertyId: '170410',
      auditType: 'text',
      textChecks: ['invalid_check'],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid textChecks');
  });

  it('accepts auditType=both', async () => {
    const spy = jest
      .spyOn(ExecutionEngine.prototype, 'executeSingleAudit')
      .mockResolvedValue({ ...fakeResult, auditType: 'both' } as any);

    const res = await request(app).post('/api/v1/audits/single').send({
      propertyId: '170410',
      auditType: 'both',
      checks: ['quality'],
      textChecks: ['extraction', 'fact_check'],
    });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      '170410',
      expect.objectContaining({
        auditType: 'both',
        checks: ['quality'],
        textChecks: ['extraction', 'fact_check'],
      })
    );
  });

  it('rejects empty checks array for media/both audits', async () => {
    const res = await request(app).post('/api/v1/audits/single').send({
      propertyId: '170410',
      auditType: 'both',
      checks: [],
      textChecks: ['extraction'],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('checks must include at least one media check');
  });

  it('rejects non-string check entries', async () => {
    const res = await request(app).post('/api/v1/audits/single').send({
      propertyId: '170410',
      auditType: 'text',
      textChecks: ['extraction', 123],
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('textChecks must contain only strings');
  });

  it('supports async queue mode via runAsync flag', async () => {
    jest
      .spyOn(ExecutionEngine.prototype, 'executeSingleAudit')
      .mockResolvedValue(fakeResult as any);

    const res = await request(app).post('/api/v1/audits/single').send({
      propertyId: '170410',
      auditType: 'text',
      textChecks: ['extraction'],
      runAsync: true,
    });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.status).toBe('queued');
    expect(res.body.pollUrl).toContain('/api/v1/audits/jobs/');
  });
});
