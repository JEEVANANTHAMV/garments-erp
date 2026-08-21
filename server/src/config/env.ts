import 'dotenv/config';

function req(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const env = {
  port: Number(req('PORT', '4000')),
  nodeEnv: req('NODE_ENV', 'development'),
  isProd: process.env.NODE_ENV === 'production',
  corsOrigin: req('CORS_ORIGIN', 'http://localhost:5173').split(',').map((s) => s.trim()),

  db: {
    host: req('DB_HOST', '127.0.0.1'),
    port: Number(req('DB_PORT', '3306')),
    user: req('DB_USER', 'root'),
    password: process.env.DB_PASSWORD ?? '',
    database: req('DB_NAME', 'garment_erp'),
    connectionLimit: Number(req('DB_CONNECTION_LIMIT', '15')),
  },

  jwt: {
    accessSecret: req('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
    refreshSecret: req('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
    accessTtl: req('JWT_ACCESS_TTL', '15m'),
    refreshTtl: req('JWT_REFRESH_TTL', '7d'),
  },

  bcryptRounds: Number(req('BCRYPT_ROUNDS', '10')),

  seed: {
    adminUsername: req('SEED_ADMIN_USERNAME', 'admin'),
    adminPassword: req('SEED_ADMIN_PASSWORD', 'Admin@123'),
  },
};

if (env.isProd) {
  for (const [k, v] of Object.entries({
    JWT_ACCESS_SECRET: env.jwt.accessSecret,
    JWT_REFRESH_SECRET: env.jwt.refreshSecret,
  })) {
    if (v.startsWith('dev-')) throw new Error(`${k} must be changed from its development default in production`);
  }
}
