'use strict';
// Weekend work policy shared by the admin server and the agent.

/** App names or ids that count as development tools (case-insensitive). */
const DEFAULT_DEV_TOOLS = [
  // Editors & IDEs
  'Visual Studio Code', 'com.microsoft.VSCode', 'code', 'code.exe', 'Cursor', 'Xcode', 'Android Studio',
  'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'GoLand', 'PhpStorm', 'Rider', 'CLion', 'DataGrip', 'RubyMine',
  'Visual Studio', 'devenv.exe', 'Eclipse', 'NetBeans', 'Sublime Text', 'Zed', 'Fleet', 'Nova', 'Atom',
  // Terminals
  'Terminal', 'com.apple.Terminal', 'iTerm', 'Warp', 'Alacritty', 'kitty', 'Hyper', 'WindowsTerminal.exe',
  'powershell.exe', 'cmd.exe', 'gnome-terminal-server', 'konsole', 'tilix',
  // Dev utilities
  'Postman', 'Insomnia', 'Docker', 'Docker Desktop', 'GitHub Desktop', 'Sourcetree', 'Fork', 'GitKraken',
  'pgAdmin', 'DBeaver', 'TablePlus', 'MongoDB Compass', 'Sequel Ace', 'Beekeeper Studio',
];

const DEFAULT_REASONS = [
  'Urgent production issue',
  'Project deadline',
  'Approved by my manager',
  'Learning or personal project',
  'Other',
];

const DEFAULT_POLICY = {
  weekendCheck: true,
  weekendDays: [0, 6], // Sunday, Saturday
  devTools: DEFAULT_DEV_TOOLS,
  reasons: DEFAULT_REASONS,
  message: 'Proglint encourages a healthy work–life balance. Weekend work should be urgent or approved by your manager. Please tell us why you are working today — your answer is shared with your Proglint admin.',
};

function normalizePolicy(p) {
  const src = p && typeof p === 'object' ? p : {};
  const days = Array.isArray(src.weekendDays) ? src.weekendDays.map(Number).filter((d) => d >= 0 && d <= 6) : DEFAULT_POLICY.weekendDays;
  const list = (v, def) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : def);
  return {
    weekendCheck: src.weekendCheck !== false,
    weekendDays: [...new Set(days)].sort(),
    devTools: list(src.devTools, DEFAULT_POLICY.devTools),
    reasons: list(src.reasons, DEFAULT_POLICY.reasons).length ? list(src.reasons, DEFAULT_POLICY.reasons) : DEFAULT_REASONS,
    message: typeof src.message === 'string' && src.message.trim() ? src.message.trim() : DEFAULT_POLICY.message,
  };
}

/**
 * True when the app matches a dev-tool pattern: exact match on name or id, or (for
 * patterns of 5+ characters) contained in the name or id.
 */
function isDevTool(app, patterns) {
  if (!app) return false;
  const name = String(app.name || '').toLowerCase();
  const id = String(app.id || '').toLowerCase();
  return patterns.some((raw) => {
    const p = String(raw).toLowerCase();
    if (!p) return false;
    if (p === name || p === id) return true;
    return p.length >= 5 && (name.includes(p) || id.includes(p));
  });
}

function isWeekend(ts, days) {
  return days.includes(new Date(ts).getDay());
}

module.exports = { DEFAULT_POLICY, DEFAULT_DEV_TOOLS, DEFAULT_REASONS, normalizePolicy, isDevTool, isWeekend };
