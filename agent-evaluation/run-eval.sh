#!/usr/bin/env bash
# =============================================================================
# Pi Eval Runner
# Runs pi with @eval-prompt.md, monitors token usage in real-time,
# streams the model's text output to the terminal, and terminates the
# session if the context limit is exceeded.
# Usage: ./run-eval.sh [--model <model>] [--max-context <tokens>]
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
MODEL=""
MAX_CONTEXT=$DEFAULT_MAX_CONTEXT

while [ $# -gt 0 ]; do
    case "$1" in
        --model|-m)
            if [ $# -lt 2 ]; then
                echo "Error: --model requires a model identifier." >&2
                exit 1
            fi
            MODEL="$2"
            shift 2
            ;;
        --max-context|-c)
            if [ $# -lt 2 ]; then
                echo "Error: --max-context requires a token count." >&2
                exit 1
            fi
            MAX_CONTEXT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--model <model>] [--max-context <tokens>]"
            echo ""
            echo "Options:"
            echo "  -m, --model <model>        Model identifier (e.g. anthropic/claude-sonnet-4-20250514)"
            echo "                              If not set, you will be prompted interactively."
            echo "  -c, --max-context <tokens>  Max context window in tokens (default: $DEFAULT_MAX_CONTEXT)"
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
# Prompt for model (if not already set via --model)
# ---------------------------------------------------------------------------
if [ -z "$MODEL" ]; then
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
fi

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

# We use --mode json which emits every session event as a JSON line to stdout
# in real-time. This allows us to parse and display the model's text output
# as it streams, rather than only at the end (which is what -p / --print does).
#
# pi's stdout (JSON events) → pi-stream.jsonl (parsed for text display)
# pi's stderr               → terminal (errors visible to user)
# session file              → monitored for context limit enforcement
STREAM_FILE="$TMPDIR/pi-stream.jsonl"

set +e
pi --session-dir "$TMPDIR" --model "$MODEL" --mode json @eval-prompt.md > "$STREAM_FILE" &
PI_PID=$!
set -e

# ---------------------------------------------------------------------------
# Wait for session file to appear (with adaptive timeout)
# ---------------------------------------------------------------------------
SESSION_FILE=""
POLL=0
POLL_LIMIT=120  # Initial fast-poll phase: 120 * 0.5s = 60s
CONNECTING_SHOWN=0

while true; do
    SESSION_FILE=$(find "$TMPDIR" -maxdepth 1 -name "*.jsonl" ! -name "pi-stream.jsonl" -type f 2>/dev/null | head -1)
    if [ -n "$SESSION_FILE" ]; then
        break
    fi
    if ! kill -0 "$PI_PID" 2>/dev/null; then
        # pi exited before creating session file
        break
    fi

    if [ "$POLL" -ge "$POLL_LIMIT" ]; then
        if [ "$CONNECTING_SHOWN" -eq 0 ]; then
            echo -e "${DIM}Still waiting for initial connection (pi is still running)...${NC}"
            CONNECTING_SHOWN=1
        fi
        # Slow down polling after the initial fast phase to avoid busy-waiting
        sleep 2
    else
        sleep 0.5
        POLL=$((POLL + 1))
    fi
done

