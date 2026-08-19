import mysql, { type Pool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";

export type DatabaseResult<T = Record<string, unknown>> = {
  success: true;
  results: T[];
  meta: { changes?: number; lastRowId?: number | string };
};

type QueryExecutor = Pool | PoolConnection;

let pool: Pool | null = null;

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getMySqlPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST?.trim() || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: requiredEnvironment("DB_USER"),
    password: requiredEnvironment("DB_PASSWORD"),
    database: requiredEnvironment("DB_NAME"),
    waitForConnections: true,
    connectionLimit: Math.max(2, Number(process.env.DB_POOL_SIZE || 10)),
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: "utf8mb4",
    timezone: "Z",
    decimalNumbers: true,
  });
  return pool;
}

export class PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  private async execute(executor: QueryExecutor) {
    return executor.execute(this.sql, this.values);
  }

  async first<T = Record<string, unknown>>() {
    const [rows] = await this.execute(getMySqlPool());
    if (!Array.isArray(rows)) return null;
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    const [rows] = await this.execute(getMySqlPool());
    return { success: true, results: (Array.isArray(rows) ? rows : []) as T[], meta: {} };
  }

  async run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> {
    return this.runWith<T>(getMySqlPool());
  }

  async runWith<T = Record<string, unknown>>(executor: QueryExecutor): Promise<DatabaseResult<T>> {
    const [result] = await this.execute(executor);
    const header = result as ResultSetHeader;
    return {
      success: true,
      results: (Array.isArray(result) ? result : []) as T[],
      meta: { changes: header.affectedRows ?? 0, lastRowId: header.insertId ?? 0 },
    };
  }
}

export class MySqlDatabase {
  prepare(query: string) {
    return new PreparedStatement(query);
  }

  async batch<T = Record<string, unknown>>(statements: PreparedStatement[]) {
    if (!statements.length) return [] as DatabaseResult<T>[];
    const connection = await getMySqlPool().getConnection();
    try {
      await connection.beginTransaction();
      const results: DatabaseResult<T>[] = [];
      for (const statement of statements) results.push(await statement.runWith<T>(connection));
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async ping() {
    const connection = await getMySqlPool().getConnection();
    try {
      await connection.ping();
    } finally {
      connection.release();
    }
  }
}

export const database = new MySqlDatabase();

export async function closeDatabasePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
