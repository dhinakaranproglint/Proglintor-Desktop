'use strict';
// Development launcher:  node scripts/dev.js agent|admin
// On macOS the app name, Dock label and icon come from the Electron program's bundle, so this makes a local copy
// named "Proglintor" / "Proglintor Admin" with the right icon (cached in ./.dev, rebuilt when Electron updates).
// It also clears ELECTRON_RUN_AS_NODE, which VS Code's terminal sets and which breaks Electron.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const which = process.argv[2];
const APPS = {
  agent: { entry: 'src/agent/main.js', name: 'Proglintor', id: 'com.proglint.proglintor.agent.dev', icon: 'agent.icns' },
  admin: { entry: 'src/admin/main.js', name: 'Proglintor Admin', id: 'com.proglint.proglintor.admin.dev', icon: 'admin.icns' },
};
const app = APPS[which];
if (!app) { console.error('Usage: node scripts/dev.js agent|admin'); process.exit(1); }

const root = path.join(__dirname, '..');
let electron = require('electron'); // path to the Electron binary

function brandedCopy() {
  const srcApp = path.resolve(electron, '..', '..', '..'); // .../dist/Electron.app
  const dest = path.join(root, '.dev', `${app.name}.app`);
  const stamp = path.join(root, '.dev', `${app.name}.stamp`);
  const version = require('electron/package.json').version;
  const current = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
  if (!fs.existsSync(dest) || current !== version) {
    console.log(`Preparing ${app.name}.app for development (first run only)…`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { execFileSync('cp', ['-Rc', srcApp, dest]); } catch { execFileSync('cp', ['-R', srcApp, dest]); } // clone on APFS, else copy
    const plist = path.join(dest, 'Contents', 'Info.plist');
    for (const [key, value] of [['CFBundleName', app.name], ['CFBundleDisplayName', app.name], ['CFBundleIdentifier', app.id]]) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist]);
    }
    fs.copyFileSync(path.join(root, 'assets', 'icons', app.icon), path.join(dest, 'Contents', 'Resources', 'electron.icns'));
    try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', dest], { stdio: 'ignore' }); } catch { /* unsigned copies still run locally */ }
    fs.writeFileSync(stamp, version);
  }
  return path.join(dest, 'Contents', 'MacOS', 'Electron');
}

if (process.platform === 'darwin') electron = brandedCopy();

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(root, app.entry), ...process.argv.slice(3)], { cwd: root, stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
