// Every script main.js sends into a game page is built from a template (const X_JS = `...` or (args) => `...`).
// A wrong escape in one only breaks when it runs in the game, so `node --check` never sees it: build each one
// here and parse what it produces.
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'src', 'main.js');
const s = fs.readFileSync(file, 'utf8');
const re = /^const ([A-Z0-9_]+_JS) = /gm;
let m; let bad = 0; let n = 0;
while ((m = re.exec(s))) {
  const start = m.index; const i = s.indexOf('`', start); let j = i + 1;
  const stack = ['`'];
  for (; j < s.length && stack.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    const top = stack[stack.length - 1];
    if (top === '`') { if (c === '`') stack.pop(); else if (c === '$' && s[j + 1] === '{') { stack.push('{'); j++; } } else if (c === '{') stack.push('{'); else if (c === '}') stack.pop(); else if (c === '`') stack.push('`');
  }
  const src = s.slice(start, j).replace(/^const [A-Z0-9_]+_JS = /, '');
  n++;
  try {
    let val = new Function('JSON', 'WORLD_TYPES', 'return ' + src)(JSON, {});
    if (typeof val === 'function') { for (const args of [['x', 'y', 'z'], [true], [false]]) new Function('return ' + val(...args)); } else new Function('return ' + val);
  } catch (e) { bad++; console.error(`page script ${m[1]}: ${e.message}`); }
}
const adapter = require(path.join(path.dirname(file), 'game-adapter.js'));
try { new Function('return ' + adapter.SNAPSHOT_JS); n++; } catch (e) { bad++; console.error(`SNAPSHOT_JS: ${e.message}`); }
console.log(`page scripts: ${n} checked, ${bad} broken`);
process.exit(bad ? 1 : 0);
