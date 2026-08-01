import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

let server: http.Server;
let serverUrl: string;

const MOCK_HTML =
  '<html><head><title>Smoke Test Page</title></head><body>' +
  '<h1>Hello from Mock Server</h1>' +
  '<p>This is a paragraph for testing.</p>' +
  '<a href="https://example.com/">A test link</a>' +
  '</body></html>';

function startMockServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(MOCK_HTML);
    });

    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr !== 'number') {
        // IPv6 addresses in URLs must be wrapped in brackets
        const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
        serverUrl = `http://${host}:${addr.port}/`;
      } else if (typeof addr === 'number') {
        serverUrl = `http://127.0.0.1:${addr}/`;
      } else {
        reject(new Error('Could not determine server address'));
        return;
      }
      resolve(serverUrl);
    });

    server.on('error', reject);
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// SSRF reachability check
// ---------------------------------------------------------------------------

/**
 * Check if a URL would pass the fetcher's SSRF protection.
 * Returns false if the URL uses a private IP address.
 */
function isServerReachable(url: string): boolean {
  // Check for private IPv4 ranges
  if (url.includes('127.') || url.includes('10.') || url.includes('192.168.') || url.includes('169.254.')) {
    return false;
  }
  // Check for 172.16-31.x.x (Class B private)
  if (/172\.(1[6-9]|2\d|3[01])\./.test(url)) {
    return false;
  }
  // Check for private IPv6 addresses
  if (url.includes('[::1]') || url.includes('[::]') || url.includes(':::')) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Temp directory for file output tests
// ---------------------------------------------------------------------------

let tempDir: string | null = null;

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-agent-cli-test-'));
  tempDir = dir;
  return dir;
}

async function cleanupTempDir() {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    tempDir = null;
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  serverUrl = await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
});

// ---------------------------------------------------------------------------
// Helper: run the CLI and return the result
// ---------------------------------------------------------------------------

async function runCli(...args: string[]) {
  return execa('node', [CLI, ...args], {
    cwd: path.resolve(__dirname, '..'),
    timeout: 15_000,
    reject: false, // Don't throw on non-zero exit — we test exit codes
  });
}

// ---------------------------------------------------------------------------
// 1. --help flag
// ---------------------------------------------------------------------------

describe('CLI --help', () => {
  it('displays help text and exits with code 0', async () => {
    const { stdout, stderr, exitCode } = await runCli('--help');

    expect(exitCode).toBe(0);

    // Help text goes to stdout with commander's exitOverride
    expect(stdout).toContain('web-agent');
    expect(stdout).toContain('Fetch a web page');
    expect(stdout).toContain('sanitize');
    expect(stdout).toContain('markdown');

    // Help should describe available options
    expect(stdout).toContain('-o, --output');
    expect(stdout).toContain('-t, --timeout');
    expect(stdout).toContain('-s, --max-size');
    expect(stdout).toContain('-r, --max-redirects');
    expect(stdout).toContain('--no-images');
    expect(stdout).toContain('--pretty');

    // No error output on help
    expect(stderr).toBe('');
  });

  it('works with -h shorthand', async () => {
    const { stdout, exitCode } = await runCli('-h');

    expect(exitCode).toBe(0);
    expect(stdout).toContain('web-agent');
    expect(stdout).toContain('--output');
  });
});

// ---------------------------------------------------------------------------
// 2. --version flag
// ---------------------------------------------------------------------------

