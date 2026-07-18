# Codeberg Repository Management Skill

Manage Codeberg repositories via the Forgejo REST API.

## Overview

This skill provides comprehensive tools for managing repositories on [Codeberg](https://codeberg.org), which runs [Forgejo](https://forgejo.org/) (a Gitea fork). It includes a Python helper script, comprehensive API documentation, and reference guides for common operations.

## Features

### Repository Management
- Create, update, delete, and fork repositories
- Manage repository settings (private/public, description, etc.)
- List user repositories

### File Operations
- Read, create, update, and delete files
- Batch file operations (multiple files in one request)
- Raw file access

### Branch Management
- List branches
- Create and delete branches

### Pull Request Management
- List, create, and merge pull requests
- Verify PR merge success
- Manage PR branches

### Issue Management
- List and create issues
- Add labels to issues
- Manage issue lifecycle

### Additional Features
- Release management
- Webhook management
- Collaborator management
- Tag management
- Commit history access

## Setup

### Prerequisites
- Python 3.6+
- Network access to `codeberg.org`
- Codeberg personal access token

### Environment Variables

Set your Codeberg token as an environment variable:

```bash
export CODEBERG_TOKEN="your-personal-access-token"
```

Add this to your shell profile (`.bashrc`, `.zshrc`, etc.) for persistence.

### Token Creation

1. Go to Codeberg → Settings → Applications
2. Generate a new token with appropriate permissions
3. Copy the token and set it as `CODEBERG_TOKEN`

## Usage

### Using the Helper Script

The skill includes a Python helper script at `scripts/cb.py` that simplifies API interactions.

#### CLI Mode (Simple One-off Calls)

```bash
# Get current user info (verify authentication)
python3 scripts/cb.py GET /user

# Create a new repository
python3 scripts/cb.py POST /user/repos '{"name":"my-repo","private":false}'

# List repositories
python3 scripts/cb.py GET /user/repos

# Get repository info
python3 scripts/cb.py GET /repos/owner/repo-name
```

#### Import Mode (For Multi-step Scripts)

```python
import sys
sys.path.insert(0, '/path/to/skills/codeberg-repo-management/scripts')
from cb import cb

# Get user info
user = cb('GET', '/user')
print(f"Logged in as: {user['login']}")

# Create a repository
repo = cb('POST', '/user/repos', {
    "name": "my-repo",
    "auto_init": True,
    "private": False
})
print(f"Created: {repo['full_name']}")
```

## Quick Reference

### Common API Endpoints

| Category | Method | Endpoint | Description |
|----------|--------|----------|-------------|
| **Auth** | GET | `/user` | Verify authentication |
| **Repos** | POST | `/user/repos` | Create repository |
| **Repos** | GET | `/user/repos` | List repositories |
| **Repos** | GET | `/repos/{owner}/{repo}` | Get repository |
| **Repos** | PATCH | `/repos/{owner}/{repo}` | Update repository |
| **Repos** | DELETE | `/repos/{owner}/{repo}` | Delete repository |
| **Files** | GET | `/repos/{owner}/{repo}/contents` | List files |
| **Files** | GET | `/repos/{owner}/{repo}/contents/{path}` | Get file |
| **Files** | GET | `/repos/{owner}/{repo}/raw/{path}` | Get raw file |
| **Files** | POST | `/repos/{owner}/{repo}/contents/{path}` | Create file |
| **Files** | PUT | `/repos/{owner}/{repo}/contents/{path}` | Update file |
| **Files** | DELETE | `/repos/{owner}/{repo}/contents/{path}` | Delete file |
| **Branches** | GET | `/repos/{owner}/{repo}/branches` | List branches |
| **Branches** | POST | `/repos/{owner}/{repo}/branches` | Create branch |
| **PRs** | GET | `/repos/{owner}/{repo}/pulls` | List PRs |
| **PRs** | POST | `/repos/{owner}/{repo}/pulls` | Create PR |
| **PRs** | POST | `/repos/{owner}/{repo}/pulls/{index}/merge` | Merge PR |
| **Issues** | GET | `/repos/{owner}/{repo}/issues` | List issues |
| **Issues** | POST | `/repos/{owner}/{repo}/issues` | Create issue |

### Full API Schema

The complete Forgejo API schema is available in `references/swagger.v1.json`.

## Critical Rules and Gotchas

### 1. Base64 Encoding for File Content

File `content` in create/update/batch requests **MUST** be base64-encoded. Plain text causes `422: illegal base64 data`.

```python
import base64
content = base64.b64encode(b"file content").decode()
```

### 2. Content SHA for Updates/Deletes

Updating or deleting a file requires the `sha` from a prior GET `/contents` call. Always fetch the file first.

```python
# Get file info first
file_info = cb('GET', f'/repos/{owner}/{repo}/contents/file.txt')
file_sha = file_info['sha']

# Then update with the SHA
cb('PUT', f'/repos/{owner}/{repo}/contents/file.txt', {
    'content': base64.b64encode(b"new content").decode(),
    'sha': file_sha,
    'branch': 'main',
    'message': 'Update file'
})
```

### 3. Auto-init Creates README.md

Creating a repo with `auto_init: true` pre-creates `README.md`. POSTing a new README will fail. Use a different filename or UPDATE the existing one.

### 4. Empty Responses on DELETE/MERGE

- Most DELETE endpoints return HTTP 204 (empty body)
- File DELETE returns HTTP 200 with a response body
- PR merge returns HTTP 200 with empty body
- This is normal, not an error

### 5. Raw Endpoints

`/repos/{owner}/{repo}/raw/{filepath}` returns plain text, not JSON. Use the `raw=True` parameter:

```python
text = cb('GET', '/repos/owner/repo/raw/file.txt', raw=True)
```

### 6. Issue Labels Use Integer IDs

Create-issue `labels` field expects numeric IDs, not string names. Fetch IDs first:

```python
# Get label IDs
labels = cb('GET', f'/repos/{owner}/{repo}/labels')
bug_label_id = next(l['id'] for l in labels if l['name'] == 'bug')

# Create issue with label
cb('POST', f'/repos/{owner}/{repo}/issues', {
    'title': 'Bug report',
    'body': 'Description',
    'labels': [bug_label_id]
})
```

### 7. PR Create Requires `head`

The `head` (source branch) is required when creating a PR. `base` is optional — omitting it defaults to the repo's default branch.

### 8. Rate Limiting

~7 issues in 10 minutes triggers rate limiting. Add delays between operations:

```python
import time
time.sleep(60)  # Wait 60 seconds between issue creates
```

### 9. Token Format

Authorization header format: `token $CODEBERG_TOKEN` (not Bearer).

### 10. Never Delete PR Branch Before Merge

Deleting the head branch severs the PR link. Recreating the branch does NOT restore it.

## Common Patterns

### Full Repository Lifecycle

```python
import sys, json, base64
sys.path.insert(0, 'SCRIPTS_DIR')
from cb import cb

# Create repository
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

# Delete repository
cb('DELETE', f'/repos/{owner}/{repo}')
```

### Create Issue Then Label It

```python
# Create issue
r = cb('POST', f'/repos/{owner}/{repo}/issues', {
    "title": "Bug title",
    "body": "Description"
})
index = r['index']

# Add label (using string name, not ID)
cb('POST', f'/repos/{owner}/{repo}/issues/{index}/labels', {"name": "bug"})
```

### Create Branch, PR, Merge

```python
# Create branch
cb('POST', f'/repos/{owner}/{repo}/branches', {"new_branch_name": "feature"})

# Create PR
r = cb('POST', f'/repos/{owner}/{repo}/pulls', {
    "title": "Add feature",
    "head": "feature",
    "base": "main"
})
index = r['index']

# Merge PR
cb('POST', f'/repos/{owner}/{repo}/pulls/{index}/merge', {
    "Do": "merge"
})

# Verify merge (check both state and merged)
r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
assert r['state'] == 'closed' and r['merged'] == True
```

### Batch File Operations

```python
# Fetch existing file SHAs for update/delete
target = cb('GET', f'/repos/{owner}/{repo}/contents/existing.txt')
old_sha = cb('GET', f'/repos/{owner}/{repo}/contents/old.txt')['sha']

# Batch: create new file + update existing + delete old
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

This skill includes several reference files with detailed information:

- **[codeberg-api-quirks.md](./references/codeberg-api-quirks.md)** - API gotchas, error messages, and workarounds
- **[codeberg-merge-verification.md](./references/codeberg-merge-verification.md)** - Verifying PR merge success
- **[codeberg-pr-branch-pitfalls.md](./references/codeberg-pr-branch-pitfalls.md)** - PR merge and branch lifecycle pitfalls
- **[pr-merge-sync.md](./references/pr-merge-sync.md)** - PR merge timing and state synchronization
- **[agent-workflow-rules.md](./references/agent-workflow-rules.md)** - PR workflow conventions (no auto-merge, testing proof, issue tracking)
- **[swagger.v1.json](./references/swagger.v1.json)** - Full Forgejo API schema

## Scripts

### [cb.py](./scripts/cb.py)

The main helper script for API interactions. Features:

- Automatic token handling from `CODEBERG_TOKEN` environment variable
- Request signing and headers
- JSON response parsing
- Error handling
- Raw mode support for non-JSON responses

Usage:

```bash
# CLI mode
python3 cb.py METHOD PATH [BODY]

# Import mode
from cb import cb
result = cb('GET', '/user')
```

## Best Practices

1. **Always verify authentication first**: Start with `GET /user` to ensure your token is valid
2. **Fetch before update/delete**: Always get the current state (and SHA for files) before modifying
3. **Handle rate limits**: Add delays between batch operations
4. **Validate responses**: Check response status and content before proceeding
5. **Use raw mode for files**: Use `raw=True` when fetching file contents as text
6. **Base64 encode content**: Always encode file content in base64
7. **Check merge status properly**: Verify both `state == 'closed'` AND `merged == True`

## Troubleshooting

### Authentication Failed

```
Error: 401 Unauthorized
```

- Verify `CODEBERG_TOKEN` environment variable is set
- Check token is still valid (tokens may expire)
- Regenerate token if needed

### Rate Limited

```
Error: 429 Too Many Requests
```

- Wait before retrying
- Add delays between requests
- Consider batching operations where possible

### Illegal Base64 Data

```
Error: 422 illegal base64 data
```

- Ensure content is properly base64-encoded
- Use `base64.b64encode(b"text").decode()` in Python
- Don't send plain text

### File Not Found

```
Error: 404 Not Found
```

- Verify repository, branch, and file path exist
- Check case sensitivity
- Ensure you have access to the repository

## See Also

- [Forgejo API Documentation](https://forgejo.org/docs/latest/developer/api/)
- [Codeberg Documentation](https://codeberg.org/docs)
- [Skills README](../README.md) - Parent directory documentation
- [Main README](../../README.md) - Repository overview
