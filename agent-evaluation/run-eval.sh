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
# Helper: append a row to eval-results.md (create header if missing)
# ---------------------------------------------------------------------------
RESULTS_FILE="$SCRIPT_DIR/eval-results.md"

append_eval_results() {
    local date="$1" model="$2" duration="$3" context="$4"
    local turns="$5" limit="$6" exceeded="$7" exit_code="$8"
    local passed_tests="$9" failed_tests="${10}" notes="${11}"

    if [ ! -f "$RESULTS_FILE" ]; then
        printf '%s\n\n%s\n%s\n' \
            '# Evaluation Results' \
            '| Date | Model | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Notes |' \
            '|---|---|---|---|---|---|---|---|---|---|---|' > "$RESULTS_FILE"
    fi

    printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n" \
        "$date" "$model" "$duration" "$context" \
        "$turns" "$limit" "$exceeded" "$exit_code" \
        "$passed_tests" "$failed_tests" "$notes" >> "$RESULTS_FILE"

    echo -e "${GREEN}Results appended to:${NC} $RESULTS_FILE"
}

# ---------------------------------------------------------------------------
# Helper: parse basic stats from a session file and append to eval-results.md
# Used by the cleanup trap when the script is interrupted.
# ---------------------------------------------------------------------------
append_eval_results_from_session() {
    local session_file="$1" model="$2" max_context="$3" exit_code="$4" notes="$5"

    if [ ! -f "$session_file" ]; then
        return 1
    fi

    # Extract what we can from the session file
    local run_date=$(date '+%Y-%m-%d %H:%M')
    local duration="?"
    local total_context="?"
    local turns="?"
    local limit_str="$max_context"
    local exceeded_str="?"

    # Parse duration from session timestamps (using jq fromdateiso8601 for portability)
    local first_ts=$(jq -r 'select(.type == "session") | .timestamp' "$session_file" 2>/dev/null | head -1)
    local last_ts=$(jq -r 'select(.message.usage != null) | .timestamp' "$session_file" 2>/dev/null | tail -n 1)
    if [ -n "$first_ts" ] && [ -n "$last_ts" ]; then
        local first_epoch=$(echo "$first_ts" | jq -Rr 'gsub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' 2>/dev/null)
        local last_epoch=$(echo "$last_ts" | jq -Rr 'gsub("\\.[0-9]+Z$"; "Z") | fromdateiso8601' 2>/dev/null)
        if [ -n "$first_epoch" ] && [ -n "$last_epoch" ] && [ "$last_epoch" -gt "$first_epoch" ] 2>/dev/null; then
            local secs=$((last_epoch - first_epoch))
            if [ "$secs" -ge 60 ]; then
                duration="$((secs / 60))m $((secs % 60))s"
            else
                duration="${secs}s"
            fi
        fi
    fi

    # Parse latest token usage
    local stats=$(jq -s '
        [.[] | select(.message.usage != null) | {usage: .message.usage}] |
        if length == 0 then empty
        else {
            total_output: (map(.usage.output) | add),
            turn_count:   length,
            last_total:   (last | .usage.totalTokens),
            last_input:   (last | .usage.input),
            last_output:  (last | .usage.output)
        } end
    ' "$session_file" 2>/dev/null)

    if [ -n "$stats" ]; then
        total_context=$(echo "$stats" | jq -r '.last_total // "?"')
        turns=$(echo "$stats" | jq -r '.turn_count // "?"')
    fi

    if [ "$max_context" -gt 0 ] 2>/dev/null; then
        if [ "$total_context" != "?" ] && [ "$total_context" -gt "$max_context" ] 2>/dev/null; then
            exceeded_str="Yes"
        else
            exceeded_str="No"
        fi
    else
        limit_str="unlimited"
        exceeded_str="N/A"
    fi

    append_eval_results "$run_date" "$model" "$duration" "$total_context" \
        "$turns" "$limit_str" "$exceeded_str" "$exit_code" "?" "?" "$notes"
}

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
RESULTS_WRITTEN=0

cleanup() {
    # Kill pi if still running
    if [ -n "${PI_PID:-}" ] && kill -0 "$PI_PID" 2>/dev/null; then
        kill "$PI_PID" 2>/dev/null || true
        wait "$PI_PID" 2>/dev/null || true
    fi
    # If the normal flow didn't get to write results, salvage what we can
    # from the session file so the run is not lost entirely.
    if [ "$RESULTS_WRITTEN" -eq 0 ] && [ -n "${SESSION_FILE:-}" ] && [ -f "$SESSION_FILE" ]; then
        append_eval_results_from_session "$SESSION_FILE" "$MODEL" "$MAX_CONTEXT" 1 "interrupted"
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
        # Preserve temp dir from this point, so killing the script still
        # leaves the session data available for inspection / recovery.
        CLEANUP=0
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
#
# Uses a single jq pass over all new lines instead of ~7 jq forks per line.
# Text/thinking deltas are base64-encoded by jq (they may contain newlines)
# and decoded in bash with a single base64 -d fork per delta line.
# ---------------------------------------------------------------------------
display_stream_events() {
    local file="$1"
    local start_line="$2"

    tail -n "+$((start_line + 1))" "$file" 2>/dev/null | jq -r '
        if   .type == "message_start" and .message.role == "assistant" then
            "START"
        elif .type == "message_update" and .assistantMessageEvent.type == "thinking_delta" then
            "THINK\t" + ((.assistantMessageEvent.delta // "") | @base64)
        elif .type == "message_update" and .assistantMessageEvent.type == "text_delta" then
            "TEXT\t" + ((.assistantMessageEvent.delta // "") | @base64)
        elif .type == "message_end" and .message.role == "assistant" then
            "END\t" + (.message.stopReason // "stop")
        elif .type == "tool_execution_start" then
            "TSTART\t" + .toolName + "(" + ((.args | tostring)[0:200]) + ")"
        elif .type == "tool_execution_end" and .isError == false then
            "TOK\t" + .toolName
        elif .type == "tool_execution_end" and .isError == true then
            "TERR\t" + .toolName
        else
            empty
        end
    ' 2>/dev/null | while IFS=$'\t' read -r TAG PAYLOAD; do
        case "$TAG" in
            START)
                date +%s.%N > "$STREAM_START_FILE"
                ;;
            THINK)
                echo -en "${DIM}$(printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null)${NC}"
                ;;
            TEXT)
                echo -n "$(printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null)"
                ;;
            END)
                echo ""
                if [ -n "$PAYLOAD" ] && [ "$PAYLOAD" != "stop" ] && [ "$PAYLOAD" != "toolUse" ]; then
                    echo -e "${DIM}[stopReason: ${PAYLOAD}]${NC}" >&2
                fi
                if [ -s "$STREAM_START_FILE" ]; then
                    START=$(cat "$STREAM_START_FILE")
                    END=$(date +%s.%N)
                    DUR=$(echo "$END - $START" | bc 2>/dev/null || echo 0)
                    TOTAL=$(cat "$STREAMING_TIME_FILE")
                    TOTAL=$(echo "$TOTAL + $DUR" | bc 2>/dev/null || echo 0)
                    echo "$TOTAL" > "$STREAMING_TIME_FILE"
                    : > "$STREAM_START_FILE"
                fi
                ;;
            TSTART)
                echo -e "\n${DIM}⚡ ${PAYLOAD}${NC}"
                ;;
            TOK)
                echo -e "${DIM}  ${PAYLOAD} ok${NC}"
                ;;
            TERR)
                echo -e "${DIM}  ${PAYLOAD} ERROR${NC}"
                ;;
        esac
    done
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
            # Single jq pass over new session lines to extract usage data
            while IFS=$'\t' read -r TOTAL INPUT OUTPUT; do
                if [ -n "$TOTAL" ] && [ "$TOTAL" != "null" ] && [ "$TOTAL" -gt 0 ] 2>/dev/null; then
                    LATEST_TOTAL_TOKENS=$TOTAL
                    LATEST_USAGE_INPUT=$INPUT
                    LATEST_USAGE_OUTPUT=$OUTPUT

                    # Check if limit exceeded
                    if [ "$MAX_CONTEXT" -gt 0 ] && [ "$LATEST_TOTAL_TOKENS" -gt "$MAX_CONTEXT" ]; then
                        LIMIT_EXCEEDED=1
                        break 2  # break out of both loops
                    fi
                fi
            done < <(tail -n "+$((LAST_SESSION_LINE_COUNT + 1))" "$SESSION_FILE" 2>/dev/null | jq -r '
                select(.message.usage != null) |
                [.message.usage.totalTokens, .message.usage.input, .message.usage.output] |
                @tsv
            ' 2>/dev/null)

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
PASSED_TESTS="?"
FAILED_TESTS="?"
if [ "$EXIT_CODE" -eq 0 ]; then
    echo ""
    echo -e "${BOLD}${CYAN}Running post-checks...${NC}"

    # Check 1: run_tests.sh
    echo -e "${DIM}  [1/2] Running ./run_tests.sh...${NC}"
    if [ ! -f "$SCRIPT_DIR/run_tests.sh" ]; then
        echo -e "  ${YELLOW}⚠ run_tests.sh not found, skipping tests${NC}"
        NOTES="run_tests.sh missing"
        EXIT_CODE=1
    else
        set +e
        TEST_OUTPUT=$(./run_tests.sh 2>&1)
        TEST_EXIT=$?
        set -e

        # Display the test output (everything before the ---TEST_RESULTS--- marker).
        # awk exits 0 regardless of match, so this is safe under set -e/pipefail.
        echo "$TEST_OUTPUT" | awk '/^---TEST_RESULTS---$/{exit} 1'

        # Parse the structured results block (awk always exits 0, so a missing
        # field or block degrades gracefully instead of aborting the script).
        RESULTS_BLOCK=$(echo "$TEST_OUTPUT" | awk '/^---TEST_RESULTS---$/{f=1; next} /^---END_TEST_RESULTS---$/{exit} f')
        if [ -n "$RESULTS_BLOCK" ]; then
            PASSED_TESTS=$(echo "$RESULTS_BLOCK" | awk -F= '/^testsPassed=/{print $2}')
            FAILED_TESTS=$(echo "$RESULTS_BLOCK" | awk -F= '/^testsFailed=/{print $2}')
            # If parsing returned empty strings, restore defaults
            [ -z "$PASSED_TESTS" ] && PASSED_TESTS="?"
            [ -z "$FAILED_TESTS" ] && FAILED_TESTS="?"
        fi

        if [ "$TEST_EXIT" -ne 0 ]; then
            echo -e "  ${RED}✗ Tests failed (exit code: $TEST_EXIT, failed: ${FAILED_TESTS})${NC}"
            NOTES="vitest failed"
            EXIT_CODE=1
        else
            echo -e "  ${GREEN}✓ Tests passed (${PASSED_TESTS} passed)${NC}"
        fi
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

# Append row to eval-results.md
append_eval_results "$RUN_DATE" "$MODEL" "$DURATION" "$TOTAL_CONTEXT" \
    "$TURNS" "$LIMIT_STR" "$EXCEEDED_STR" "$EXIT_CODE" \
    "$PASSED_TESTS" "$FAILED_TESTS" "$NOTES"
RESULTS_WRITTEN=1

exit "$EXIT_CODE"