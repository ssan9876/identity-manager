import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index'

export interface DbClient {
  db: NodePgDatabase<typeof schema>
  pool: Pool
}

export function createDbClient(databaseUrl: string): DbClient {
  const pool = new Pool({ connectionString: databaseUrl })
  return { db: drizzle(pool, { schema }), pool }
}
