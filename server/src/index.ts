import { createApp } from './app.js';
import { env } from './config/env.js';
import { pingDb, pool } from './config/db.js';

async function main() {
  try {
    await pingDb();
    console.log(`[db] connected to ${env.db.database} at ${env.db.host}:${env.db.port}`);
  } catch (err) {
    console.error('[db] connection failed:', (err as Error).message);
    console.error('     Check your .env settings and that MySQL is running.');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[api] Garment ERP API listening on http://localhost:${env.port}`);
    console.log(`[api] environment: ${env.nodeEnv}`);
  });

  const shutdown = (signal: string) => {
    console.log(`\n[api] ${signal} received, shutting down...`);
    server.close(() => {
      void pool.end().then(() => { console.log('[api] closed cleanly'); process.exit(0); });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
