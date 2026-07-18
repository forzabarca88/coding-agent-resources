# Codeberg PR Branch Lifecycle Pitfalls

Non-obvious failure modes when merging PRs on Codeberg/Forgejo via API + git.

## 1. Deleting a PR's branch severs its Forgejo link

Deleting a branch that has an OPEN PR removes the PR↔branch association on the server. Recreating the branch from the same commit does NOT re-link it — the PR page switches from "Visit the existing pull request" to "Create a new pull request", and the PR becomes un-mergeable through the UI and API.

**Rule:** Never delete a branch until its PR is confirmed merged (`Merged: True`) via the UI or API.

**Recovery if already deleted:**
```bash
git branch <branch> <head_commit_sha>          # recreate locally from head sha
git push origin <branch> --force               # recreate remotely
```
```python
# Reopen PR
cb('PATCH', f'/repos/{owner}/{repo}/pulls/{index}', {"state": "open"})
```
```bash
git fetch origin main
git rebase origin/main                         # rebase branch onto current main
git push origin <branch> --force
# now merge via UI or API
```

## 2. "Already included / 0 commits" PRs have no merge button

When Forgejo says "This branch is already included in the target branch. There is nothing to merge", the web UI shows NO Merge button and the API merge endpoint returns `405 Method Not Allowed`.

**Workaround — add a commit so Forgejo has something to merge:**
```bash
git checkout <branch>
git commit --allow-empty -m "Merge PR #<index> via API"
git push origin <branch> --force
```
Forgejo detects the new commit and auto-merges the PR (status → `Merged: True`).

## 3. Divergent local `main` after remote merges

After PRs merge on the remote, your local `main` is behind/diverged. A bare `git pull` fails with:
`fatal: Need to specify how to reconcile divergent branches.`

**Fix:** reconcile explicitly, then push:
```bash
git pull origin main --no-rebase     # merge commit; or use --rebase
git push origin main
```
Or set once: `git config pull.rebase true`.

## 4. Verify merge success

After any merge attempt (API or auto-merge), confirm before deleting branches:
```python
r = cb('GET', f'/repos/{owner}/{repo}/pulls/{index}')
print(f"State: {r['state']}, Merged: {r['merged']}")
# Success = closed True. open/merged=False means NOT merged yet.
```

## 5. Repo review creates issues, not PRs

When asked to "review the repo and create issue tickets for each unrelated issue found":
- **Do NOT create PRs or branches** — only create issues via `/issues` endpoint
- **One issue per distinct problem** — separate tickets for config, docs, security, etc.
- **Do NOT fix during review** — leave fixes for follow-up PRs referencing the issues
- **Include evidence** — file paths, line numbers, code snippets in the issue body
- **Use severity labels** — High/Medium/Low to prioritize follow-up work
