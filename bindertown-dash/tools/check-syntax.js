// node --check on every .js file under src (main process, features, dashboard, preload, lab)
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..', 'src');
const all = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'assets') walk(p); } else if (f.endsWith('.js')) all.push(p); } })(root);
let bad = 0;
for (const f of all) { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(String(e.stderr || e.message)); } }
console.log(`syntax: ${all.length} files, ${bad} broken`);
process.exit(bad ? 1 : 0);