# ---------------------------------------------------------------------------
# Helper: display stream events from JSON lines
# ---------------------------------------------------------------------------
display_stream_events() {
    local file="$1"
    local start_line="$2"

    while IFS= read -r LINE; do
        # Track streaming start time when assistant begins generating
        IS_ASSISTANT_START=$(echo "$LINE" | jq -r 'select(.type == "message_start" and .message.role == "assistant") | "yes"' 2>/dev/null)
        if [ "$IS_ASSISTANT_START" = "yes" ]; then
            date +%s.%N > "$STREAM_START_FILE"
        fi

        # Show thinking/reasoning content (dimmed to distinguish from response)
        THINKING=$(echo "$LINE" | jq -r 'select(.type == "message_update" and .assistantMessageEvent.type == "thinking_delta") | .assistantMessageEvent.delta' 2>/dev/null)
        if [ -n "$THINKING" ] && [ "$THINKING" != "null" ]; then
            echo -en "${DIM}${THINKING}${NC}"
        fi

        # Extract text from text_delta events (token-level streaming)
        DELTA=$(echo "$LINE" | jq -r 'select(.type == "message_update" and .assistantMessageEvent.type == "text_delta") | .assistantMessageEvent.delta' 2>/dev/null)
        if [ -n "$DELTA" ] && [ "$DELTA" != "null" ]; then
            echo -n "$DELTA"
        fi

        # Add newline after assistant message ends
        IS_END=$(echo "$LINE" | jq -r 'select(.type == "message_end" and .message.role == "assistant") | "yes"' 2>/dev/null)
        if [ "$IS_END" = "yes" ]; then
            echo ""
        fi

        # Show stop reason when assistant message ends
        STOP_REASON=$(echo "$LINE" | jq -r 'select(.type == "message_end" and .message.role == "assistant") | .message.stopReason // ""' 2>/dev/null)
        if [ -n "$STOP_REASON" ] && [ "$STOP_REASON" != "null" ] && [ "$STOP_REASON" != "stop" ] && [ "$STOP_REASON" != "toolUse" ]; then
            echo -e "${DIM}[stopReason: ${STOP_REASON}]${NC}" >&2
        fi

        # Track streaming end time, accumulate duration
        IS_ASSISTANT_END=$(echo "$LINE" | jq -r 'select(.type == "message_end" and .message.role == "assistant") | "yes"' 2>/dev/null)
        if [ "$IS_ASSISTANT_END" = "yes" ] && [ -s "$STREAM_START_FILE" ]; then
            START=$(cat "$STREAM_START_FILE")
            END=$(date +%s.%N)
            DUR=$(echo "$END - $START" | bc 2>/dev/null || echo 0)
            TOTAL=$(cat "$STREAMING_TIME_FILE")
            TOTAL=$(echo "$TOTAL + $DUR" | bc 2>/dev/null || echo 0)
            echo "$TOTAL" > "$STREAMING_TIME_FILE"
            : > "$STREAM_START_FILE"
        fi

        # Show tool execution start
        # Use tostring to safely handle both string and object args
        TOOL_START=$(echo "$LINE" | jq -r 'select(.type == "tool_execution_start") | "\(.toolName)(\(( .args | tostring )[0:200]))"' 2>/dev/null)
        if [ -n "$TOOL_START" ] && [ "$TOOL_START" != "null" ]; then
            echo -e "\n${DIM}⚡ ${TOOL_START}${NC}"
        fi

        # Show tool execution end
        TOOL_END=$(echo "$LINE" | jq -r 'select(.type == "tool_execution_end" and .isError == false) | "\(.toolName) ok"' 2>/dev/null)
        if [ -n "$TOOL_END" ] && [ "$TOOL_END" != "null" ]; then
            echo -e "${DIM}  ${TOOL_END}${NC}"
        fi
        TOOL_ERR=$(echo "$LINE" | jq -r 'select(.type == "tool_execution_end" and .isError == true) | "\(.toolName) ERROR"' 2>/dev/null)
        if [ -n "$TOOL_ERR" ] && [ "$TOOL_ERR" != "null" ]; then
            echo -e "${DIM}  ${TOOL_ERR}${NC}"
        fi
    done < <(tail -n "+$((start_line + 1))" "$file" 2>/dev/null)
}

# ---------------------------------------------------------------------------
# Monitor session file for token usage, and stream file for text output
# ---------------------------------------------------------------------------
LIMIT_EXCEEDED=0
LAST_SESSION_LINE_COUNT=0
LAST_STREAM_LINE_COUNT=0
LATEST_TOTAL_TOKENS=0
LATEST_USAGE_INPUT=0
LATEST_USAGE_OUTPUT=0

# Streaming timing tracking (wall-clock time between message_start and message_end)
STREAM_START_FILE="$TMPDIR/stream-start"
STREAMING_TIME_FILE="$TMPDIR/streaming-time"
echo 0 > "$STREAMING_TIME_FILE"
: > "$STREAM_START_FILE"

