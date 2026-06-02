import fs from 'fs';
import path from 'path';
import { AuditResult, BulkAuditSummary } from '../../../shared/types';

export class AuditResultWriter {
  constructor(private outputDir: string = './audit-results') {
    this.ensureOutputDirExists();
  }

  /**
   * Ensure the output directory exists
   */
  private ensureOutputDirExists(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Write audit result to JSON file
   * Creates directory structure: ./audit-results/{date}/{property_id}/audit-{auditId}.json
   */
  async writeAuditResult(
    auditId: string,
    propertyId: string,
    result: AuditResult
  ): Promise<string> {
    try {
      // Create date-based directory structure
      const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const propertyDir = path.join(this.outputDir, date, propertyId);

      // Ensure directory exists
      if (!fs.existsSync(propertyDir)) {
        fs.mkdirSync(propertyDir, { recursive: true });
      }

      // Write JSON file
      const filename = `audit-${auditId}.json`;
      const filepath = path.join(propertyDir, filename);

      fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf-8');

      console.log(`Audit result written to: ${filepath}`);
      return filepath;
    } catch (error) {
      console.error('Error writing audit result:', error);
      throw new Error(`Failed to write audit result: ${error}`);
    }
  }

  /**
   * Generate CSV report for bulk audits
   * Creates file: ./audit-results/bulk-{jobId}-summary.csv
   */
  async generateBulkCSVReport(
    jobId: string,
    summary: BulkAuditSummary
  ): Promise<string> {
    try {
      const filename = `bulk-${jobId}-summary.csv`;
      const filepath = path.join(this.outputDir, filename);

      // CSV header
      const headers = [
        'property_id',
        'property_name',
        'quality_score',
        'critical_issues',
        'warnings',
        'audit_date',
      ];

      // CSV rows
      const rows = summary.results.map((result) => [
        result.propertyId,
        `"${result.propertyName}"`, // Quote to handle commas in names
        result.qualityScore.toFixed(2),
        result.criticalIssues,
        result.warnings,
        new Date().toISOString().split('T')[0],
      ]);

      // Combine header and rows
      const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');

      // Write CSV file
      fs.writeFileSync(filepath, csvContent, 'utf-8');

      console.log(`Bulk audit CSV report written to: ${filepath}`);
      return filepath;
    } catch (error) {
      console.error('Error generating bulk CSV report:', error);
      throw new Error(`Failed to generate bulk CSV report: ${error}`);
    }
  }

  /**
   * Write bulk audit summary as JSON
   * Creates file: ./audit-results/bulk-{jobId}-summary.json
   */
  async writeBulkSummary(jobId: string, summary: BulkAuditSummary): Promise<string> {
    try {
      const filename = `bulk-${jobId}-summary.json`;
      const filepath = path.join(this.outputDir, filename);

      fs.writeFileSync(filepath, JSON.stringify(summary, null, 2), 'utf-8');

      console.log(`Bulk audit summary written to: ${filepath}`);
      return filepath;
    } catch (error) {
      console.error('Error writing bulk summary:', error);
      throw new Error(`Failed to write bulk summary: ${error}`);
    }
  }

  /**
   * Read audit result from file
   */
  async readAuditResult(filepath: string): Promise<AuditResult> {
    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      return JSON.parse(content) as AuditResult;
    } catch (error) {
      console.error('Error reading audit result:', error);
      throw new Error(`Failed to read audit result: ${error}`);
    }
  }

  /**
   * List all audit results for a property
   */
  async listPropertyAudits(propertyId: string): Promise<string[]> {
    try {
      const audits: string[] = [];

      // Search through date directories
      const dates = fs.readdirSync(this.outputDir).filter((item) => {
        const itemPath = path.join(this.outputDir, item);
        return fs.statSync(itemPath).isDirectory() && item.match(/^\d{4}-\d{2}-\d{2}$/);
      });

      for (const date of dates) {
        const propertyDir = path.join(this.outputDir, date, propertyId);
        if (fs.existsSync(propertyDir)) {
          const files = fs
            .readdirSync(propertyDir)
            .filter((file) => file.startsWith('audit-') && file.endsWith('.json'))
            .map((file) => path.join(propertyDir, file));

          audits.push(...files);
        }
      }

      return audits.sort().reverse(); // Most recent first
    } catch (error) {
      console.error('Error listing property audits:', error);
      return [];
    }
  }

  /**
   * Get the most recent audit for a property
   */
  async getLatestAudit(propertyId: string): Promise<AuditResult | null> {
    try {
      const audits = await this.listPropertyAudits(propertyId);
      if (audits.length === 0) {
        return null;
      }

      return await this.readAuditResult(audits[0]);
    } catch (error) {
      console.error('Error getting latest audit:', error);
      return null;
    }
  }

  /**
   * Resolve an audit result path by audit id.
   * Searches date/property tree for `audit-{auditId}.json`.
   */
  async findAuditPathById(auditId: string): Promise<string | null> {
    try {
      if (!auditId || auditId.trim().length === 0) return null;
      const filename = `audit-${auditId}.json`;
      const dates = fs.readdirSync(this.outputDir).filter((item) => {
        const itemPath = path.join(this.outputDir, item);
        return fs.statSync(itemPath).isDirectory() && item.match(/^\d{4}-\d{2}-\d{2}$/);
      });

      for (const date of dates) {
        const dateDir = path.join(this.outputDir, date);
        const propertyDirs = fs.readdirSync(dateDir).filter((item) => {
          const itemPath = path.join(dateDir, item);
          return fs.statSync(itemPath).isDirectory();
        });
        for (const propertyDirName of propertyDirs) {
          const candidate = path.join(dateDir, propertyDirName, filename);
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding audit by id:', error);
      return null;
    }
  }

  async getAuditById(auditId: string): Promise<AuditResult | null> {
    const filepath = await this.findAuditPathById(auditId);
    if (!filepath) return null;
    return this.readAuditResult(filepath);
  }
}
