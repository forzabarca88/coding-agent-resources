import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FetchError } from '../src/types';

// ---------------------------------------------------------------------------
// Mock setup — factory form required because vi.mock is hoisted
// vi.mock factories run before any top-level code, so mock functions must
// be defined inside the factory itself.
// ---------------------------------------------------------------------------

vi.mock('undici', () => ({
  fetch: vi.fn(function () {}),
}));

vi.mock('node:dns/promises', () => {
  const mockResolve4 = vi.fn(function () {});
  const mockResolve6 = vi.fn(function () {});
  // Resolver is used with `new` in src/fetcher.ts, so it must be a constructor
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

// Import after mocks are registered
import * as undici from 'undici';
import * as dnsPromises from 'node:dns/promises';
import { fetchPage } from '../src/fetcher';

const mockFetch = (undici as any).fetch;
const mockResolve4 = (dnsPromises as any).__mockResolve4;
const mockResolve6 = (dnsPromises as any).__mockResolve6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock HTTP response object matching what undici returns.
 */
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

  // Build a ReadableStream from the encoded body
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

/**
 * Build a mock redirect response.
 */
function buildMockRedirect(
  status: number = 301,
  location: string = 'https://example.com/new',
  url: string = 'https://example.com/old',
): object {
  return buildMockResponse(status, 'Moved', '', { location }, url);
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockFetch.mockReset();
  mockResolve4.mockReset();
  mockResolve6.mockReset();
  mockResolve4.mockResolvedValue([]);
  mockResolve6.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Successful fetch of valid URLs
// ---------------------------------------------------------------------------

describe('fetchPage — successful fetch', () => {
  it('returns WebPageResult for a valid HTTPS URL', async () => {
    const html = '<html><head><title>Hello</title></head><body><p>World</p></body></html>';
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', html, { 'content-type': 'text/html; charset=utf-8' }),
    );

    const result = await fetchPage('https://example.com/');

    expect(result).toEqual({
      html,
      url: 'https://example.com/',
      title: 'Hello',
      contentType: 'text/html; charset=utf-8',
    });
  });

  it('works with HTTP protocol', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<p>plain html</p>', {}, 'http://example.com/'),
    );

    const result = await fetchPage('http://example.com/');

    expect(result.html).toBe('<p>plain html</p>');
    expect(result.url).toBe('http://example.com/');
    expect(result.title).toBeUndefined();
  });

  it('handles responses without a title tag', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<body><p>No title here</p></body>'),
    );

    const result = await fetchPage('https://example.com/');

    expect(result.title).toBeUndefined();
    expect(result.html).toBe('<body><p>No title here</p></body>');
  });

  it('handles responses without content-type header', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<p>no ct</p>', {}),
    );

    const result = await fetchPage('https://example.com/');

    expect(result.contentType).toBeUndefined();
  });

  it('uses custom options when provided', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<p>custom</p>'),
    );

    const result = await fetchPage('https://example.com/', {
      timeout: 5000,
      maxRedirects: 3,
      maxBodySize: 1024,
    });

    expect(result.html).toBe('<p>custom</p>');
  });
});

// ---------------------------------------------------------------------------
// Timeout on slow responses
// Uses real timers to avoid unhandled rejection warnings from fake timers.
// ---------------------------------------------------------------------------

