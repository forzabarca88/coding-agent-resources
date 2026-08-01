#!/usr/bin/env bash
# =============================================================================
# Pi Eval Runner
# Runs pi with @eval-prompt.md, monitors token usage in real-time, and
# terminates the session if the limit is exceeded.
# Usage: ./run-eval.sh [--max-context <tokens>]
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DEFAULT_MAX_CONTEXT=64000

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Parse CLI arguments
# ---------------------------------------------------------------------------
MAX_CONTEXT=$DEFAULT_MAX_CONTEXT

while [ $# -gt 0 ]; do
    case "$1" in
        --max-context|-m)
            if [ $# -lt 2 ]; then
                echo "Error: --max-context requires a token count." >&2
                exit 1
            fi
            MAX_CONTEXT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--max-context <tokens>]"
            echo ""
            echo "Options:"
            echo "  -m, --max-context <tokens>  Max context window in tokens (default: $DEFAULT_MAX_CONTEXT)"
            echo "                               Set to 0 to disable the limit."
            echo "  -h, --help                  Show this help"
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

if ! [[ "$MAX_CONTEXT" =~ ^[0-9]+$ ]]; then
    echo "Error: --max-context must be a positive integer." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
for cmd in pi jq bc; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is required but not found in PATH." >&2
        exit 1
    fi
done

if [ ! -f "eval-prompt.md" ]; then
    echo "Error: eval-prompt.md not found in $SCRIPT_DIR" >&2
    exit 1
fi

# Colours for output
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Colour

# ---------------------------------------------------------------------------
# Prompt for model
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║          Pi Eval Runner                      ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo ""

read -r -p "$(echo -e "${CYAN}Enter model${NC} ${DIM}(e.g. anthropic/claude-sonnet-4-20250514)${NC}: ")" MODEL

MODEL="${MODEL## }"
MODEL="${MODEL%% }"

if [ -z "$MODEL" ]; then
    echo -e "${RED}Error: Model is required.${NC}" >&2
    exit 1
fi

echo ""

# ---------------------------------------------------------------------------
# Create temp directory for session isolation
# ---------------------------------------------------------------------------
TMPDIR=$(mktemp -d) || { echo "Error: Failed to create temp directory" >&2; exit 1; }
CLEANUP=1

cleanup() {
    # Kill pi if still running
    if [ -n "${PI_PID:-}" ] && kill -0 "$PI_PID" 2>/dev/null; then
        kill "$PI_PID" 2>/dev/null || true
        wait "$PI_PID" 2>/dev/null || true
    fi
    # Remove temp dir
    if [ "$CLEANUP" -eq 1 ]; then
        rm -rf "$TMPDIR"
    fi
}

trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Start pi
# ---------------------------------------------------------------------------
echo -e "${BOLD}Model:${NC}        $MODEL"
echo -e "${BOLD}Prompt:${NC}       @eval-prompt.md"
echo -e "${BOLD}Mode:${NC}         non-interactive (streaming)"
if [ "$MAX_CONTEXT" -gt 0 ]; then
    echo -e "${BOLD}Max context:${NC}   $(printf "%'d" "$MAX_CONTEXT") tokens"
fi
echo ""
echo -e "${DIM}────────────────────────────────────────────────────${NC}"

# Record start time
START_EPOCH=$(date +%s)

# Start pi in the background
# --session-dir isolates the session file to our temp dir
# -p processes the prompt and exits
set +e
pi --session-dir "$TMPDIR" --model "$MODEL" -p @eval-prompt.md &
PI_PID=$!
set -e

# ---------------------------------------------------------------------------
# Wait for session file to appear
# ---------------------------------------------------------------------------
SESSION_FILE=""
POLL=0
while [ "$POLL" -lt 60 ]; do  # Wait up to 30s
    SESSION_FILE=$(find "$TMPDIR" -name "*.jsonl" -type f 2>/dev/null | head -1)
    if [ -n "$SESSION_FILE" ]; then
        break
    fi
    if ! kill -0 "$PI_PID" 2>/dev/null; then
        # pi exited before creating session file
        break
    fi
    sleep 0.5
    POLL=$((POLL + 1))
