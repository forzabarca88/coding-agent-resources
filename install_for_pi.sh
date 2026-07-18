#!/usr/bin/env bash
set -euo pipefail

# install_for_pi.sh
# Symlinks extensions, prompts, and skills from this repo into the pi (~/.pi) agent directory.
# Removes any existing files at the destination that would conflict.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"

if [ ! -d "$PI_AGENT_DIR" ]; then
  echo "Error: pi agent directory not found at $PI_AGENT_DIR" >&2
  echo "Make sure pi is installed before running this script." >&2
  exit 1
fi

echo "Installing coding-agent-resources into pi..."
echo "  Repo: $REPO_DIR"
echo "  Pi:   $PI_AGENT_DIR"
echo ""

# ──────────────────────────────────────────────────
# Remove conflicting files at destination
# ──────────────────────────────────────────────────
echo "--- Removing conflicting files ---"

# Extensions
rm -rf "$PI_AGENT_DIR/extensions/provider-health-check"
rm -f  "$PI_AGENT_DIR/extensions/auto-recover.ts"
rm -f  "$PI_AGENT_DIR/extensions/success-tone.ts"
rm -f  "$PI_AGENT_DIR/extensions/subagent/index.ts"
rm -f  "$PI_AGENT_DIR/extensions/subagent/agents.ts"

# Prompts
rm -f "$PI_AGENT_DIR/prompts/ralph-loop.md"

# Skills
rm -rf "$PI_AGENT_DIR/skills/codeberg-repo-management"

echo "  Done."

# ──────────────────────────────────────────────────
# Create symlinks
# ──────────────────────────────────────────────────
echo "--- Creating symlinks ---"

# Extensions
ln -sf "$REPO_DIR/extensions/provider-health-check.ts" "$PI_AGENT_DIR/extensions/provider-health-check.ts"
ln -sf "$REPO_DIR/extensions/auto-recover.ts"           "$PI_AGENT_DIR/extensions/auto-recover.ts"
ln -sf "$REPO_DIR/extensions/success-tone.ts"           "$PI_AGENT_DIR/extensions/success-tone.ts"
ln -sf "$REPO_DIR/extensions/subagent/index.ts"         "$PI_AGENT_DIR/extensions/subagent/index.ts"
ln -sf "$REPO_DIR/extensions/subagent/agents.ts"        "$PI_AGENT_DIR/extensions/subagent/agents.ts"

# Prompts
ln -sf "$REPO_DIR/prompts/ralph-loop.md" "$PI_AGENT_DIR/prompts/ralph-loop.md"

# Skills
ln -sf "$REPO_DIR/skills/codeberg-repo-management" "$PI_AGENT_DIR/skills/codeberg-repo-management"

echo "  Done."

# ──────────────────────────────────────────────────
# Verify
# ──────────────────────────────────────────────────
echo "--- Verification ---"

errors=0

check_file() {
  local path="$1"
  if [ -f "$path" ]; then
    echo "  ✓ $path"
  elif [ -L "$path" ]; then
    echo "  ✗ $path (broken symlink!)"
    errors=$((errors + 1))
  else
    echo "  ✗ $path (missing!)"
    errors=$((errors + 1))
  fi
}

check_dir() {
  local path="$1"
  if [ -d "$path" ]; then
    echo "  ✓ $path"
  elif [ -L "$path" ]; then
    echo "  ✗ $path (broken symlink!)"
    errors=$((errors + 1))
  else
    echo "  ✗ $path (missing!)"
    errors=$((errors + 1))
  fi
}

check_file "$PI_AGENT_DIR/extensions/provider-health-check.ts"
check_file "$PI_AGENT_DIR/extensions/auto-recover.ts"
check_file "$PI_AGENT_DIR/extensions/success-tone.ts"
check_file "$PI_AGENT_DIR/extensions/subagent/index.ts"
check_file "$PI_AGENT_DIR/extensions/subagent/agents.ts"
check_file "$PI_AGENT_DIR/prompts/ralph-loop.md"
check_dir  "$PI_AGENT_DIR/skills/codeberg-repo-management"

echo ""
if [ "$errors" -eq 0 ]; then
  echo "✓ All resources installed successfully."
else
  echo "✗ $errors error(s) encountered." >&2
  exit 1
fi
