# web-agent

A secure CLI tool that fetches a web page, sanitizes it against malicious content, converts it to native markdown, and outputs to stdout or a file.

## Installation

```bash
npm install
```

Build the project:

```bash
npm run build
```

## Usage

### Basic usage

Fetch a web page and print the resulting markdown to stdout:

```bash
npx web-agent https://example.com
```

### CLI flags

| Flag | Description | Default |
|---|---|---|
| `<url>` | URL of the web page to fetch (required positional argument) | — |
| `-o, --output <file>` | Write output to the given file instead of stdout | stdout |
| `-t, --timeout <ms>` | Request timeout in milliseconds | `15000` |
| `-s, --max-size <bytes>` | Maximum response body size in bytes | `5242880` (5 MB) |
| `-r, --max-redirects <count>` | Maximum number of redirects to follow | `5` |
| `--no-images` | Strip images from the output | `false` |
| `--pretty` | Add a metadata header (source URL, title, content type, timestamp) to output | `false` |
| `-v, --version` | Print the current version | — |
| `-h, --help` | Display help information | — |

### Examples

**Fetch and print to stdout:**

```bash
npx web-agent https://example.com
```

**Write to a file:**

```bash
npx web-agent https://example.com -o page.md
```

**Write to a file with pretty formatting:**

```bash
npx web-agent https://example.com -o page.md --pretty
```

**Strip images from output:**

```bash
npx web-agent https://example.com --no-images
```

**Custom timeout and redirect limit:**

```bash
npx web-agent https://example.com -t 30000 -r 3
```

**Limit response body size to 1 MB:**

```bash
npx web-agent https://example.com -s 1048576
```

**Combine multiple flags:**

```bash
npx web-agent https://example.com -o output.md --pretty -t 10000 --no-images
```

### Using the built binary

After building, the `web-agent` binary is available via `npx`:

```bash
npm run build
npx web-agent https://example.com
```

Or invoke directly:

```bash
node dist/index.js https://example.com
```

### Development mode

Run directly from TypeScript sources without building:

```bash
npm run dev -- https://example.com
```

## Security Features

web-agent applies multiple layers of security to protect against common web-based attacks:

### SSRF Protection

Server-Side Request Forgery (SSRF) is prevented through:

- **Protocol allowlisting** — Only `http:` and `https:` protocols are accepted. Protocols like `file:`, `ftp:`, and `gopher:` are rejected.
- **Private IP blocking** — Requests targeting private or link-local IP addresses are rejected, including:
  - IPv4: `10.0.0.0/8`, `127.0.0.0/8`, `192.168.0.0/16`, `172.16.0.0/12`, `169.254.0.0/16`, `0.0.0.0`, multicast (`224.0.0.0/4`), and reserved (`240.0.0.0/4`) ranges.
  - IPv6: `::1` (loopback), `::` (unspecified), `fc00::/7` (unique-local), and `fe80::/10` (link-local).
- **DNS resolution validation** — Domain names are resolved via DNS before fetching. If any resolved IP falls into a private range, the request is blocked. This prevents DNS rebinding attacks.

### XSS Prevention

Cross-site scripting (XSS) vectors are neutralized through:

- **Tag allowlisting** — Only a curated set of safe HTML tags is preserved. Tags like `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, and `<input>` are removed entirely.
- **Attribute allowlisting** — Each allowed tag has a strict list of permitted attributes. All other attributes are stripped.
- **Event handler removal** — All `on*` attributes (`onclick`, `onerror`, `onload`, etc.) are blocked regardless of the tag.
- **Protocol sanitization** — URI values in `href` and `src` attributes are validated against an allowlist (`http`, `https`, `mailto`). Dangerous schemes like `javascript:`, `data:`, and `vbscript:` are stripped. Obfuscation via whitespace, control characters, and BOM injection is detected and blocked.

### Redirect Abuse Prevention

- **Manual redirect handling** — Redirects are followed manually (not delegated to the fetcher) so each hop can be validated independently.
- **Redirect target validation** — Every redirect destination is checked against the protocol allowlist and private IP rules.
- **Maximum redirect count** — A configurable limit (default: 5) prevents infinite redirect loops and abuse.

### Oversized Response Guards

- **Body size limit** — The response body is streamed and accumulated with a configurable byte limit (default: 5 MB). If the limit is exceeded, the fetch is aborted and an error is raised.
- **Timeout enforcement** — A configurable timeout (default: 15 seconds) prevents hanging connections. An `AbortController` cancels the request if the timeout is reached.

### Additional Protections

- **CSS expression attack prevention** — Dangerous CSS constructs like `expression()`, `-moz-binding()`, and `url(javascript:)` are stripped from `style` attributes.
- **Data URI blocking** — `data:` URIs are blocked in both `href` and `src` attributes to prevent inline payload injection.
- **HTML comment stripping** — All HTML comments are removed to prevent information leakage or obfuscation.
- **Directory traversal guard** — Output file paths are resolved and validated to ensure they stay within the current working directory, preventing writes to arbitrary filesystem locations.
- **Null byte injection prevention** — Output paths containing null bytes are rejected.

## Architecture

web-agent processes each page through a four-stage pipeline:

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌──────────┐
│  Fetch   │ ──► │ Sanitize  │ ──► │ Convert  │ ──► │  Output  │
│          │     │           │     │          │     │          │
│ Download │     │ Strip     │     │ HTML →   │     │ Write to │
│ HTML     │     │ dangerous │     │ Markdown │     │ stdout / │
│          │     │ content   │     │          │     │ file      │
└──────────┘     └───────────┘     └──────────┘     └──────────┘
```

