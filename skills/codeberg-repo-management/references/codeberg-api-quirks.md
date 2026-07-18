# Codeberg API Quirks & Pitfalls

## Labels Integer ID Requirement

When creating issues via the Codeberg API, the `labels` field expects **integer label IDs**, NOT string names.

### Error
```
json: cannot unmarshal string into Go struct field CreateIssueOption.labels of type int64
```

### Fix
1. First fetch label IDs:
   ```python
   labels = cb('GET', f'/repos/{owner}/{repo}/labels')
   # Use labels[i]['id'] in your create request
   ```
2. Use numeric `id` field from each label in your create request

### Workaround
Omit `labels` during issue creation, then add them afterward:
```python
# Create issue without labels
r = cb('POST', f'/repos/{owner}/{repo}/issues', {
    "title": "Bug fix",
    "body": "Description"
})
index = r['index']

# Add labels via POST (accepts string names)
cb('POST', f'/repos/{owner}/{repo}/issues/{index}/labels', {"name": "bug"})
```

## Rate Limiting

Codeberg enforces rate limits on API calls:
- **Observed limit**: ~7 issues created in under 10 minutes triggers rate limiting
- **Error message**: `NewIssue: {user} posted 7 issues in under 10 minutes: rate limited`

### Workarounds
- Space out API calls: `time.sleep(60)` between issues
- Use batch scripts with delays
- Monitor `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers

## Merge Endpoint Returns Empty on Success

The `/pulls/{index}/merge` endpoint may return empty dict `{}` on success. Always verify by checking PR state afterward:
```python
r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
print(f"State: {r['state']}, Merged: {r['merged']}")
```

A successful merge shows `State: closed, Merged: True`.

## Branch Deletion Severs PR Link

`git push origin --delete <branch>` on a branch that has an open PR removes the PR↔branch association on Forgejo. Recreating the branch afterward does NOT re-link.

### Recovery
1. Recreate branch from head commit
2. Reopen PR: `cb('PATCH', f'/repos/{owner}/{repo}/pulls/{index}', {"state": "open"})`
3. Rebase onto current `main`
4. Force-push
5. Merge

## "0 Commits" PRs Have No Merge Button

When Forgejo reports "This branch is already included in the target branch", the UI shows no Merge button and the API merge returns `405`.

### Workaround
Add a commit to the head branch:
```bash
git checkout <branch> && \
git commit --allow-empty -m "Merge PR #N via API" && \
git push origin <branch> --force
```

Forgejo detects the new commit and merges the PR.

## Divergent Main After Remote PR Merges

After PRs merge on the remote, your local `main` falls behind. A bare `git pull` fails with `fatal: Need to specify how to reconcile divergent branches`.

### Fix
```bash
git pull origin main --no-rebase  # creates merge commit
# or
git pull origin main --rebase     # rebases local changes
git push origin main
```

Alternatively: `git config pull.rebase true` once.
