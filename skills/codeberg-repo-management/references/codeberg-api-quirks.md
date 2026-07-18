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

See `codeberg-merge-verification.md` for merge verification details.

## Branch Deletion Severs PR Link

See `codeberg-pr-branch-pitfalls.md` §1 for branch deletion details.

## Divergent Main After Remote PR Merges

See `codeberg-pr-branch-pitfalls.md` §3.
