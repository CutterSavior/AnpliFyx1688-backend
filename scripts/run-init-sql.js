const { Client } = require('pg')
const fs = require('fs')
const path = require('path')
const bcrypt = require('bcryptjs')

const connectionString = process.env.DATABASE_URL || process.argv[2]
if (!connectionString) {
  console.error('Missing DATABASE_URL. Set env or pass as arg.')
  process.exit(1)
}

// init.sql 位於專案根目錄 GAME_01 下
const sqlPath = path.resolve(__dirname, '..', '..', 'init.sql')
if (!fs.existsSync(sqlPath)) {
  console.error('init.sql not found at:', sqlPath)
  process.exit(1)
}

let sql = fs.readFileSync(sqlPath, 'utf8')

;(async () => {
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    console.log('Connected to database.')

    // 先嘗試建立擴展（如無權限則忽略）
    const extensions = [
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm";',
      'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
    ]
    for (const ext of extensions) {
      try { await client.query(ext) } catch (e) { console.warn('EXT SKIP:', e.message) }
    }

    // 去除 SQL 中的 CREATE EXTENSION 行，避免重複與權限錯誤
    sql = sql
      .split('\n')
      .filter(l => !/^\s*CREATE\s+EXTENSION/i.test(l))
      .join('\n')

    // 動態以 bcrypt 取代 crypt('123456', gen_salt('bf', 12))，避免缺 pgcrypto 時失敗
    const hash123 = bcrypt.hashSync('123456', bcrypt.genSaltSync(12))
    sql = sql.replace(/crypt\('123456',\s*gen_salt\('bf',\s*12\)\)/gi, `'${hash123}'`)

    // 整份 SQL 一次執行，避免 $$ 函式被切斷
    await client.query(sql)

    console.log('Applied init.sql successfully.')
    process.exit(0)
  } catch (err) {
    console.error('Error applying init.sql:', err.message)
    process.exit(1)
  } finally {
    try { await client.end() } catch (_) {}
  }
})()


