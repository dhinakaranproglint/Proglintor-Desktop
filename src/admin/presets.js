'use strict';
// One-click "popular apps" for the catalogue (macOS). Download links and Apple Team IDs follow the vendors' own releases
// (same list SentinelDesk uses). Nothing is trusted blindly: the file is downloaded, its signature is verified, and a download
// signed by anyone other than the expected Team ID is refused.
const PRESETS = [
  { id: 'slack', name: 'Slack', publisher: 'Slack Technologies', description: 'Team chat and calls.', teamId: 'BQR82RBBHL',
    url: 'https://slack.com/api/desktop.latestRelease?redirect=1&variant=dmg&arch=universal', aliases: ['slack desktop'] },
  { id: 'google-chrome', name: 'Google Chrome', publisher: 'Google', description: 'Web browser.', teamId: 'EQHXZ8M8AV',
    url: 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg', aliases: ['chrome'] },
  { id: 'firefox', name: 'Firefox', publisher: 'Mozilla', description: 'Web browser.', teamId: '43AQ936H96',
    url: 'https://download.mozilla.org/?product=firefox-latest&os=osx&lang=en-US', aliases: ['mozilla firefox'] },
  { id: 'zoom', name: 'Zoom', publisher: 'Zoom Video Communications', description: 'Video meetings (IT installer package).', teamId: 'BJ4HAAB9B3',
    url: 'https://zoom.us/client/latest/ZoomInstallerIT.pkg', aliases: ['zoom meetings'] },
  { id: 'visual-studio-code', name: 'Visual Studio Code', publisher: 'Microsoft', description: 'Code editor.', teamId: 'UBF8T346G9',
    url: 'https://update.code.visualstudio.com/latest/darwin-universal/stable', aliases: ['vs code', 'vscode', 'code'] },
];

const byId = (id) => PRESETS.find((p) => p.id === id) || null;
const listPresets = () => PRESETS.map(({ id, name, publisher, description }) => ({ id, name, publisher, description }));

module.exports = { PRESETS, byId, listPresets };
