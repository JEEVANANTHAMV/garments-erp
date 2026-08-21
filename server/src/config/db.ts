import mysql from 'mysql2/promise';
import { env } from './env.js';

export const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  charset: 'utf8mb4_general_ci',
  timezone: 'Z',
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: false,
  namedPlaceholders: true,
});

export type SqlParams = Record<string, unknown> | unknown[];

/** Run a query and return typed rows. */
export async function query<T = any>(sql: string, params?: SqlParams): Promise<T[]> {
  const [rows] = await pool.query(sql, params as any);
  return rows as T[];
}

/** Run a query returning a single row (or null). */
export async function queryOne<T = any>(sql: string, params?: SqlParams): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Run an INSERT/UPDATE/DELETE, returning affectedRows / insertId. */
export async function execute(sql: string, params?: SqlParams) {
  const [res] = await pool.execute(sql, params as any);
  return res as mysql.ResultSetHeader;
}

export type Tx = mysql.PoolConnection;

/**
 * Run `fn` inside a transaction. Commits on resolve, rolls back on throw.
 * Always pass the supplied connection to nested queries.
 */
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function txQuery<T = any>(tx: Tx, sql: string, params?: SqlParams): Promise<T[]> {
  const [rows] = await tx.query(sql, params as any);
  return rows as T[];
}

export async function txQueryOne<T = any>(tx: Tx, sql: string, params?: SqlParams): Promise<T | null> {
  const rows = await txQuery<T>(tx, sql, params);
  return rows[0] ?? null;
}

export async function txExecute(tx: Tx, sql: string, params?: SqlParams) {
  const [res] = await tx.execute(sql, params as any);
  return res as mysql.ResultSetHeader;
}

export async function pingDb(): Promise<void> {
  const conn = await pool.getConnection();
  try { await conn.ping(); } finally { conn.release(); }
}