if [ -n "$SESSION_FILE" ] && [ -f "$SESSION_FILE" ]; then
    # Get initial line counts
    LAST_SESSION_LINE_COUNT=$(wc -l < "$SESSION_FILE" 2>/dev/null || echo 0)
    LAST_STREAM_LINE_COUNT=$(wc -l < "$STREAM_FILE" 2>/dev/null || echo 0)

    # Monitor loop: polls while pi runs, or until limit exceeded
    # Disable set -e for the monitoring loop because jq failures (e.g.
    # tool_execution_start with object args) must not abort the script.
    set +e
    while true; do
        # --- Read new JSON events from the stream file and display text ---
        CURRENT_STREAM_COUNT=$(wc -l < "$STREAM_FILE" 2>/dev/null || echo 0)
        if [ "$CURRENT_STREAM_COUNT" -gt "$LAST_STREAM_LINE_COUNT" ]; then
            display_stream_events "$STREAM_FILE" "$LAST_STREAM_LINE_COUNT"
            LAST_STREAM_LINE_COUNT=$CURRENT_STREAM_COUNT
        fi

        # --- Read any new lines from the session file for usage monitoring ---
        CURRENT_SESSION_COUNT=$(wc -l < "$SESSION_FILE" 2>/dev/null || echo 0)
        if [ "$CURRENT_SESSION_COUNT" -gt "$LAST_SESSION_LINE_COUNT" ]; then
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
            done < <(tail -n "+$((LAST_SESSION_LINE_COUNT + 1))" "$SESSION_FILE" 2>/dev/null)

            LAST_SESSION_LINE_COUNT=$CURRENT_SESSION_COUNT
        fi

        # Check if pi is still running (after reading output)
        if ! kill -0 "$PI_PID" 2>/dev/null; then
            break
        fi

        sleep 0.2
    done
fi

# ---------------------------------------------------------------------------
# Final drain: capture any remaining stream events after pi exited
# ---------------------------------------------------------------------------
CURRENT_STREAM_COUNT=$(wc -l < "$STREAM_FILE" 2>/dev/null || echo 0)
if [ "$CURRENT_STREAM_COUNT" -gt "${LAST_STREAM_LINE_COUNT:-0}" ]; then
    display_stream_events "$STREAM_FILE" "${LAST_STREAM_LINE_COUNT:-0}"
fi
set -e

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

# Capture pi exit code (if it has exited)
PI_EXIT_CODE=""
if ! kill -0 "$PI_PID" 2>/dev/null; then
    wait "$PI_PID" 2>/dev/null
    PI_EXIT_CODE=$?
fi

echo -e "${DIM}────────────────────────────────────────────────────${NC}"
echo ""

# ---------------------------------------------------------------------------
# Detect session file (re-check in case it appeared after pi exited)
# ---------------------------------------------------------------------------
if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
    SESSION_FILE=$(find "$TMPDIR" -maxdepth 1 -name "*.jsonl" ! -name "pi-stream.jsonl" -type f 2>/dev/null | head -1)