done

# ---------------------------------------------------------------------------
# Monitor session file for token usage
# ---------------------------------------------------------------------------
LIMIT_EXCEEDED=0
LAST_LINE_COUNT=0
LATEST_TOTAL_TOKENS=0
LATEST_USAGE_INPUT=0
LATEST_USAGE_OUTPUT=0

if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
    # Get initial line count
    LAST_LINE_COUNT=$(wc -l < "$SESSION_FILE" 2>/dev/null || echo 0)

    # Monitor loop: polls while pi runs, or until limit exceeded
    while true; do
        # Check if pi is still running
        if ! kill -0 "$PI_PID" 2>/dev/null; then
            break
        fi

        # Read any new lines from the session file
        CURRENT_LINE_COUNT=$(wc -l < "$SESSION_FILE" 2>/dev/null || echo 0)
        if [ "$CURRENT_LINE_COUNT" -gt "$LAST_LINE_COUNT" ]; then
            # Process new lines (from the last unread line onward)
            # Use tail to get only new lines
            while IFS= read -r LINE; do
                # Check if this line has usage data (assistant message or compaction)
                USAGE=$(echo "$LINE" | jq -r 'select(.message.usage != null) | .message.usage.totalTokens' 2>/dev/null)
                if [ -n "$USAGE" ] && [ "$USAGE" != "null" ] && [ "$USAGE" -gt 0 ] 2>/dev/null; then
                    LATEST_TOTAL_TOKENS=$USAGE
                    LATEST_USAGE_INPUT=$(echo "$LINE" | jq -r 'select(.message.usage != null) | .message.usage.input' 2>/dev/null)
                    LATEST_USAGE_OUTPUT=$(echo "$LINE" | jq -r 'select(.message.usage != null) | .message.usage.output' 2>/dev/null)

                    # Check if limit exceeded
                    if [ "$MAX_CONTEXT" -gt 0 ] && [ "$LATEST_TOTAL_TOKENS" -gt "$MAX_CONTEXT" ]; then
                        LIMIT_EXCEEDED=1
                        break 2  # break out of both loops
                    fi
                fi
            done < <(tail -n "+$((LAST_LINE_COUNT + 1))" "$SESSION_FILE" 2>/dev/null)

            LAST_LINE_COUNT=$CURRENT_LINE_COUNT
        fi

        sleep 0.2
    done
fi

# ---------------------------------------------------------------------------
# Handle limit exceeded
# ---------------------------------------------------------------------------
if [ "$LIMIT_EXCEEDED" -eq 1 ]; then
    echo ""
    echo -e "${RED}⚠ Context limit exceeded!${NC}"
    echo -e "${YELLOW}  Total tokens (input + output): $(printf "%'d" "$LATEST_TOTAL_TOKENS")"
    echo -e "  Limit: $(printf "%'d" "$MAX_CONTEXT")${NC}"
    echo ""

    # Kill pi
    kill "$PI_PID" 2>/dev/null || true
    # Give it a moment to flush the session file
    sleep 0.5
    # Force kill if still running
    if kill -0 "$PI_PID" 2>/dev/null; then
        kill -9 "$PI_PID" 2>/dev/null || true
    fi
    wait "$PI_PID" 2>/dev/null || true
fi

END_EPOCH=$(date +%s)
WALL_CLOCK=$((END_EPOCH - START_EPOCH))

echo -e "${DIM}────────────────────────────────────────────────────${NC}"
echo ""

# ---------------------------------------------------------------------------
# Detect session file (re-check in case it appeared after pi exited)
# ---------------------------------------------------------------------------
if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
    SESSION_FILE=$(find "$TMPDIR" -name "*.jsonl" -type f 2>/dev/null | head -1)