### Stage 1: Fetch (`src/fetcher.ts`)

Downloads the raw HTML from the target URL using [undici](https://undici.nodejs.org/). Applies all security validations: protocol checks, SSRF prevention, redirect limits, timeout enforcement, and body size guards. Returns a `WebPageResult` containing the HTML body, final URL (after redirects), page title, and content type.

### Stage 2: Sanitize (`src/sanitizer.ts`)

Parses the raw HTML into a DOM tree using [jsdom](https://github.com/jsdom/jsdom) and walks every element to enforce the tag and attribute allowlists. Strips `<script>` and `<style>` tags entirely, removes event handlers, sanitizes URI protocols, neutralizes CSS expression attacks, and removes HTML comments. Returns clean HTML safe for conversion.

### Stage 3: Convert (`src/converter.ts`)

Transforms the sanitized HTML into native markdown using [turndown](https://github.com/mixmark-io/turndown) with custom rules for:

- **Code blocks** — `<pre><code>` elements become fenced code blocks with optional language hints (e.g., `class="language-javascript"`).
- **Tables** — HTML tables are converted to GitHub-flavored markdown tables with alignment support.
- **Lists** — Ordered and unordered lists with proper nesting.
- **Images** — Preserved as markdown image syntax unless `--no-images` is set.
- **Headings** — ATX-style headings (`# Heading`).

### Stage 4: Output (`src/output.ts`)

Writes the final markdown to stdout or a file. When `--pretty` is enabled, a metadata header with the source URL, page title, content type, and fetch timestamp is prepended. Progress messages and errors are always written to stderr to keep stdout clean for piping.

## Project Structure

```
web-agent/
├── package.json          # Dependencies, scripts, and metadata
├── tsconfig.json         # TypeScript compiler configuration (strict, ES2022)
├── vitest.config.ts      # Test runner configuration (Vitest, v8 coverage)
├── .gitignore            # Git exclusion rules
├── src/
│   ├── types.ts          # Shared interfaces and error classes
│   ├── fetcher.ts        # HTML fetcher with SSRF protection
│   ├── sanitizer.ts      # HTML sanitizer with XSS prevention
│   ├── converter.ts      # HTML-to-markdown converter (turndown)
│   ├── output.ts         # Stdout and file output handler
│   ├── cli.ts            # CLI argument parsing (commander)
│   └── index.ts          # Pipeline orchestrator (entry point)
└── test/
    ├── fetcher.test.ts   # Fetcher unit tests
    ├── sanitizer.test.ts # Sanitizer unit tests
    ├── converter.test.ts # Converter unit tests
    ├── output.test.ts    # Output handler unit tests
    ├── integration.test.ts # Full pipeline integration tests
    └── cli.test.ts       # CLI smoke tests (spawned binary)
```

## Testing

### Run all tests

```bash
npm test
```

### Run tests with coverage

```bash
npm run test:coverage
```

Coverage reports are generated in the `coverage/` directory (text, HTML, and JSON formats). The project targets **90%+** coverage across branches, functions, lines, and statements.

### Test suite overview

| Test file | Scope |
|---|---|
| `fetcher.test.ts` | Fetch success, timeout, SSRF blocking, redirect limits, oversized rejection, protocol validation, network errors |
| `sanitizer.test.ts` | XSS via script tags, event handler removal, CSS expression attacks, `javascript:`/`data:` URI blocking, HTML comment removal, safe HTML passthrough, attribute allowlist enforcement |
| `converter.test.ts` | Paragraphs, headings, lists, tables, links, code blocks with language hints, images, nested elements |
| `output.test.ts` | Stdout output, file creation, directory auto-creation, file write errors, invalid path handling, pretty formatting |
| `integration.test.ts` | Full pipeline with mocked fetcher, malicious HTML through pipeline, CLI argument propagation, error propagation, file output |
| `cli.test.ts` | Spawned binary tests: `--help`, `--version`, missing URL, invalid URL, successful stdout, successful file output |

## Scripts

| Script | Command | Description |
|---|---|---|
| `build` | `tsc` | Compile TypeScript to JavaScript in `dist/` |
| `start` | `node dist/index.js` | Run the built binary |
| `dev` | `ts-node src/index.ts` | Run directly from TypeScript sources |
| `test` | `vitest run` | Run the test suite |
| `test:coverage` | `vitest run --coverage` | Run tests with coverage reporting |
| `lint` | `prettier --check src/ test/` | Check code formatting |
| `format` | `prettier --write src/ test/` | Auto-format code |

## Dependencies

| Package | Role |
|---|---|
| [commander](https://github.com/commander-js/commander) | CLI argument parsing |
| [undici](https://undici.nodejs.org/) | HTTP client (fetcher) |
| [jsdom](https://github.com/jsdom/jsdom) | DOM parsing (sanitizer) |
| [cheerio](https://cheerio.js.org/) | HTML manipulation (sanitizer) |
| [turndown](https://github.com/mixmark-io/turndown) | HTML-to-markdown conversion |
| [is-ip](https://github.com/onsamhe/is-ip) | IP address validation |
| [whatwg-url](https://github.com/jsdom/whatwg-url) | URL parsing per WHATWG spec |

