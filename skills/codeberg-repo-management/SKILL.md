---
name: codeberg-repo-management
description: >
  Manage Codeberg repositories via the Forgejo REST API.
  Create, update, delete repos. Manage files, branches, pull requests, issues,
  releases, webhooks, collaborators, tags, and topics.
  Use when the task involves Codeberg repository operations.
license: MIT
compatibility: Requires Python 3.6+ and network access to codeberg.org. $CODEBERG_TOKEN env var required.
---

# Codeberg Repository Management

Codeberg runs Forgejo (a Gitea fork). REST API base: `https://codeberg.org/api/v1`.

## Setup

The API helper is at `scripts/cb.py`. Use it in either mode:

```bash
# CLI mode (simplest for one-off calls)
python3 scripts/cb.py GET /user
python3 scripts/cb.py POST /user/repos '{"name":"my-repo","private":false}'

# Import mode (for multi-step scripts)
python3 -c "
import sys; sys.path.insert(0, 'SCRIPTS_DIR')
from cb import cb
r = cb('GET', '/user')
print(r['login'])
"
```

Replace `SCRIPTS_DIR` with the absolute path to the `scripts/` directory of this skill.

## Quick Reference

| Operation | Method | Path |
|---|---|---|
| Verify auth | `GET` | `/user` |
| Create repo | `POST` | `/user/repos` |
| List repos | `GET` | `/user/repos` |
| Get repo | `GET` | `/repos/{owner}/{repo}` |
| Update repo | `PATCH` | `/repos/{owner}/{repo}` |
| Delete repo | `DELETE` | `/repos/{owner}/{repo}` |
| Fork repo | `POST` | `/repos/{owner}/{repo}/forks` |
| List files | `GET` | `/repos/{owner}/{repo}/contents` |
| Get file | `GET` | `/repos/{owner}/{repo}/contents/{filepath}` |
| Get raw file | `GET` | `/repos/{owner}/{repo}/raw/{filepath}` |
| Create file | `POST` | `/repos/{owner}/{repo}/contents/{filepath}` |
| Update file | `PUT` | `/repos/{owner}/{repo}/contents/{filepath}` |
| Delete file | `DELETE` | `/repos/{owner}/{repo}/contents/{filepath}` |
| Batch files | `POST` | `/repos/{owner}/{repo}/contents` |
| List branches | `GET` | `/repos/{owner}/{repo}/branches` |
| Create branch | `POST` | `/repos/{owner}/{repo}/branches` |
| Delete branch | `DELETE` | `/repos/{owner}/{repo}/branches/{name}` |
| List issues | `GET` | `/repos/{owner}/{repo}/issues` |
| Create issue | `POST` | `/repos/{owner}/{repo}/issues` |
| List PRs | `GET` | `/repos/{owner}/{repo}/pulls` |
| Create PR | `POST` | `/repos/{owner}/{repo}/pulls` |
| Merge PR | `POST` | `/repos/{owner}/{repo}/pulls/{index}/merge` |
| List releases | `GET` | `/repos/{owner}/{repo}/releases` |
| Create release | `POST` | `/repos/{owner}/{repo}/releases` |
| List labels | `GET` | `/repos/{owner}/{repo}/labels` |
| List hooks | `GET` | `/repos/{owner}/{repo}/hooks` |
| List collaborators | `GET` | `/repos/{owner}/{repo}/collaborators` |
| List topics | `GET` | `/repos/{owner}/{repo}/topics` |
| List tags | `GET` | `/repos/{owner}/{repo}/tags` |
| List commits | `GET` | `/repos/{owner}/{repo}/commits` |

See `references/swagger.v1.json` for the full API schema.

## Critical Rules

1. **Base64 encoding**: File `content` in create/update/batch requests MUST be base64-encoded. Plain text causes `422: illegal base64 data`. Encode with `base64.b64encode(b"text").decode()`. The GET `/contents` response returns base64 — reuse it directly for updates.

2. **Content SHA**: Updating or deleting a file requires the `sha` from a prior GET `/contents` call. Always fetch the file first.

3. **`auto_init: true` creates README.md**: Creating a repo with `auto_init: true` pre-creates `README.md`. POSTing a new README will fail. Use a different filename or UPDATE the existing one.

