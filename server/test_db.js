const sql = require('sql.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DB_PATH = path.join(os.homedir(), '.qa-flight-recorder', 'index.db');
sql().then(SQL => {
  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  const res = db.exec("SELECT id, url, title, flow_name, started_at FROM sessions ORDER BY started_at DESC LIMIT 5;");
  console.log(JSON.stringify(res, null, 2));
}).catch(console.error);
