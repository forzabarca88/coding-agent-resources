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


def cb(method, path, data=None, raw=False):
    """Make a Codeberg API call.

    Args:
        method: HTTP method (GET, POST, PATCH, PUT, DELETE)
        path: API path (e.g. '/user/repos')
        data: Dict to send as JSON body (None for GET requests)
        raw: If True, return raw response text instead of parsing JSON.
             Use for /raw/ endpoints that return file content.

    Returns:
        Parsed JSON dict (or {} for empty responses like DELETE).
        Raw text string if raw=True.

    Raises:
        urllib.error.HTTPError on 4xx/5xx responses.
    """
    headers = {"Authorization": f"token {TOKEN}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data).encode()
    else:
        body = None
    req = urllib.request.Request(
        f"{BASE}{path}", data=body, headers=headers, method=method
    )
    try:
        resp = urllib.request.urlopen(req)
        text = resp.read().decode()
        if raw:
            return text
        return json.loads(text) if text.strip() else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f"HTTP {e.code}: {err_body}", file=sys.stderr)
        raise


def main():
    """CLI entry point: python3 scripts/cb.py METHOD PATH [JSON_DATA]"""
    if len(sys.argv) < 3:
        print("Usage: python3 scripts/cb.py METHOD PATH [JSON_DATA]", file=sys.stderr)
        sys.exit(1)
    method = sys.argv[1].upper()
    path = sys.argv[2]
    data = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    raw = "--raw" in sys.argv
    result = cb(method, path, data, raw)
    if isinstance(result, str):
        print(result, end="")
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