describe('fetchPage — timeout', () => {
  it('throws FetchError when response takes too long', async () => {
    // Use real timers so the AbortController abort propagates cleanly
    vi.useRealTimers();

    // Mock fetch that resolves after a long delay (longer than the timeout)
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
    mockFetch.mockImplementation((_url: string, init: { signal: any }) => {
      return new Promise((resolve, reject) => {
        // Resolve after 5s (won't happen because timeout fires first)
        pendingTimeout = setTimeout(() => resolve(buildMockResponse()), 5000);
        // Reject when aborted
        init.signal.addEventListener('abort', () => {
          clearTimeout(pendingTimeout!);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    await expect(
      fetchPage('https://example.com/', { timeout: 50 }),
    ).rejects.toThrow(/timed out after 50 ms/);

    vi.useFakeTimers();
  }, 5000);

});

// ---------------------------------------------------------------------------
// SSRF blocking — DNS resolution for domain names
// ---------------------------------------------------------------------------

describe('fetchPage — SSRF via DNS resolution', () => {
  it('blocks domains that resolve to private IPv4', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.5']);
    mockResolve6.mockResolvedValue([]);
    mockFetch.mockResolvedValue(buildMockResponse());

    await expect(
      fetchPage('https://evil.example.com/'),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('https://evil.example.com/'),
    ).rejects.toThrow(/resolves to private IPv4/);
  });

  it('blocks domains that resolve to private IPv6', async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue(['fc00::dead:beef']);
    mockFetch.mockResolvedValue(buildMockResponse());

    await expect(
      fetchPage('https://evil.example.com/'),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('https://evil.example.com/'),
    ).rejects.toThrow(/resolves to private IPv6/);
  });

  it('allows domains that resolve to public IPs', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34']);
    mockResolve6.mockResolvedValue(['2606:2800:220:1:248:1893:25c8:1946']);
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<p>safe</p>'),
    );

    const result = await fetchPage('https://example.com/');
    expect(result.html).toBe('<p>safe</p>');
  });

  it('proceeds when DNS resolution fails (lets HTTP handle the error)', async () => {
    mockResolve4.mockRejectedValue(new Error('DNS resolution failed'));
    mockResolve6.mockResolvedValue([]);
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<p>despite dns</p>'),
    );

    const result = await fetchPage('https://example.com/');
    expect(result.html).toBe('<p>despite dns</p>');
  });

  it('skips DNS resolution for literal IP addresses', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', '<p>ip</p>', {}, 'http://93.184.216.34/'),
    );

    await fetchPage('http://93.184.216.34/');
    expect(mockResolve4).not.toHaveBeenCalled();
    expect(mockResolve6).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Redirect limit enforcement
// ---------------------------------------------------------------------------

describe('fetchPage — redirect handling', () => {
  it('follows a single redirect', async () => {
    mockFetch
      .mockResolvedValueOnce(buildMockRedirect(301, 'https://example.com/new', 'https://example.com/old'))
      .mockResolvedValueOnce(
        buildMockResponse(200, 'OK', '<p>final</p>', {}, 'https://example.com/new'),
      );

    const result = await fetchPage('https://example.com/old');

    expect(result.url).toBe('https://example.com/new');
    expect(result.html).toBe('<p>final</p>');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('follows relative redirect URLs', async () => {
    mockFetch
      .mockResolvedValueOnce(buildMockRedirect(302, '/new-path', 'https://example.com/old'))
      .mockResolvedValueOnce(
        buildMockResponse(200, 'OK', '<p>relative</p>', {}, 'https://example.com/new-path'),
      );

    const result = await fetchPage('https://example.com/old');

    expect(result.url).toBe('https://example.com/new-path');
    expect(result.html).toBe('<p>relative</p>');
  });

  it('throws when redirect limit is exceeded', async () => {
    // Create a chain of 6 redirects (default max is 5)
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce(
        buildMockRedirect(301, `https://example.com/step${i + 1}`, `https://example.com/step${i}`),
      );
    }

    try {
      await fetchPage('https://example.com/step0', { maxRedirects: 5 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/Too many redirects.*limit.*5/);
    }
  });

  it('throws when redirect has no Location header', async () => {
    const resp = buildMockResponse(304, 'Not Modified', '', {}, 'https://example.com/');
    // Override get to return null for 'location'
    (resp.headers as any).get = (name: string) => {
      if (name.toLowerCase() === 'location') return null;
      return null;
    };
    mockFetch.mockResolvedValueOnce(resp);

    try {
      await fetchPage('https://example.com/');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/no Location header/);
    }
  });

  it('validates each redirect target URL', async () => {
    // First request returns redirect to a private IP
    mockFetch.mockResolvedValueOnce(
      buildMockRedirect(301, 'http://127.0.0.1/admin', 'https://example.com/'),
    );

    try {
      await fetchPage('https://example.com/');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/private IPv4/);
    }
  });

  it('handles non-2xx non-redirect responses', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(404, 'Not Found', '<h1>404</h1>'),
    );

    try {
      await fetchPage('https://example.com/missing');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/HTTP 404/);
    }
  });

  it('handles 500 server errors', async () => {
    mockFetch.mockResolvedValue(
      buildMockResponse(500, 'Internal Server Error', '<h1>500</h1>'),
    );

    try {
      await fetchPage('https://example.com/');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/HTTP 500/);
    }
  });
});

