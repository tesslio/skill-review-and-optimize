import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export async function installTessl(): Promise<void> {
  const which = Bun.spawnSync(['which', 'tessl']);
  if (which.exitCode === 0) {
    console.log('tessl CLI already installed');
  } else {
    console.log('Installing tessl CLI...');
    const proc = Bun.spawn(
      ['sh', '-c', 'curl -fsSL https://get.tessl.io | sh'],
      {
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to install tessl CLI (exit code ${exitCode})`);
    }

    console.log('tessl CLI installed successfully');
  }

  // Write API token as credentials if provided (enables optimize in CI)
  const token = process.env.TESSL_API_TOKEN;
  if (token) {
    const tesslDir = join(homedir(), '.tessl');
    mkdirSync(tesslDir, { recursive: true });
    const credPath = join(tesslDir, 'api-credentials.json');
    await Bun.write(credPath, JSON.stringify({
      accessToken: token,
    }));
    console.log('Tessl API token configured');
  }
}