fi

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
    echo -e "${YELLOW}No session file found. Usage data not available.${NC}"
    echo ""
    echo -e "${BOLD}Exit code:${NC} ${PI_EXIT_CODE:-N/A}"
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
# represent the final context state. The per-turn output values are summed
# for total output across all turns.
STATS=$(jq -s '
    [.[] | select(.message.usage != null) | {usage: .message.usage, stopReason: .message.stopReason}] |
    if length == 0 then empty
    else
        {
            total_output:      (map(.usage.output) | add),
            total_cost:        (map(.usage.cost.total) | add),
            turn_count:        length,
            last_input:        (last | .usage.input),
            last_output:       (last | .usage.output),
            last_total:        (last | .usage.totalTokens),
            last_stop_reason:  (last | .stopReason // "")
        }
    end
' "$SESSION_FILE")

if [ -n "$STATS" ]; then
    TOTAL_OUTPUT=$(echo "$STATS" | jq -r '.total_output')
    TOTAL_COST=$(echo "$STATS" | jq -r '.total_cost')
    TURN_COUNT=$(echo "$STATS" | jq -r '.turn_count')
    LAST_INPUT=$(echo "$STATS" | jq -r '.last_input')
    LAST_OUTPUT=$(echo "$STATS" | jq -r '.last_output')
    LAST_TOTAL=$(echo "$STATS" | jq -r '.last_total')
    LAST_STOP_REASON=$(echo "$STATS" | jq -r '.last_stop_reason')

    # Tokens per second (based on wall-clock streaming time)
    TOTAL_STREAMING_TIME=$(cat "$STREAMING_TIME_FILE" 2>/dev/null || echo 0)
    if [ -n "$TOTAL_STREAMING_TIME" ] && [ "$(echo "$TOTAL_STREAMING_TIME > 0" | bc 2>/dev/null)" = "1" ]; then
        TOKENS_PER_SEC=$(echo "scale=1; $TOTAL_OUTPUT / $TOTAL_STREAMING_TIME" | bc 2>/dev/null || echo "0")
    else
        TOKENS_PER_SEC="N/A"
    fi

    # Session message summary
    echo ""
    echo -e "${BOLD}Session Messages:${NC}"
    echo ""

    # Display each message with its full content
    jq -r '
        select(.type == "message") |
        if .message.role == "assistant" then
            "  [assistant] stopReason=" + (.message.stopReason // "?") +
            "  in=" + ((.message.usage.input // 0)|tostring) +
            " out=" + ((.message.usage.output // 0)|tostring) +
            "  total=" + ((.message.usage.totalTokens // 0)|tostring) +
            (if (.message.content | length) > 0 then
                "\n" + (
                    [.message.content[]? |
                        if .type == "text" then "    text: " + .text
                        elif .type == "thinking" then "    thinking: " + .thinking
                        elif .type == "toolCall" then "    toolCall: " + .name + "(" + (.arguments | tostring) + ")"
                        else "    " + .type
                        end
                    ] | join("\n")
                )
            else
                "  (empty)"
            end)
        elif .message.role == "user" then
            "  [user]\n" + (
                [.message.content[]? |
                    if .type == "text" then "    " + .text
                    else "    " + .type
                    end
                ] | join("\n")
            )
        elif .message.role == "toolResult" then
            "  [toolResult] " + (.message.toolName // "?") + " (" + (.message.toolCallId // "?") + ")\n" + (
                [.message.content[]? |
                    if .type == "text" then "    " + .text
                    else "    " + .type
                    end
                ] | join("\n")
            )
        else
            "  [" + .message.role + "]"
        end
    ' "$SESSION_FILE" 2>/dev/null | while IFS= read -r line; do
        echo -e "${NC}${line}${NC}"
    done

    # Performance metrics
    echo ""
    echo -e "${BOLD}Performance:${NC}"
    printf "  %-16s %s\n" "Turns:"       "$TURN_COUNT"
    printf "  %-16s %s\n" "Input:"       "$(printf "%'d" "$LAST_INPUT") tokens"
    printf "  %-16s %s\n" "Output:"      "$(printf "%'d" "$TOTAL_OUTPUT") tokens"
    printf "  %-16s %s\n" "Total:"       "$(printf "%'d" "$LAST_TOTAL") tokens"
    printf "  %-16s %s\n" "Tokens/s:"    "${TOKENS_PER_SEC}"

    # Show last response stop reason
    if [ -n "$LAST_STOP_REASON" ] && [ "$LAST_STOP_REASON" != "null" ] && [ "$LAST_STOP_REASON" != "stop" ] && [ "$LAST_STOP_REASON" != "toolUse" ]; then
        echo -e "  ${DIM}Last response stopReason: ${LAST_STOP_REASON}${NC}"
    fi

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

# ---------------------------------------------------------------------------
# Update eval-results.md
# ---------------------------------------------------------------------------
RESULTS_FILE="$SCRIPT_DIR/eval-results.md"

# Format date from start epoch (GNU date first, then BSD, then fallback)
if date -d "@$START_EPOCH" '+%Y-%m-%d %H:%M' >/dev/null 2>&1; then
    RUN_DATE=$(date -d "@$START_EPOCH" '+%Y-%m-%d %H:%M')
elif date -r "$START_EPOCH" '+%Y-%m-%d %H:%M' >/dev/null 2>&1; then
    RUN_DATE=$(date -r "$START_EPOCH" '+%Y-%m-%d %H:%M')
else
    RUN_DATE=$(date '+%Y-%m-%d %H:%M')
fi

# Duration: prefer session duration, fall back to wall clock
DURATION="${DURATION_STR:-${WALL_CLOCK}s}"

# Total context used (final context total from last message)
TOTAL_CONTEXT="${LAST_TOTAL:-N/A}"

# Turns
TURNS="${TURN_COUNT:-N/A}"

# Limit string
if [ "$MAX_CONTEXT" -gt 0 ]; then
    LIMIT_STR="$MAX_CONTEXT"
else
    LIMIT_STR="unlimited"
fi

# Exceeded string
if [ "$LIMIT_EXCEEDED" -eq 1 ]; then
    EXCEEDED_STR="Yes"
else
    EXCEEDED_STR="No"
fi

# Exit code
if [ "$LIMIT_EXCEEDED" -eq 1 ]; then
    EXIT_CODE=2
else
    EXIT_CODE=0
fi

# ---------------------------------------------------------------------------
# Post-checks: validate tests pass and test files were not modified
# ---------------------------------------------------------------------------
NOTES=""
if [ "$EXIT_CODE" -eq 0 ]; then
    echo ""
    echo -e "${BOLD}${CYAN}Running post-checks...${NC}"

    # Check 1: npx vitest run test/
    echo -e "${DIM}  [1/2] Running npx vitest run test/...${NC}"
    set +e
    npx vitest run test/ > "$TMPDIR/vitest-output.log" 2>&1
    VITEST_EXIT=$?
    set -e
    if [ "$VITEST_EXIT" -ne 0 ]; then
        echo -e "  ${RED}✗ Tests failed (exit code: $VITEST_EXIT)${NC}"
        NOTES="vitest failed"
        EXIT_CODE=1
    else
        echo -e "  ${GREEN}✓ Tests passed${NC}"
    fi

    # Check 2: No changes to test/ or .gitignore
    echo -e "${DIM}  [2/2] Checking for modifications to test/ and .gitignore...${NC}"
    set +e
    GIT_CHANGES=$(git status --porcelain -- "test/" ".gitignore" 2>/dev/null)
    set -e
    if [ -n "$GIT_CHANGES" ]; then
        echo -e "  ${RED}✗ Unauthorized modifications detected:${NC}"
        echo "$GIT_CHANGES" | sed 's/^/      /'
        if [ -z "$NOTES" ]; then
            NOTES="test files modified"
        else
            NOTES="${NOTES}, test files modified"
        fi
        EXIT_CODE=1
    else
        echo -e "  ${GREEN}✓ No unauthorized modifications${NC}"
    fi

    if [ "$EXIT_CODE" -eq 0 ]; then
        echo -e "${GREEN}${BOLD}All checks passed.${NC}"
    else
        echo -e "${RED}${BOLD}Post-checks failed.${NC}"
    fi
fi

# Create file with header if it doesn't exist
if [ ! -f "$RESULTS_FILE" ]; then
    printf '%s\n\n%s\n%s\n' \
        '# Evaluation Results' \
        '| Date | Model | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Notes |' \
        '|---|---|---|---|---|---|---|---|---|' > "$RESULTS_FILE"
fi

# Append row
printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n" \
    "$RUN_DATE" "$MODEL" "$DURATION" "$TOTAL_CONTEXT" \
    "$TURNS" "$LIMIT_STR" "$EXCEEDED_STR" "$EXIT_CODE" "$NOTES" >> "$RESULTS_FILE"
echo ""
echo -e "${GREEN}Results appended to:${NC} $RESULTS_FILE"

# Don't clean up so user can inspect the session file
CLEANUP=0
exit "$EXIT_CODE"