import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  writeToStdout,
  writeToStderr,
  writeToFile,
  output,
  WebPageResult,
} from '../src/output';
import { OutputError } from '../src/types';

// ---------------------------------------------------------------------------
// Mock setup — factory form required because vi.mock is hoisted
// The source code uses `import fs from 'node:fs/promises'` (default import)
// so we must share the SAME mock function between the named export and
// the default export's property.
// ---------------------------------------------------------------------------

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
  };
});

vi.mock('node:path', () => {
  const sep = '/';
  const resolve = vi.fn();
  const dirname = vi.fn();
  return {
    default: { resolve, dirname, sep },
    resolve,
    dirname,
    sep,
  };
});

// Import mocked modules
import * as mockFs from 'node:fs/promises';
import * as mockPath from 'node:path';

// Source code uses default import (fs.mkdir, fs.writeFile), so read from default
const mockMkdir = (mockFs.default as any).mkdir as ReturnType<typeof vi.fn>;
const mockWriteFile = (mockFs.default as any).writeFile as ReturnType<typeof vi.fn>;
const mockResolve = mockPath.resolve as ReturnType<typeof vi.fn>;
const mockDirname = mockPath.dirname as ReturnType<typeof vi.fn>;

// Capture stdout / stderr writes
let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];

function captureStdio() {
  stdoutWrites = [];
  stderrWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string) => {
    stdoutWrites.push(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string) => {
    stderrWrites.push(chunk);
    return true;
  });
}

