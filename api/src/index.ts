import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import axios from 'axios';
import path from 'path';
import { config } from './config';
import { db } from './config/database';
import { apiKeyAuth } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';

const app = express();

// ---- Basic middleware ----
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

// CORS: explicit allowlist; never `*`.
app.use(
  cors({
    origin: (origin, callback) => {
      // Same-origin (no Origin header) or curl/tools — allow.
      if (!origin) return callback(null, true);
      if (config.corsAllowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
  })
);

// Static UI (no auth so the page can load; the API routes are still gated).
app.use(express.static(path.join(__dirname, '../public')));

// ---- Public routes ----
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/api', (_req: Request, res: Response) => {
  res.json({
    service: 'AI Content Audit System - API',
    version: '1.0.0',
    status: 'running',
  });
});

app.get('/health', async (_req: Request, res: Response) => {
  try {
    const dbHealthy = await db.testConnection();

    let imageModuleHealthy = false;
    try {
      const response = await axios.get(`${config.imageModuleUrl}/health`, { timeout: 5000 });
      imageModuleHealthy = response.status === 200;
    } catch (error) {
      console.error('Image Module health check failed:', error);
    }

    const status = dbHealthy ? (imageModuleHealthy ? 'healthy' : 'degraded') : 'unhealthy';
    const httpCode = dbHealthy ? 200 : 503;
    res.status(httpCode).json({
      status,
      version: '1.0.0',
      checks: {
        database: dbHealthy ? 'connected' : 'disconnected',
        imageModule: imageModuleHealthy ? 'connected' : 'disconnected',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/api/public-config', (_req: Request, res: Response) => {
  const spreadsheetId = config.googleSheets.spreadsheetId;
  res.status(200).json({
    thresholds: {
      minW: config.thresholds.minResolutionWidth,
      minH: config.thresholds.minResolutionHeight,
      blur: config.thresholds.blur,
      sharp: config.thresholds.sharpness,
      wmConf: config.thresholds.watermarkConfidence,
      catConf: config.thresholds.categoryConfidence,
    },
    spreadsheetUrl: spreadsheetId
      ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
      : null,
  });
});

// ---- Gated routes ----
import auditRoutes from './routes/audit';
app.use('/api/v1', apiKeyAuth, rateLimit);
app.use('/api/v1/audits', auditRoutes);

// ---- Error handlers ----
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  // Don't leak internal details in production.
  res.status(500).json({
    error: 'Internal server error',
    message: config.nodeEnv === 'production' ? 'Internal server error' : err.message,
    timestamp: new Date().toISOString(),
  });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    timestamp: new Date().toISOString(),
  });
});

// ---- Start ----
app.listen(config.apiPort, () => {
  console.log('===========================================');
  console.log('AI Content Audit System - API');
  console.log(`Server running on port ${config.apiPort}`);
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`CORS allowed origins: ${config.corsAllowedOrigins.join(', ')}`);
  console.log(`API key auth: ${config.apiKey ? 'enabled' : 'DISABLED (dev only)'}`);
  console.log(
    `Rate limit: ${config.rateLimit.max} requests / ${config.rateLimit.windowMs / 1000}s per IP`
  );
  console.log('===========================================');

  db.testConnection()
    .then((ok) => console.log(ok ? '✓ Database connection successful' : '✗ Database connection failed'))
    .catch((error) => console.error('✗ Database connection error:', error));
});

export default app;
