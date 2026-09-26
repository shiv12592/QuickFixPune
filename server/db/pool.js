const { Pool } = require('pg');
const { normalizeMobile } = require('./phone');

// MANUAL SETUP REQUIRED: Configure DATABASE_URL locally from Supabase Connect.
// Never commit the URI; the repository-root .env file is gitignored.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for PostgreSQL mode');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', error => {
  console.error('[Database] Unexpected idle client error:', error.message);
});

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  normalizeMobile,
  withTransaction
};
