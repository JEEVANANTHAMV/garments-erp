/**
 * Apply the SQL schema files in db/ in order.
 *
 * Usage:
 *   npm run db:migrate            # apply (fails if database already exists)
 *   npm run db:migrate -- --fresh # DROP and recreate from scratch
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '../../../db');

async function main() {
  const fresh = process.argv.includes('--fresh');

  // Connect without selecting a database — 01_foundation.sql creates it.
  const conn = await mysql.createConnection({
    host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password,
    multipleStatements: true,
  });

  try {
    const [existing] = await conn.query<any[]>(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`, [env.db.database]);

    if (existing.length && !fresh) {
      console.log(`[migrate] Database "${env.db.database}" exists — applying incremental migrations...`);
    }
    if (existing.length && fresh) {
      console.log(`[migrate] --fresh: dropping database "${env.db.database}"...`);
      await conn.query(`DROP DATABASE IF EXISTS \`${env.db.database}\``);
    }

    const files = (await readdir(DB_DIR)).filter((f) => f.endsWith('.sql')).sort();
    if (!files.length) throw new Error(`No .sql files found in ${DB_DIR}`);

    // When DB exists and not --fresh, only run incremental migrations (e.g. 10_+)
    const filesToRun = existing.length && !fresh
      ? files.filter((f) => {
          const num = parseInt(f.slice(0, 2), 10);
          return isNaN(num) || num >= 10;
        })
      : files;

    for (const file of filesToRun) {
      const sql = await readFile(join(DB_DIR, file), 'utf8');
      const body = `USE \`${env.db.database}\`;\n${sql}`;
      process.stdout.write(`[migrate] ${file} ... `);
      try {
        await conn.query(body);
        console.log('ok');
      } catch (err: any) {
        if (!fresh && (err.message.includes('already exists') || err.message.includes('Duplicate column') || err.message.includes('Duplicate key'))) {
          console.log('already applied (skipped)');
        } else {
          console.log('warn:', err.message);
        }
      }
    }

    const [tables] = await conn.query<any[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?`, [env.db.database]);
    console.log(`[migrate] done — ${tables[0].n} tables in "${env.db.database}".`);
    console.log('[migrate] next: npm run db:seed');
  } finally {
    await conn.end();
  }
}

main().catch((err) => { console.error('[migrate] failed:', err.message); process.exit(1); });