fi

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
    echo -e "${YELLOW}No session file found. Usage data not available.${NC}"
    echo ""
    echo -e "${BOLD}Exit code:${NC} $([[ -n "${PI_EXIT:-}" ]] && echo "$PI_EXIT" || echo "N/A")"
    echo -e "${BOLD}Wall clock:${NC} ${WALL_CLOCK}s"
    exit 0
fi

# ---------------------------------------------------------------------------
# Parse and display session stats
# ---------------------------------------------------------------------------
echo -e "${BOLD}${GREEN}Session Statistics${NC}"
echo -e "${DIM}────────────────────────────────────────────────────${NC}"

# Session metadata
SESSION_ID=$(jq -r 'select(.type == "session") | .id // "unknown"' "$SESSION_FILE" | head -1)
MODEL_USED=$(jq -r 'select(.type == "model_change") | .modelId // "unknown"' "$SESSION_FILE" | head -1)
PROVIDER=$(jq -r 'select(.type == "model_change") | .provider // "unknown"' "$SESSION_FILE" | head -1)

echo -e "${BOLD}Session ID:${NC}   ${SESSION_ID:-unknown}"
echo -e "${BOLD}Model:${NC}        ${PROVIDER:-unknown}/${MODEL_USED:-unknown}"

# Calculate duration from session timestamps
FIRST_TS=$(jq -r 'select(.type == "session") | .timestamp' "$SESSION_FILE" | head -1)
LAST_TS=$(jq -r 'select(.message.usage != null) | .timestamp' "$SESSION_FILE" | tail -n 1)

if [ -n "$FIRST_TS" ] && [ -n "$LAST_TS" ]; then
    FIRST_EPOCH=$(echo "$FIRST_TS" | jq -Rr 'gsub("\\.[0-9]+Z$"; "Z") | fromdateiso8601')
    LAST_EPOCH=$(echo "$LAST_TS" | jq -Rr 'gsub("\\.[0-9]+Z$"; "Z") | fromdateiso8601')
    SESSION_DURATION=$((LAST_EPOCH - FIRST_EPOCH))

    if [ "$SESSION_DURATION" -ge 60 ]; then
        MINUTES=$((SESSION_DURATION / 60))
        SECONDS=$((SESSION_DURATION % 60))
        DURATION_STR="${MINUTES}m ${SECONDS}s"
    else
        DURATION_STR="${SESSION_DURATION}s"
    fi
    echo -e "${BOLD}Duration:${NC}     ${DURATION_STR} ${DIM}(session time)${NC}"
    echo -e "${BOLD}Wall clock:${NC}   ${WALL_CLOCK}s"
fi

