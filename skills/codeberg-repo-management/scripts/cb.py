#!/usr/bin/env python3
"""Codeberg API helper. Import with: from cb import cb

Usage in python3 -c:
  import sys; sys.path.insert(0, '/path/to/skill/scripts')
  from cb import cb
  r = cb('GET', '/user')

Or run directly:
  python3 scripts/cb.py GET /user
  python3 scripts/cb.py POST /user/repos '{"name":"my-repo"}'
"""
import urllib.request
import json
import os
import sys

BASE = "https://codeberg.org/api/v1"
TOKEN = os.environ.get("CODEBERG_TOKEN", "")


def cb(method, path, data=None, raw=False, headers=False):
    """Make a Codeberg API call.

    Args:
        method: HTTP method (GET, POST, PATCH, PUT, DELETE)
        path: API path (e.g. '/user/repos')
        data: Dict to send as JSON body (None for GET requests)
        raw: If True, return raw response text instead of parsing JSON.
             Use for /raw/ endpoints that return file content.
        headers: If True, return {"body": ..., "headers": {rate-limit headers}}.
                 Useful for monitoring X-RateLimit-Limit/Remaining/Reset.

    Returns:
        Parsed JSON dict (or {} for empty responses like DELETE).
        Raw text string if raw=True.
        Dict with 'body' and 'headers' keys if headers=True.

    Raises:
        urllib.error.HTTPError on 4xx/5xx responses.
    """
    req_headers = {"Authorization": f"token {TOKEN}"}
    if data is not None:
        req_headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode()
    else:
        body = None
    req = urllib.request.Request(
        f"{BASE}{path}", data=body, headers=req_headers, method=method
    )
    try:
        resp = urllib.request.urlopen(req)
        text = resp.read().decode()
        resp_headers = dict(resp.headers)

        rate_headers = {
            "X-RateLimit-Limit": resp_headers.get("X-RateLimit-Limit"),
            "X-RateLimit-Remaining": resp_headers.get("X-RateLimit-Remaining"),
            "X-RateLimit-Reset": resp_headers.get("X-RateLimit-Reset"),
        }

        if raw:
            if headers:
                return {"body": text, "headers": rate_headers}
            return text

        try:
            parsed = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError:
            # API returned non-JSON (e.g. HTML error page, maintenance)
            if headers:
                return {"body": text, "headers": rate_headers}
            return text

        if headers:
            return {"body": parsed, "headers": rate_headers}
        return parsed
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"HTTP {e.code}: {err_body}", file=sys.stderr)
        raise


def main():
    """CLI entry point: python3 scripts/cb.py METHOD PATH [JSON_DATA] [--raw] [--headers]"""
    if len(sys.argv) < 3:
        print("Usage: python3 scripts/cb.py METHOD PATH [JSON_DATA] [--raw] [--headers]", file=sys.stderr)
        sys.exit(1)
    method = sys.argv[1].upper()
    args = sys.argv[2:]
    raw = "--raw" in args
    hdrs = "--headers" in args
    args = [a for a in args if a not in ("--raw", "--headers")]
    path = args[0] if args else None
    data = json.loads(args[1]) if len(args) > 1 else None
    result = cb(method, path, data, raw, hdrs)
    if isinstance(result, str):
        print(result, end="")
    elif isinstance(result, dict) and "body" in result and "headers" in result:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
