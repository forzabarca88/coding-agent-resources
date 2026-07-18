# Codeberg Merge Verification Guide

## Verifying Merge Success When API Returns Empty

Codeberg's `/pulls/{index}/merge` endpoint may return an empty response on successful merges. Always verify the actual PR state rather than assuming success based on the API response.

### Verification Method

```python
# Check PR state after merge attempt
r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
print(f"State: {r.get('state')}, Merged: {r.get('merged')}")
# Required output: State: closed, Merged: True
```

### Common Scenarios & Solutions

1. **Empty API Response with 200 Status**
   - *What to see*: HTTP 200 with empty body
   - *Reality*: This indicates successful merge
   - *Note*: PR state (`state="closed", merged=True`) may take several seconds to update due to Forgejo's async internal sync. See `pr-merge-sync.md` for retry pattern.
   - *Verification*: Check PR state as shown above

2. **API 405 Method Not Allowed**
   - *What to see*: `HTTP 405 Method Not Allowed` response
   - *Common cause*: Missing `Do` field or wrong case (`Do` not `do`) in request body
   - *Fix*: Add `"Do": "merge"` to JSON body

3. **Merge Button Not Visible**
   - *What to see*: "This branch is already included in the target branch" message
   - *Root cause*: No commits exist between base and head branches
   - *Solution*: Add a dummy commit before merging:
     ```bash
     git commit --allow-empty -m "merge indicator" && git push --force
     ```

4. **Branch Protection Conflicts**
   - *Symptom*: API shows success but PR remains open
   - *Check*:
     - `required_approvals` count (must be met)
     - `dismiss_authors` rules (may block author merges)
   - *Fix*: Ensure approval requirements are satisfied

### Step-by-Step Merge Workflow

1. **Confirm PR Status**
   ```python
   r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
   print(f"State: {r.get('state')}, Merged: {r.get('merged')}")
   ```

2. **Ensure Branches Are Up-to-Date**
   ```bash
   git checkout <feature-branch>
   git rebase origin/main
   git push origin <feature-branch> --force
   ```

3. **Attempt Merge with Proper Body**
   ```python
   cb('POST', f'/repos/{owner}/{repo}/pulls/{index}/merge', {
       "Do": "merge"
   })
   ```

4. **Verify Success**
   ```python
   r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
   print(f"State: {r.get('state')}, Merged: {r.get('merged')}")
   ```

### Key Takeaways

- **Empty response ≠ failure**: An empty response body with HTTP 200 means merge succeeded
- **Always verify PR state**: Never assume based on API response alone
- **Verify via PR endpoint**: Use `/pulls/{index}` to check final state
