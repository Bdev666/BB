// Every script main.js sends into a game page is built from a template (const X_JS = `...` or (args) => `...`).
// A wrong escape in one only breaks when it runs in the game, so `node --check` never sees it: build each one
// here and parse what it produces.
const fs = require('fs');
const path = require('path');
const srcDir = path.join(__dirname, '..', 'src');
const files = [path.join(srcDir, 'main.js'), ...fs.readdirSync(path.join(srcDir, 'features')).filter((f) => f.endsWith('.js')).map((f) => path.join(srcDir, 'features', f))];
// names the templates may use from the shared object: anything, as a plain stand-in
const HUB = new Proxy({}, { get: () => (...a) => '' });
let bad = 0; let n = 0;
for (const file of files) {
const s = fs.readFileSync(file, 'utf8');
const re = /^(?:const |HUB\.)([A-Z0-9_]+_JS) = /gm;
let m;
while ((m = re.exec(s))) {
  const start = m.index; const i = s.indexOf('`', start); let j = i + 1;
  const stack = ['`'];
  for (; j < s.length && stack.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    const top = stack[stack.length - 1];
    if (top === '`') { if (c === '`') stack.pop(); else if (c === '$' && s[j + 1] === '{') { stack.push('{'); j++; } } else if (c === '{') stack.push('{'); else if (c === '}') stack.pop(); else if (c === '`') stack.push('`');
  }
  const src = s.slice(start, j).replace(/^(?:const |HUB\.)[A-Z0-9_]+_JS = /, '');
  n++;
  try {
    let val = new Function('JSON', 'WORLD_TYPES', 'HUB', 'return ' + src)(JSON, {}, HUB);
    if (typeof val === 'function') { for (const args of [['x', 'y', 'z'], [true], [false]]) new Function('return ' + val(...args)); } else new Function('return ' + val);
  } catch (e) { bad++; console.error(`page script ${m[1]} (${path.basename(file)}): ${e.message}`); }
}
}
const adapter = require(path.join(srcDir, 'game-adapter.js'));
try { new Function('return ' + adapter.SNAPSHOT_JS); n++; } catch (e) { bad++; console.error(`SNAPSHOT_JS: ${e.message}`); }
console.log(`page scripts: ${n} checked, ${bad} broken`);
process.exit(bad ? 1 : 0);
