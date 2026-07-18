import { describe, expect, it } from 'vitest';
import {
  type ServiceSpec,
  renderLaunchdPlist,
  renderSystemdUnit,
} from '../../src/infrastructure/service/install.js';

const spec: ServiceSpec = {
  label: 'com.librarian.daemon',
  nodePath: '/usr/local/bin/node',
  scriptPath: '/opt/librarian/dist/main/cli.js',
  args: ['--port', '7801'],
  logFile: '/home/me/.librarian/librarian.log',
};

describe('service unit rendering', () => {
  it('launchd plist carries the label, program args, keepalive, and log path', () => {
    const p = renderLaunchdPlist(spec);
    expect(p).toContain('<string>com.librarian.daemon</string>');
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/opt/librarian/dist/main/cli.js</string>');
    expect(p).toContain('<string>--port</string>');
    expect(p).toContain('<key>KeepAlive</key><true/>');
    expect(p).toContain('<key>RunAtLoad</key><true/>');
    expect(p).toContain('librarian.log');
  });

  it('systemd unit runs the daemon and restarts always', () => {
    const u = renderSystemdUnit(spec);
    expect(u).toContain(
      'ExecStart=/usr/local/bin/node /opt/librarian/dist/main/cli.js --port 7801',
    );
    expect(u).toContain('Restart=always');
    expect(u).toContain('WantedBy=default.target');
  });
});
