const { Client } = require('pg')
const bcrypt = require('bcryptjs')

;(async () => {
  const connectionString = process.env.DATABASE_URL || process.argv[2]
  if (!connectionString) {
    console.error('Usage: DATABASE_URL=... node scripts/reset-login-users.js')
    process.exit(1)
  }
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } })
  try {
    await client.connect()
    const adminHash = bcrypt.hashSync('admin123', 12)
    const amplifyxAdminHash = bcrypt.hashSync('123456', 12)
    await client.query('UPDATE users SET password_hash=$1, status=COALESCE(status,\'active\'), updated_at=now() WHERE username=$2', [adminHash, 'admin'])
    await client.query('UPDATE users SET password_hash=$1, status=COALESCE(status,\'active\'), updated_at=now() WHERE username=$2', [amplifyxAdminHash, 'amplifyx_admin'])
    console.log('Passwords reset: admin -> admin123; amplifyx_admin -> 123456')
  } catch (e) {
    console.error('Reset failed:', e.message)
    process.exit(1)
  } finally {
    try { await client.end() } catch {}
  }
})()