4. **Empty responses on DELETE/MERGE**: Most DELETE endpoints return HTTP 204 (empty body), but file DELETE returns HTTP 200 with a response body. PR merge returns HTTP 200 with empty body. This is normal, not an error.

5. **Raw endpoints**: `/repos/{owner}/{repo}/raw/{filepath}` returns plain text, not JSON. Use `raw=True` parameter: `cb('GET', '/repos/owner/repo/raw/file.txt', raw=True)`.

6. **Issue labels use integer IDs**: Create-issue `labels` field expects numeric IDs, not string names. Fetch IDs via `GET /repos/{owner}/{repo}/labels` first. Workaround: omit labels on create, then add via `POST /repos/{owner}/{repo}/issues/{index}/labels` which accepts string names.

7. **PR create requires `head`**: The `head` (source branch) is required when creating a PR. `base` is optional — omitting it defaults to the repo's default branch.

8. **Rate limiting**: ~7 issues in 10 minutes triggers rate limiting. Add `time.sleep(60)` between issue creates.

9. **Token format**: `Authorization: token $CODEBERG_TOKEN` (not Bearer).

10. **Never delete a PR's branch before merge**: Deleting the head branch severs the PR link. Recreating the branch does NOT restore it.

See `references/codeberg-api-quirks.md` for additional pitfalls and edge cases.

## Common Patterns

### Full repo lifecycle
```python
import sys, json, base64
sys.path.insert(0, 'SCRIPTS_DIR')
from cb import cb

# Create
r = cb('POST', '/user/repos', {"name": "my-repo", "auto_init": True})
owner, repo = r['full_name'].split('/')

# Add file (base64-encoded)
cb('POST', f'/repos/{owner}/{repo}/contents/hello.txt', {
    "branch": "main",
    "content": base64.b64encode(b"Hello!\n").decode(),
    "message": "Add hello.txt"
})

# Read file content
text = cb('GET', f'/repos/{owner}/{repo}/raw/hello.txt?ref=main', raw=True)

# Delete repo
cb('DELETE', f'/repos/{owner}/{repo}')
```

### Create issue then label it
```python
r = cb('POST', '/repos/{owner}/{repo}/issues', {
    "title": "Bug title",
    "body": "Description"
})
index = r['index']
cb('POST', f'/repos/{owner}/{repo}/issues/{index}/labels', {"name": "bug"})
```

### Create branch, PR, merge
```python
cb('POST', '/repos/{owner}/{repo}/branches', {"new_branch_name": "feature"})
r = cb('POST', '/repos/{owner}/{repo}/pulls', {
    "title": "Add feature",
    "head": "feature",
    "base": "main"
})
index = r['index']
cb('POST', f'/repos/{owner}/{repo}/pulls/{index}/merge', {
    "Do": "merge"
})
# Merge strategies: "merge", "rebase", "rebase-merge", "squash", "fast-forward-only", "manually-merged"
# Verify (check both state and merged — closed alone is insufficient)
r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
assert r['state'] == 'closed' and r['merged'] == True
```

### Batch file operations
```python
# Fetch existing file SHAs for update/delete
target = cb('GET', f'/repos/{owner}/{repo}/contents/existing.txt')
old_sha = cb('GET', f'/repos/{owner}/{repo}/contents/old.txt')['sha']

# Batch: create new file + update existing + delete old
# Note: message is on the parent object, not per-operation
cb('POST', f'/repos/{owner}/{repo}/contents', {
    "branch": "main",
    "message": "Batch: add, update, delete",
    "files": [
        {
            "operation": "create",
            "path": "new_file.txt",
            "content": base64.b64encode(b"New content\n").decode()
        },
        {
            "operation": "update",
            "path": "existing.txt",
            "content": base64.b64encode(b"Updated\n").decode(),
            "sha": target['sha']
        },
        {
            "operation": "delete",
            "path": "old.txt",
            "sha": old_sha
        }
    ]
})
```

## Reference Files

- `references/codeberg-api-quirks.md` — API gotchas, error messages, workarounds
- `references/codeberg-merge-verification.md` — Verifying PR merge success
- `references/codeberg-pr-branch-pitfalls.md` — PR merge and branch lifecycle pitfalls
- `references/pr-merge-sync.md` — PR merge timing and state synchronization
- `references/agent-workflow-rules.md` — PR workflow conventions (no auto-merge, testing proof, issue tracking)
- `references/swagger.v1.json` — Full Forgejo API schema
