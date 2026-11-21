'use strict';
// Starts the development agent automatically at every login (macOS), so it is already running, and greets you, when you open your laptop.
// The installed (packaged) agent does this by itself; this is the same thing for `npm run agent`.
//   npm run autostart:on       start the agent at login (and now)
//   npm run autostart:off      stop doing that
//   npm run autostart:status   is it on?
// It writes one file: ~/Library/LaunchAgents/com.proglint.proglintor.agent.dev.plist
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'com.proglint.proglintor.agent.dev';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd job: run the dev launcher hidden at login; restart it if it crashes, but not when it exits normally (e.g. already running). */
function buildPlist({ node, root, server = '', home = os.homedir() }) {
  const env = [`<key>PATH</key><string>${esc(`${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`)}</string>`];
  if (server) env.push(`<key>PROGLINTOR_SERVER</key><string>${esc(server)}</string>`);
  const log = path.join(home, 'Library', 'Logs', 'Proglintor-agent-dev.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(path.join(root, 'scripts', 'dev.js'))}</string><string>agent</string><string>--hidden</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key><dict>${env.join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid()}`;
const launchctl = (...args) => execFileSync('launchctl', args, { stdio: 'pipe' }).toString();
const loaded = () => { try { launchctl('print', `${domain()}/${LABEL}`); return true; } catch { return false; } };

function on({ print = false } = {}) {
  const plist = buildPlist({ node: process.execPath, root: path.join(__dirname, '..'), server: process.env.PROGLINTOR_SERVER || '' });
  if (print) { process.stdout.write(plist); return 0; }
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist);
  if (loaded()) { try { launchctl('bootout', `${domain()}/${LABEL}`); } catch { /* already gone */ } }
  launchctl('bootstrap', domain(), plistPath());
  console.log('The agent will now start by itself every time you log in, and it is starting now.');
  console.log('Turn it off any time with: npm run autostart:off');
  return 0;
}

function off() {
  if (loaded()) { try { launchctl('bootout', `${domain()}/${LABEL}`); } catch { /* already gone */ } }
  if (fs.existsSync(plistPath())) fs.unlinkSync(plistPath());
  console.log('Automatic start at login is off. (A running agent keeps running until you quit it.)');
  return 0;
}

function status() {
  const there = fs.existsSync(plistPath());
  console.log(`Start at login: ${there ? 'ON' : 'off'}${there ? (loaded() ? ' (registered with macOS)' : ' (file present; will register at next login)') : ''}`);
  return 0;
}

if (require.main === module) {
  if (process.platform !== 'darwin') {
    console.error('This helper is for macOS. On Windows and Linux the installed agent registers itself to start at login.');
    process.exit(1);
  }
  const cmd = process.argv[2];
  const run = { on, off, status }[cmd];
  if (!run) { console.error('Usage: node scripts/autostart.js on|off|status   (on --print shows what it would write)'); process.exit(1); }
  try { process.exit(run({ print: process.argv.includes('--print') })); } catch (err) { console.error(`Could not do that: ${err.message}`); process.exit(1); }
}

module.exports = { buildPlist, LABEL };
