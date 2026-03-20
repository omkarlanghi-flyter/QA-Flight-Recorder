const db = require('./server/db');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DATA_DIR = path.join(os.homedir(), '.qa-flight-recorder');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

async function test() {
  await db.init();
  const flows = db.listSanityFlows();
  for (const f of flows) {
    const rDir = path.join(SESSIONS_DIR, f.id, 'replays');
    if (fs.existsSync(rDir)) {
       console.log("Flow:", f.flow_name, "has replays in", f.id);
       console.log(fs.readdirSync(rDir));
    }
  }
}
test();
