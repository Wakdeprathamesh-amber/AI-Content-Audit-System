// Stub out real env so tests don't accidentally pick up the user's .env
// (which contains live OpenAI/DB creds — we never want it loaded in CI).

process.env.NODE_ENV = 'test';
process.env.API_PORT = '0';
process.env.AMBER_DB_HOST = '';
process.env.AMBER_DB_PORT = '5432';
process.env.AMBER_DB_NAME = 'test';
process.env.AMBER_DB_USER = 'test';
process.env.AMBER_DB_PASSWORD = 'test';

process.env.OUTPUT_MODE = 'database'; // skip Google Sheets path
process.env.IMAGE_MODULE_URL = 'http://localhost:65535'; // unreachable on purpose
process.env.CACHE_ENABLED = 'false';

process.env.API_KEY = 'test-key';
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX = '5';

process.env.MIN_RESOLUTION_WIDTH = '800';
process.env.MIN_RESOLUTION_HEIGHT = '800';
process.env.RECOMMENDED_RESOLUTION_WIDTH = '1920';
process.env.RECOMMENDED_RESOLUTION_HEIGHT = '1080';
process.env.BLUR_THRESHOLD = '100';
process.env.SHARPNESS_THRESHOLD = '50';
process.env.DUPLICATE_SIMILARITY_THRESHOLD = '95';
process.env.CATEGORY_CONFIDENCE_THRESHOLD = '70';
process.env.WATERMARK_CONFIDENCE_THRESHOLD = '85';