// ---------------------------------------------------------------------------
// Oversized response rejection
// ---------------------------------------------------------------------------

describe('fetchPage — oversized response', () => {
  it('rejects body exceeding maxBodySize', async () => {
    // Create a body larger than the 50-byte limit
    const bigBody = 'A'.repeat(100);
    const encoder = new TextEncoder();
    const encoded = encoder.encode(bigBody);

    mockFetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { get: (_n: string) => null },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      }),
      url: 'https://example.com/',
      ok: true,
      redirected: false,
      type: 'basic' as const,
      redirected_count: 0,
    });

    try {
      await fetchPage('https://example.com/', { maxBodySize: 50 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/exceeds maximum allowed size/);
    }
  });

  it('accepts body within maxBodySize', async () => {
    const smallBody = 'A'.repeat(30);
    mockFetch.mockResolvedValue(
      buildMockResponse(200, 'OK', smallBody),
    );

    const result = await fetchPage('https://example.com/', { maxBodySize: 50 });
    expect(result.html).toBe(smallBody);
  });

  it('rejects when body arrives in multiple chunks exceeding limit', async () => {
    // Build a response that sends data in two chunks, each under limit but combined over
    const chunk1 = new TextEncoder().encode('A'.repeat(40));
    const chunk2 = new TextEncoder().encode('B'.repeat(40));

    mockFetch.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: { get: (_n: string) => null },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      }),
      url: 'https://example.com/',
      ok: true,
      redirected: false,
      type: 'basic' as const,
      redirected_count: 0,
    });

    try {
      await fetchPage('https://example.com/', { maxBodySize: 60 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as Error).message).toMatch(/exceeds maximum allowed size/);
    }
  });
});

// ---------------------------------------------------------------------------
// Network error handling
// ---------------------------------------------------------------------------

describe('fetchPage — network errors', () => {
  it('handles DNS resolution failure (ENOTFOUND)', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), {
        name: 'Error',
        code: 'ENOTFOUND',
        errno: 'ENOTFOUND',
        syscall: 'getaddrinfo',
        hostname: 'example.invalid',
      }),
    );

    await expect(
      fetchPage('https://example.invalid/'),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('https://example.invalid/'),
    ).rejects.toThrow(/Network error/);
  });

  it('handles connection refused (ECONNREFUSED)', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:80'), {
        name: 'Error',
        code: 'ECONNREFUSED',
        errno: 'ECONNREFUSED',
        syscall: 'connect',
        address: '93.184.216.34',
        port: 80,
      }),
    );

    await expect(
      fetchPage('http://93.184.216.34/'),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('http://93.184.216.34/'),
    ).rejects.toThrow(/Network error/);
  });

  it('handles connection reset (ECONNRESET)', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('socket hang up'), {
        name: 'Error',
        code: 'ECONNRESET',
        errno: 'ECONNRESET',
        syscall: 'recv',
      }),
    );

    await expect(
      fetchPage('https://example.com/'),
    ).rejects.toThrow(FetchError);
    await expect(
      fetchPage('https://example.com/'),
    ).rejects.toThrow(/Network error/);
  });

  it('wraps unknown errors in FetchError', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      fetchPage('https://example.com/'),
    ).rejects.toThrow(FetchError);
  });

});


