import { Pool, PoolConfig } from 'pg';
import { config } from './index';

export class Database {
  private static instance: Database;
  private pool: Pool;

  private constructor() {
    console.log('Database configuration:', {
      host: config.db.host || 'NOT SET',
      port: config.db.port,
      database: config.db.database || 'NOT SET',
      user: config.db.user || 'NOT SET',
      hasPassword: !!config.db.password,
      sslRejectUnauthorized: config.db.sslRejectUnauthorized,
    });

    const pgConfig: PoolConfig = {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      max: config.db.maxConnections,
      idleTimeoutMillis: config.db.idleTimeoutMs,
      connectionTimeoutMillis: config.db.connectionTimeoutMs,
      ssl: {
        // Production should set DB_SSL_REJECT_UNAUTHORIZED=true and pin a CA bundle.
        rejectUnauthorized: config.db.sslRejectUnauthorized,
      },
    };

    this.pool = new Pool(pgConfig);

    this.pool.on('error', (err) => {
      console.error('Unexpected database pool error:', err);
    });

    console.log('Database connection pool initialized');
  }

  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async query(text: string, params?: any[]) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      console.log('Executed query', { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      console.error('Database query error:', error);
      throw error;
    }
  }

  public async testConnection(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1 as test');
      console.log('Database connection test successful');
      return result.rows[0].test === 1;
    } catch (error) {
      console.error('Database connection test failed:', error);
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
    console.log('Database connection pool closed');
  }
}

export const db = Database.getInstance();
