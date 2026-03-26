// db.js - Single shared PostgreSQL connection pool
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                      // 10 connections total (not 70!)
  idleTimeoutMillis: 30000,     // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if can't connect in 5s
});

// Log pool errors instead of crashing
pool.on('error', (err) => {
  console.error('❌ Unexpected database pool error:', err.message);
});

module.exports = pool;
