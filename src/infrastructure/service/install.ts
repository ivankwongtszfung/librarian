// Registers the daemon as a per-user background service so it starts at login
// and restarts on crash — the difference between "a script I run in a terminal"
// and "a tool." launchd on macOS, systemd --user on Linux. The render functions
// are pure (and tested); install/uninstall are the side-effectful wrappers.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SERVICE_LABEL = 'com.librarian.daemon';

export interface ServiceSpec {
  label: string;
  /** The node binary and the daemon entry the service should run. */
  nodePath: string;
  scriptPath: string;
  /** Daemon flags to persist (e.g. --port 7801). */
  args: string[];
  /** Where stdout/stderr are captured. */
  logFile: string;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderLaunchdPlist(s: ServiceSpec): string {
  const argsXml = [s.nodePath, s.scriptPath, ...s.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${s.label}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(s.logFile)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(s.logFile)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(s: ServiceSpec): string {
  const exec = [s.nodePath, s.scriptPath, ...s.args]
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(' ');
  return `[Unit]
Description=Librarian decision-library daemon
After=network.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export interface InstallResult {
  platform: NodeJS.Platform;
  path: string;
}

export function installService(s: ServiceSpec): InstallResult {
  if (process.platform === 'darwin') {
    const dir = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${s.label}.plist`);
    writeFileSync(path, renderLaunchdPlist(s));
    // Reload cleanly if it was already loaded.
    try {
      execFileSync('launchctl', ['unload', path], { stdio: 'ignore' });
    } catch {
      /* not previously loaded */
    }
    execFileSync('launchctl', ['load', path]);
    return { platform: 'darwin', path };
  }
  if (process.platform === 'linux') {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'librarian.service');
    writeFileSync(path, renderSystemdUnit(s));
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', 'librarian.service']);
    return { platform: 'linux', path };
  }
  throw new Error(`librarian install: unsupported platform "${process.platform}"`);
}

export function uninstallService(label = SERVICE_LABEL): void {
  if (process.platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    try {
      execFileSync('launchctl', ['unload', path], { stdio: 'ignore' });
    } catch {
      /* already unloaded */
    }
    rmSync(path, { force: true });
    return;
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', 'librarian.service'], {
        stdio: 'ignore',
      });
    } catch {
      /* already disabled */
    }
    rmSync(join(homedir(), '.config', 'systemd', 'user', 'librarian.service'), { force: true });
  }
}
