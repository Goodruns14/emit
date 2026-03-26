#!/usr/bin/env node
/**
 * Run SQL statements against Snowflake using the env vars:
 * SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, SNOWFLAKE_PASSWORD
 *
 * Usage: node scripts/snowflake-run.js "SQL statement"
 *        node scripts/snowflake-run.js --file path/to/file.sql
 */

const snowflake = require('snowflake-sdk');

// Suppress Ocsp debug noise
snowflake.configure({ logLevel: 'ERROR' });

const account = process.env.SNOWFLAKE_ACCOUNT;
const username = process.env.SNOWFLAKE_USERNAME;
const password = process.env.SNOWFLAKE_PASSWORD;

if (!account || !username || !password) {
  console.error('Missing SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, or SNOWFLAKE_PASSWORD');
  process.exit(1);
}

const connection = snowflake.createConnection({ account, username, password });

function runStatement(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      complete: (err, stmt, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let sql;

  if (args[0] === '--file') {
    const fs = require('fs');
    sql = fs.readFileSync(args[1], 'utf8');
  } else {
    sql = args.join(' ');
  }

  if (!sql) {
    console.error('No SQL provided');
    process.exit(1);
  }

  await new Promise((resolve, reject) => {
    connection.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Split by semicolons, filter empty
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);

  for (const stmt of statements) {
    console.log(`\n--- Executing: ${stmt.substring(0, 80)}...`);
    try {
      const rows = await runStatement(connection, stmt);
      if (rows && rows.length > 0) {
        console.table(rows);
      } else {
        console.log('(no rows returned / success)');
      }
    } catch (err) {
      console.error('ERROR:', err.message);
    }
  }

  connection.destroy((err) => { if (err) console.error(err); });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