# Aggregate token usage from all assistant messages
# Note: usage.input is cumulative per message, so the last message's values
# represent the final context state. But we still sum totalTokens across
# all messages for the session total.
STATS=$(jq -s '
    [.[] | select(.message.usage != null) | .message.usage] |
    if length == 0 then empty
    else
        {
            total_input:       (map(.input) | add),
            total_output:      (map(.output) | add),
            total_tokens:      (map(.totalTokens) | add),
            total_cache_read:  (map(.cacheRead) | add // 0),
            total_cache_write: (map(.cacheWrite) | add // 0),
            total_cost:        (map(.cost.total) | add),
            turn_count:        length,
            last_input:        (last | .input),
            last_output:       (last | .output),
            last_total:        (last | .totalTokens)
        }
    end
' "$SESSION_FILE")

if [ -n "$STATS" ]; then
    TOTAL_INPUT=$(echo "$STATS" | jq -r '.total_input')
    TOTAL_OUTPUT=$(echo "$STATS" | jq -r '.total_output')
    TOTAL_TOKENS=$(echo "$STATS" | jq -r '.total_tokens')
    TOTAL_CACHE_READ=$(echo "$STATS" | jq -r '.total_cache_read')
    TOTAL_CACHE_WRITE=$(echo "$STATS" | jq -r '.total_cache_write')
    TOTAL_COST=$(echo "$STATS" | jq -r '.total_cost')
    TURN_COUNT=$(echo "$STATS" | jq -r '.turn_count')
    LAST_INPUT=$(echo "$STATS" | jq -r '.last_input')
    LAST_OUTPUT=$(echo "$STATS" | jq -r '.last_output')
    LAST_TOTAL=$(echo "$STATS" | jq -r '.last_total')

    # Tokens per second
    if [ -n "${SESSION_DURATION:-}" ] && [ "$SESSION_DURATION" -gt 0 ]; then
        TOKENS_PER_SEC=$(echo "scale=1; $TOTAL_TOKENS / $SESSION_DURATION" | bc 2>/dev/null || echo "0")
    else
        TOKENS_PER_SEC="N/A"
    fi

    echo ""
    echo -e "${BOLD}Token Usage:${NC}"
    printf "  %-16s %s\n" "Input:"       "$(printf "%'d" "$TOTAL_INPUT") tokens"
    printf "  %-16s %s\n" "Output:"      "$(printf "%'d" "$TOTAL_OUTPUT") tokens"
    printf "  %-16s %s\n" "Total:"       "$(printf "%'d" "$TOTAL_TOKENS") tokens"
    printf "  %-16s %s\n" "Cache Read:"  "$(printf "%'d" "$TOTAL_CACHE_READ") tokens"
    printf "  %-16s %s\n" "Cache Write:" "$(printf "%'d" "$TOTAL_CACHE_WRITE") tokens"
    echo ""

    echo -e "${BOLD}Final Context State:${NC}"
    printf "  %-16s %s\n" "Input:"       "$(printf "%'d" "$LAST_INPUT") tokens"
    printf "  %-16s %s\n" "Output:"      "$(printf "%'d" "$LAST_OUTPUT") tokens"
    printf "  %-16s %s\n" "Total:"       "$(printf "%'d" "$LAST_TOTAL") tokens"
    echo ""

    echo -e "${BOLD}Performance:${NC}"
    printf "  %-16s %s\n" "Turns:"       "$TURN_COUNT"
    printf "  %-16s %s\n" "Tokens/s:"    "${TOKENS_PER_SEC}"

    if [ "$(echo "$TOTAL_COST > 0" | bc 2>/dev/null)" = "1" ]; then
        echo ""
        echo -e "${BOLD}Cost:${NC}"
        printf "  %-16s \$%.4f\n" "Total:" "$TOTAL_COST"
    fi

    # Context limit enforcement result
    if [ "$MAX_CONTEXT" -gt 0 ]; then
        echo ""
        echo -e "${BOLD}Context Limit:${NC}"
        printf "  %-16s %s\n" "Limit:" "$(printf "%'d" "$MAX_CONTEXT") tokens"

        if [ "$LIMIT_EXCEEDED" -eq 1 ]; then
            PCT=$(echo "scale=1; $LAST_TOTAL * 100 / $MAX_CONTEXT" | bc)
            OVER=$((LAST_TOTAL - MAX_CONTEXT))
            echo -e "  ${RED}⚠ EXCEEDED${NC}  Final context was $(printf "%'d" "$LAST_TOTAL") tokens (${PCT}%, ${OVER} over limit)"
        else
            PCT=$(echo "scale=1; $LAST_TOTAL * 100 / $MAX_CONTEXT" | bc)
            echo -e "  ${GREEN}✓ Within limit${NC}  Final context was $(printf "%'d" "$LAST_TOTAL") tokens (${PCT}% of limit)"
        fi
    fi
else
    echo ""
    echo -e "${YELLOW}No token usage data found in session file.${NC}"
fi

echo -e "${DIM}────────────────────────────────────────────────────${NC}"
echo ""
echo -e "${GREEN}Session file:${NC} $SESSION_FILE"

# Don't clean up so user can inspect the session file
CLEANUP=0
if [ "$LIMIT_EXCEEDED" -eq 1 ]; then
    exit 2
fi
exit 0