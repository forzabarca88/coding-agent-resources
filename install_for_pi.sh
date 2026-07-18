#!/usr/bin/env bash
set -euo pipefail

# install_for_pi.sh
# Symlinks agents, extensions, prompts, and skills from this repo into pi (~/.pi/agent).
# Removes any existing file/dir at the destination that would conflict.
#
# Works with any contents — new files or directories added to the repo are
# automatically picked up. Each top-level item under agents/, extensions/,
# prompts/, and skills/ is symlinked as a single unit (file or whole directory).
#
# Usage: ./install_for_pi.sh [--dry-run]

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi/agent"

if [ ! -d "$PI_DIR" ]; then
  echo "Error: pi agent directory not found at $PI_DIR" >&2
  echo "Make sure pi is installed before running this script." >&2
  exit 1
fi

$DRY_RUN && echo "[dry-run] No changes will be made."

errors=0
total_linked=0
total_removed=0

# ------------------------------------------------------------------
# Install one top-level item from a repo category into the pi dir.
# Removes anything already at the destination, then creates a symlink.
# ------------------------------------------------------------------
install_item() {
  local src="$1"       # absolute path inside the repo
  local category="$2"  # e.g. "agents", "extensions", "prompts", "skills"
  local name="$3"      # basename of the item (file or directory)

  local dest="$PI_DIR/$category/$name"

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    $DRY_RUN && echo "  [remove] $dest" || rm -rf "$dest"
    total_removed=$((total_removed + 1))
  fi

  $DRY_RUN && echo "  [link]   $dest → $src" || ln -sf "$src" "$dest"
  total_linked=$((total_linked + 1))
}

# ------------------------------------------------------------------
# Process all top-level items in a repo category directory.
# ------------------------------------------------------------------
install_category() {
  local category="$1"
  local src_dir="$REPO_DIR/$category"

  if [ ! -d "$src_dir" ]; then
    return
  fi

  echo "--- $category ---"

  for item in "$src_dir"/*; do
    [ -e "$item" ] || [ -L "$item" ] || continue  # skip empty glob
    local name; name="$(basename "$item")"
    install_item "$item" "$category" "$name"
  done

  echo ""
}

# ------------------------------------------------------------------
# Verify all symlinks resolve correctly.
# ------------------------------------------------------------------
verify() {
  echo "--- Verification ---"
  local issues=0

  while IFS= read -r -d '' sym; do
    if [ -e "$sym" ]; then
      :  # all good
    else
      echo "  ✗ BROKEN: $sym"
      issues=$((issues + 1))
    fi
  done < <(find "$PI_DIR/agents" "$PI_DIR/extensions" "$PI_DIR/prompts" "$PI_DIR/skills" -maxdepth 1 -type l -print0 2>/dev/null || true)

  if [ "$issues" -eq 0 ]; then
    echo "  ✓ All symlinks resolve correctly."
  else
    echo "  ✗ $issues broken symlink(s) found."
    errors=$((errors + issues))
  fi
}

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------
echo "Installing coding-agent-resources into pi..."
echo "  Repo: $REPO_DIR"
echo "  Pi:   $PI_DIR"
$DRY_RUN && echo "  Mode: dry-run"
echo ""

install_category "agents"
install_category "extensions"
install_category "prompts"
install_category "skills"

$DRY_RUN && { echo "Dry-run: would remove $total_removed item(s) and create $total_linked symlink(s)."; exit 0; }

verify

echo ""
echo "Removed $total_removed conflicting item(s), created $total_linked symlink(s)."
if [ "$errors" -eq 0 ]; then
  echo "✓ Installation complete."
else
  echo "✗ $errors error(s) encountered." >&2
  exit 1
fi
