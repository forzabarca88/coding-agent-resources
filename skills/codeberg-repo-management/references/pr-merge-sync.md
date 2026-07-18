# PR Merge State Synchronization on Codeberg

## Problem
When merging PRs via API on Codeberg (Forgejo), there's a timing gap between:
1. API returning success (HTTP 200 or empty response)
2. PR state reflecting the merge in subsequent API calls

## Observed Behavior
- Merge endpoint returns: `HTTP 200` with empty body
- Subsequent `GET /pulls/{id}` shows: `state="open", merged=False` for several seconds
- Forgejo eventually shows: `state="closed", merged=True` after internal sync

## Recovery Pattern
After any merge attempt via API, wait and verify:

```python
import time

# Merge attempt
cb('POST', f'/repos/{owner}/{repo}/pulls/{index}/merge', {
    "Do": "merge"
})

# Wait and verify
time.sleep(2)
r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')

# If still "open", wait and retry
for _ in range(5):
    if r.get('state') == 'closed' and r.get('merged') == True:
        print("Merge confirmed")
        break
    time.sleep(3)
    r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
```

## Branch Deletion Timing
After merge verification, prune remote branches:

```bash
# Delete the source branch after confirmation
git push origin --delete {branch_name}
```

## Divergence Warning

See `codeberg-pr-branch-pitfalls.md` §3.


