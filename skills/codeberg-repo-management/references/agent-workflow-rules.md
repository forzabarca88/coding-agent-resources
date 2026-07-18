# Agent Workflow Rules for Codeberg Repos

User-specific workflow conventions that AI agents should follow when working on Codeberg-hosted repositories.

## PR Workflow

### Do NOT Auto-Merge PRs

After creating a PR, **do not merge it automatically**. Instead:

1. Send a summary to the user describing:
   - What changed (title, description)
   - What was tested (CLI output, test results, health checks, screenshots)
   - The PR number and link
2. Wait for the user to explicitly ask to merge the PR
3. Only merge when the user says so

**Rationale**: The user wants final approval before changes land on `main`. Auto-merging bypasses this review step.

### PR Requirements

Every PR must include:

- **Clear title** following conventional commit format (`type(scope): description`)
- **Body** describing what changed and why
- **Proof of testing** — evidence that changes work:
  - CLI command output (e.g., `--help`, `list-tests`)
  - Test results (pass/fail counts, error output)
  - Server health check output (e.g., `curl http://localhost:8000/health`)
  - Screenshots for UI changes
- **README review** — check `README.md` for currency and amend if needed before merging

### Issue-Driven Work

When the user asks you to follow up on issues without specifying which ones:

1. Check the Codeberg Issues tab: `GET /api/v1/repos/{owner}/{repo}/issues?state=open`
2. Identify the relevant issue(s)
3. Fix the issue
4. Include `Closes #N` in the PR body so it auto-closes on merge

## Branch Workflow

- Always work from `main`: `git checkout main && git pull origin main`
- Create a new branch for every change: `git checkout -b <type>/<description>`
- Branch naming: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`
- Delete feature branches after merging: `git branch -D <branch>`

## Merge Verification

See `codeberg-merge-verification.md` for detailed merge verification steps.
