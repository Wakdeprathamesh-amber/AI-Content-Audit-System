import { randomUUID } from 'crypto';
import { AuditOptions, AuditResult } from '../../../shared/types';

type JobStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface AuditJobState {
  jobId: string;
  propertyId: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  auditId?: string;
  error?: string;
}

type ExecuteSingle = (propertyId: string, options: AuditOptions) => Promise<AuditResult>;

export class AuditJobQueue {
  private readonly jobs = new Map<string, AuditJobState>();

  constructor(private readonly executeSingle: ExecuteSingle) {}

  enqueue(propertyId: string, options: AuditOptions): AuditJobState {
    const jobId = randomUUID();
    const state: AuditJobState = {
      jobId,
      propertyId,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, state);

    if (process.env.NODE_ENV === 'test') {
      return state;
    }

    setTimeout(async () => {
      const current = this.jobs.get(jobId);
      if (!current) return;
      current.status = 'in_progress';
      current.startedAt = new Date().toISOString();
      this.jobs.set(jobId, current);
      try {
        const result = await this.executeSingle(propertyId, options);
        const done = this.jobs.get(jobId);
        if (!done) return;
        done.status = 'completed';
        done.finishedAt = new Date().toISOString();
        done.auditId = result.auditId;
        this.jobs.set(jobId, done);
      } catch (error: any) {
        const failed = this.jobs.get(jobId);
        if (!failed) return;
        failed.status = 'failed';
        failed.finishedAt = new Date().toISOString();
        failed.error = error?.message || 'unknown error';
        this.jobs.set(jobId, failed);
      }
    }, 0);

    return state;
  }

  getJob(jobId: string): AuditJobState | null {
    return this.jobs.get(jobId) || null;
  }
}