describe('CLI --version', () => {
  it('displays version and exits with code 0', async () => {
    const { stdout, stderr, exitCode } = await runCli('--version');

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
    expect(stderr).toBe('');
  });

  it('works with -v shorthand', async () => {
    const { stdout, stderr, exitCode } = await runCli('-v');

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
    expect(stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. Missing URL argument
// ---------------------------------------------------------------------------

describe('CLI — missing URL argument', () => {
  it('prints error to stderr and exits with non-zero code', async () => {
    const { stdout, stderr, exitCode } = await runCli();

    expect(exitCode).not.toBe(0);

    // Commander prints the error + usage to stderr when URL is missing
    expect(stderr).toMatch(/argument|url|URL/i);

    // Nothing on stdout for error cases
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid URL
// ---------------------------------------------------------------------------

describe('CLI — invalid URL', () => {
  it('prints error to stderr and exits with non-zero code for malformed URL', async () => {
    const { stdout, stderr, exitCode } = await runCli('not-a-valid-url');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Invalid URL|error|Error/i);
    expect(stdout).toBe('');
  });

  it('prints error to stderr and exits with non-zero code for disallowed protocol', async () => {
    const { stdout, stderr, exitCode } = await runCli('file:///etc/passwd');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Protocol.*not allowed|error|Error/i);
    expect(stdout).toBe('');
  });

  it('prints error to stderr and exits with non-zero code for javascript: URI', async () => {
    const { stdout, stderr, exitCode } = await runCli('javascript:alert(1)');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Protocol.*not allowed|Invalid URL|error|Error/i);
    expect(stdout).toBe('');
  });

  it('prints error to stderr and exits with non-zero code for ftp: protocol', async () => {
    const { stdout, stderr, exitCode } = await runCli('ftp://example.com/file.txt');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Protocol.*not allowed|error|Error/i);
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. SSRF protection (private IP blocking)
// ---------------------------------------------------------------------------

describe('CLI — SSRF protection', () => {
  it('blocks private IPv4 127.0.0.1', async () => {
    const { stdout, stderr, exitCode } = await runCli('http://127.0.0.1/');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/private|Blocked/i);
    expect(stdout).toBe('');
  });

  it('blocks private IPv4 192.168.x.x', async () => {
    const { stdout, stderr, exitCode } = await runCli('http://192.168.1.1/');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/private|Blocked/i);
    expect(stdout).toBe('');
  });

  it('blocks private IPv4 10.x.x.x', async () => {
    const { stdout, stderr, exitCode } = await runCli('http://10.0.0.1/');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/private|Blocked/i);
    expect(stdout).toBe('');
  });

  it('blocks link-local 169.254.x.x', async () => {
    const { stdout, stderr, exitCode } = await runCli('http://169.254.169.254/');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/private|Blocked/i);
    expect(stdout).toBe('');
  });

  it('blocks IPv6 loopback ::1', async () => {
    const { stdout, stderr, exitCode } = await runCli('http://[::1]/');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/private|Blocked/i);
    expect(stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. Successful conversion to stdout (requires reachable server)
// ---------------------------------------------------------------------------

describe('CLI — successful conversion to stdout', () => {
  it('converts HTML page to markdown and writes to stdout', async () => {
    if (!isServerReachable(serverUrl)) {
      return;
    }

    const { stdout, stderr, exitCode } = await runCli(serverUrl);

    expect(exitCode).toBe(0);

    // Progress messages go to stderr
    expect(stderr).toContain('Fetching URL');
    expect(stderr).toContain('Sanitizing');
    expect(stderr).toContain('Converting to markdown');
    expect(stderr).toContain('Writing to stdout');

    // Stdout should contain the converted markdown
    expect(stdout).toContain('# Hello from Mock Server');
    expect(stdout).toContain('This is a paragraph for testing.');
    expect(stdout).toContain('[A test link](https://example.com/)');
  }, 15000);

  it('respects --pretty flag (adds metadata header)', async () => {
    if (!isServerReachable(serverUrl)) {
      return;
    }

    const { stdout, exitCode } = await runCli(serverUrl, '--pretty');

    expect(exitCode).toBe(0);

    // Pretty header should be present
    expect(stdout).toContain('# Fetched Web Page');
    expect(stdout).toContain('**Source:**');
    expect(stdout).toContain('**Title:** Smoke Test Page');
    expect(stdout).toContain('**Content-Type:**');
    expect(stdout).toContain('**Fetched:**');
    expect(stdout).toContain('---');

    // Body markdown should follow
    expect(stdout).toContain('# Hello from Mock Server');
  }, 15000);

  it('respects --no-images flag', async () => {
    if (!isServerReachable(serverUrl)) {
      return;
    }

    // Serve HTML with an image
    const imgHtml =
      '<html><head><title>Image Test</title></head><body>' +
      '<p>Text <img src="https://example.com/img.png" alt="A photo"> more text</p>' +
      '</body></html>';

    const oneShot = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(imgHtml);
    });

    await new Promise<void>((resolve) => {
      oneShot.listen(0, async () => {
        const addr = oneShot.address();
        if (addr && typeof addr !== 'number') {
          const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
          const url = `http://${host}:${addr.port}/`;
          if (!isServerReachable(url)) {
            oneShot.close(() => resolve());
            return;
          }

          const result = await runCli(url, '--no-images');
          oneShot.close(() => resolve());
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain('A photo');
          expect(result.stdout).not.toContain('[A photo](https://example.com/img.png)');
          expect(result.stdout).not.toContain('img.png');
        } else {
          oneShot.close(() => resolve());
        }
      });
    });
  }, 15000);
});

// ---------------------------------------------------------------------------
// 7. Successful conversion to file (requires reachable server)
// ---------------------------------------------------------------------------

describe('CLI — successful conversion to file', () => {
  let localTempDir: string | null = null;

  beforeEach(async () => {
    localTempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  it('creates output file with correct markdown content', async () => {
    if (!isServerReachable(serverUrl) || !localTempDir) {
      return;
    }

    const outputFile = path.join(localTempDir, 'output.md');

    const { stdout, stderr, exitCode } = await runCli(serverUrl, '-o', outputFile);

    expect(exitCode).toBe(0);

    // Stdout should be empty (output goes to file)
    expect(stdout).toBe('');

    // Stderr should confirm file was written
    expect(stderr).toContain(`Output written to ${outputFile}`);

    // File should exist with correct content
    const content = await fs.readFile(outputFile, 'utf-8');
    expect(content).toContain('# Hello from Mock Server');
    expect(content).toContain('This is a paragraph for testing.');
    expect(content).toContain('[A test link](https://example.com/)');

    // No pretty header (not requested)
    expect(content).not.toContain('# Fetched Web Page');
  }, 15000);

  it('creates file with pretty header when --pretty is used', async () => {
    if (!isServerReachable(serverUrl) || !localTempDir) {
      return;
    }

    const outputFile = path.join(localTempDir, 'pretty.md');

    const { exitCode } = await runCli(serverUrl, '-o', outputFile, '--pretty');

    expect(exitCode).toBe(0);

    const content = await fs.readFile(outputFile, 'utf-8');
    expect(content).toContain('# Fetched Web Page');
    expect(content).toContain('**Source:**');
    expect(content).toContain('**Title:** Smoke Test Page');
    expect(content).toContain('---');
    expect(content).toContain('# Hello from Mock Server');
  }, 15000);

  it('creates nested directories automatically', async () => {
    if (!isServerReachable(serverUrl) || !localTempDir) {
      return;
    }

    const outputFile = path.join(localTempDir, 'sub', 'deep', 'nested.md');

    const { exitCode } = await runCli(serverUrl, '-o', outputFile);

    expect(exitCode).toBe(0);

    const content = await fs.readFile(outputFile, 'utf-8');
    expect(content).toContain('# Hello from Mock Server');
  }, 15000);

  it('respects custom timeout flag', async () => {
    if (!isServerReachable(serverUrl) || !localTempDir) {
      return;
    }

    const outputFile = path.join(localTempDir, 'timeout-test.md');

    const { exitCode } = await runCli(serverUrl, '-o', outputFile, '-t', '30000');

    expect(exitCode).toBe(0);

    const content = await fs.readFile(outputFile, 'utf-8');
    expect(content).toContain('# Hello from Mock Server');
  }, 15000);
});

// ---------------------------------------------------------------------------
// 8. Error handling in CLI
// ---------------------------------------------------------------------------

describe('CLI — error handling', () => {
  it('exits with non-zero code when server is unreachable', async () => {
    // Use a URL that will fail (non-existent port on a public-looking IP)
    const { stdout, stderr, exitCode } = await runCli('http://198.51.100.1:1/');

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Network error|error|Error/i);
    expect(stdout).toBe('');
  }, 15000);

  it('exits with non-zero code for HTTP error status', async () => {
    // Create a server that returns 404
    const errServer = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>Not Found</h1>');
    });

    await new Promise<void>((resolve) => {
      errServer.listen(0, async () => {
        const addr = errServer.address();
        if (addr && typeof addr !== 'number') {
          const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
          const url = `http://${host}:${addr.port}/`;

          if (!isServerReachable(url)) {
            errServer.close(() => resolve());
            return;
          }

          const result = await runCli(url);
          errServer.close(() => resolve());
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toMatch(/HTTP 404/i);
          expect(result.stdout).toBe('');
        } else {
          errServer.close(() => resolve());
        }
      });
    });
  }, 15000);
});