function restoreStdio() {
  process.stdout.write.mockRestore();
  process.stderr.write.mockRestore();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal WebPageResult for tests.
 */
function buildResult(overrides?: Partial<WebPageResult>): WebPageResult {
  return {
    html: '<html><body><p>Hello</p></body></html>',
    url: 'https://example.com/page',
    title: 'Example Page',
    contentType: 'text/html; charset=utf-8',
    ...overrides,
  };
}

/**
 * Default mock path resolution — resolves relative to cwd.
 */
function mockPathResolve(filePath: string): string {
  if (filePath.startsWith('/')) return filePath;
  return process.cwd() + '/' + filePath;
}

function mockPathDirname(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : '/';
}

/**
 * Configure all path/fs mocks to their default state.
 * Does NOT call vi.resetAllMocks() — that would erase factory-created mocks.
 */
function setupPathMocks() {
  mockResolve.mockImplementation(mockPathResolve);
  mockDirname.mockImplementation(mockPathDirname);
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
}

/**
 * Clear mock call history without resetting implementations.
 */
function clearMockCalls() {
  mockResolve.mockClear();
  mockDirname.mockClear();
  mockMkdir.mockClear();
  mockWriteFile.mockClear();
}

// ---------------------------------------------------------------------------
// writeToStdout
// ---------------------------------------------------------------------------

describe('writeToStdout', () => {
  beforeEach(() => captureStdio());
  afterEach(() => restoreStdio());

  it('writes the content string to process.stdout', () => {
    writeToStdout('Hello world');
    expect(process.stdout.write).toHaveBeenCalledWith('Hello world');
    expect(stdoutWrites).toEqual(['Hello world']);
  });

  it('writes multi-line content', () => {
    writeToStdout('Line 1\nLine 2\nLine 3');
    expect(stdoutWrites).toEqual(['Line 1\nLine 2\nLine 3']);
  });

  it('handles empty string', () => {
    writeToStdout('');
    expect(stdoutWrites).toEqual(['']);
  });
});

// ---------------------------------------------------------------------------
// writeToStderr
// ---------------------------------------------------------------------------

describe('writeToStderr', () => {
  beforeEach(() => captureStdio());
  afterEach(() => restoreStdio());

  it('prepends "Error: " and appends a trailing newline', () => {
    writeToStderr('Something went wrong');
    expect(process.stderr.write).toHaveBeenCalledWith('Error: Something went wrong\n');
    expect(stderrWrites).toEqual(['Error: Something went wrong\n']);
  });

  it('handles empty message', () => {
    writeToStderr('');
    expect(stderrWrites).toEqual(['Error: \n']);
  });
});

// ---------------------------------------------------------------------------
// writeToFile — path validation
// ---------------------------------------------------------------------------

describe('writeToFile — path validation', () => {
  beforeEach(() => {
    setupPathMocks();
    clearMockCalls();
  });

  it('rejects an empty string path', async () => {
    await expect(writeToFile('content', '')).rejects.toThrow(OutputError);
    await expect(writeToFile('content', '')).rejects.toThrow(
      'Output file path must not be empty',
    );
  });

  it('rejects a whitespace-only path', async () => {
    await expect(writeToFile('content', '   ')).rejects.toThrow(OutputError);
    await expect(writeToFile('content', '   ')).rejects.toThrow(
      'Output file path must not be empty',
    );
  });

  it('rejects paths containing null bytes', async () => {
    await expect(writeToFile('content', 'file\0.txt')).rejects.toThrow(OutputError);
    await expect(writeToFile('content', 'file\0.txt')).rejects.toThrow(
      'Output file path must not contain null bytes',
    );
  });

  it('rejects paths that resolve outside the current working directory', async () => {
    // Simulate a traversal path that resolves outside cwd
    mockResolve.mockReturnValue('/tmp/evil.txt');

    await expect(writeToFile('content', '../../../tmp/evil.txt')).rejects.toThrow(OutputError);
    await expect(writeToFile('content', '../../../tmp/evil.txt')).rejects.toThrow(
      /resolves outside the current working directory/,
    );
  });
});



// ---------------------------------------------------------------------------
// output — stdout path
// ---------------------------------------------------------------------------

describe('output — stdout path', () => {
  beforeEach(() => {
    captureStdio();
    setupPathMocks();
    clearMockCalls();
  });
  afterEach(() => restoreStdio());

  it('writes markdown to stdout when no filePath is set', async () => {
    const result = buildResult();
    await output('# Hello', result, { filePath: undefined, pretty: false });

    expect(stdoutWrites).toEqual(['# Hello']);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('uses default options when none provided', async () => {
    const result = buildResult();
    await output('# Hello', result);

    expect(stdoutWrites).toEqual(['# Hello']);
  });

  it('does not prepend header when pretty is false', async () => {
    const result = buildResult();
    await output('# Hello', result, { pretty: false });

    expect(stdoutWrites).toEqual(['# Hello']);
    expect(stdoutWrites[0]).not.toContain('Fetched Web Page');
  });
});

// ---------------------------------------------------------------------------
// output — file path
// ---------------------------------------------------------------------------

describe('output — file path', () => {
  beforeEach(() => {
    captureStdio();
    setupPathMocks();
    clearMockCalls();
  });
  afterEach(() => restoreStdio());

  it('does not write to stdout when filePath is set', async () => {
    const result = buildResult();
    await output('# Hello', result, { filePath: 'output.md', pretty: false });

    expect(stdoutWrites).toEqual([]);
  });

  it('propagates writeToFile errors through output', async () => {
    mockWriteFile.mockRejectedValue(new Error('EIO'));
    const result = buildResult();

    await expect(output('# Hello', result, { filePath: 'bad.txt' })).rejects.toThrow(
      /Failed to write file/,
    );
  });
});

// ---------------------------------------------------------------------------
// output — pretty header formatting
// ---------------------------------------------------------------------------

describe('output — pretty header formatting', () => {
  beforeEach(() => {
    captureStdio();
    setupPathMocks();
    clearMockCalls();
  });
  afterEach(() => restoreStdio());

  it('prepends metadata header when pretty is true (stdout)', async () => {
    const result = buildResult({
      url: 'https://example.com/page',
      title: 'Example Page',
      contentType: 'text/html; charset=utf-8',
    });

    await output('# Hello', result, { pretty: true });

    const fullContent = stdoutWrites[0];
    expect(fullContent).toContain('# Fetched Web Page');
    expect(fullContent).toContain('**Source:** https://example.com/page');
    expect(fullContent).toContain('**Title:** Example Page');
    expect(fullContent).toContain('**Content-Type:** text/html; charset=utf-8');
    expect(fullContent).toContain('**Fetched:**');
    expect(fullContent).toContain('---');
    // Body markdown follows the header
    expect(fullContent).toContain('# Hello');
  });

  it('prepends metadata header when pretty is true (file)', async () => {
    const result = buildResult({
      url: 'https://example.com/page',
      title: 'Example Page',
      contentType: 'text/html; charset=utf-8',
    });

    await output('# Hello', result, { filePath: 'pretty.md', pretty: true });

    const writtenContent = (mockWriteFile.mock.calls[0] as string[])[1];
    expect(writtenContent).toContain('# Fetched Web Page');
    expect(writtenContent).toContain('**Source:** https://example.com/page');
    expect(writtenContent).toContain('**Title:** Example Page');
    expect(writtenContent).toContain('**Fetched:**');
    expect(writtenContent).toContain('---');
    expect(writtenContent).toContain('# Hello');
  });

  it('omits missing metadata fields gracefully', async () => {
    const result = buildResult({
      title: undefined,
      contentType: undefined,
    });

    await output('# Hello', result, { pretty: true });

    const fullContent = stdoutWrites[0];
    expect(fullContent).toContain('# Fetched Web Page');
    expect(fullContent).toContain('**Source:** https://example.com/page');
    expect(fullContent).not.toContain('**Title:**');
    expect(fullContent).not.toContain('**Content-Type:**');
    expect(fullContent).toContain('**Fetched:**');
  });

  it('includes ISO timestamp in header', async () => {
    const result = buildResult();
    await output('# Hello', result, { pretty: true });

    const fullContent = stdoutWrites[0];
    // Extract the timestamp line
    const fetchedLine = fullContent.split('\n').find(line => line.startsWith('**Fetched:**'));
    expect(fetchedLine).toBeDefined();
    // Parse the ISO date — should be valid
    const timestamp = fetchedLine!.replace('**Fetched:** ', '').trim();
    const date = new Date(timestamp);
    expect(date.getTime()).not.toBeNaN();
  });

  it('header is separated from body with horizontal rule', async () => {
    const result = buildResult();
    await output('Body content', result, { pretty: true });

    const fullContent = stdoutWrites[0];
    expect(fullContent).toContain('---');
    // Body content appears after the separator
    const separatorIndex = fullContent.indexOf('---');
    const afterSeparator = fullContent.slice(separatorIndex + 3);
    expect(afterSeparator).toContain('Body content');
  });
});


