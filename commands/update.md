---
description: Migrate or repair the statusLine resolver for self-healing operation
allowed-tools: Read, Write, Bash(node:*), Bash(ls:*), Bash(grep:*), Bash(cat:*)
---

# Claude Dashboard Update (Migration / Repair)

As of the self-healing setup, `/claude-dashboard:update` is **no longer required after normal
plugin updates**. The resolver at `~/.claude/claude-dashboard-statusline.mjs` automatically
finds the latest cached version at runtime.

Run this command only if:
- You installed claude-dashboard with an **older setup** (pre-resolver) and want to migrate, or
- The statusLine appears broken and you want to repair the resolver.

## Task

### 1. Check the current statusLine.command

```bash
node -e "
const fs = require('fs'), os = require('os'), path = require('path');
const p = path.join(os.homedir(), '.claude', 'settings.json');
if (!fs.existsSync(p)) {
  console.error('settings.json not found — run /claude-dashboard:setup first');
  process.exit(1);
}
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const cmd = s?.statusLine?.command;
if (!cmd) {
  console.error('statusLine.command not set — run /claude-dashboard:setup first');
  process.exit(1);
}
console.log('Current command:', cmd);
"
```

If the command above exits with an error, stop here and run `/claude-dashboard:setup` instead.

### 2. Determine migration need

- If the command contains `claude-dashboard-statusline.mjs` → **already self-healing, skip to step 4**
- If the command points directly to a versioned `dist/index.js` → **needs migration, continue**

### 3. (Re)install the resolver

Copy the resolver from the plugin cache to the stable home path.

```bash
node -e "
const fs = require('fs'), os = require('os'), path = require('path');
const cacheBase = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'claude-dashboard', 'claude-dashboard');
// 최신 semver 버전 디렉터리 탐색
const dirs = fs.existsSync(cacheBase)
  ? fs.readdirSync(cacheBase, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
  : [];
const ver = dirs[0];
if (!ver) {
  console.error('Run /plugin update claude-dashboard to the latest version, then re-run this command (self-healing resolver ships in newer versions)');
  process.exit(1);
}
const src = path.join(cacheBase, ver, 'scripts', 'statusline-resolver.mjs');
if (!fs.existsSync(src)) {
  console.error('Run /plugin update claude-dashboard to the latest version, then re-run this command (self-healing resolver ships in newer versions)');
  process.exit(1);
}
const dst = path.join(os.homedir(), '.claude', 'claude-dashboard-statusline.mjs');
fs.copyFileSync(src, dst);
console.log('Resolver installed from v' + ver + ' →', dst);
"
```

### 4. Update settings.json to point at the resolver

```bash
node -e "
const fs = require('fs'), os = require('os'), path = require('path');
const p = path.join(os.homedir(), '.claude', 'settings.json');
const resolver = path.join(os.homedir(), '.claude', 'claude-dashboard-statusline.mjs');
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
const prev = s?.statusLine?.command ?? '(none)';
s.statusLine = s.statusLine || {};
s.statusLine.type = 'command';
s.statusLine.command = 'node \"' + resolver + '\"';
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('Previous command:', prev);
console.log('New command:     ', s.statusLine.command);
"
```

### 5. Verify

```bash
ls ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/
```

Show the user:
- Previous command → new resolver command
- Detected plugin versions in cache
- "Self-healing active: plugin updates no longer require /claude-dashboard:update"

## Example Output

```
Previous command: node ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/1.7.0/dist/index.js
New command:      node "/Users/you/.claude/claude-dashboard-statusline.mjs"

Plugin versions in cache: 1.7.0  1.29.0

Self-healing active: plugin updates no longer require /claude-dashboard:update.
```
