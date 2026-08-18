#!/usr/bin/env bash
# =============================================================================
# Pi Eval Runner
# Runs pi with @eval-prompt.md, monitors token usage in real-time,
# streams the model's text output to the terminal, prints the running
# total token count after every completed turn, and terminates the
# session if the context limit is exceeded.
# Usage: ./run-eval.sh [--model <model>] [--think <level>] [--max-context <tokens>] [--notes <text>] [--clear] [--commit]
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CLEAR=0
COMMIT=0
USER_NOTES=""
THINK=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# The results file lives in the docs site (docs/data/eval-results.md) — the
# single canonical copy, read directly by the site at runtime (e.g. on GitHub
# Pages, which serves only files inside the published docs/ folder).
RESULTS_FILE="$SCRIPT_DIR/../docs/data/eval-results.md"

# ---------------------------------------------------------------------------
# Parse CLI arguments
# ---------------------------------------------------------------------------
MODEL=""
# Unset/unlimited by default; only restricted when -c is provided.
MAX_CONTEXT=0

# Valid thinking levels accepted by pi's --thinking flag
VALID_THINK_LEVELS="off minimal low medium high xhigh max"

while [ $# -gt 0 ]; do
    case "$1" in
        --think|-t)
            if [ $# -lt 2 ]; then
                echo "Error: --think requires a thinking level." >&2
                exit 1
            fi
            THINK="$2"
            shift 2
            ;;
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
        --clear)
            CLEAR=1
            shift
            ;;
        --commit)
            COMMIT=1
            shift
            ;;
        --notes|-n)
            if [ $# -lt 2 ]; then
                echo "Error: --notes requires a string." >&2
                exit 1
            fi
            USER_NOTES="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--model <model>] [--think <level>] [--max-context <tokens>] [--notes <text>] [--clear] [--commit]"
            echo ""
            echo "Options:"
            echo "  -m, --model <model>        Model identifier (e.g. anthropic/claude-sonnet-4-20250514)"
            echo "                              If not set, you will be prompted interactively."
            echo "  -t, --think <level>        Model thinking level: $VALID_THINK_LEVELS"
            echo "                              (passed through to pi's --thinking flag)"
            echo "  -c, --max-context <tokens>  Max context window in tokens."
            echo "                               Defaults to unlimited (no context-size restriction) when not set."
            echo "  -n, --notes <text>          Notes to include in the eval-results.md row"
            echo "      --clear                 Reset working directory (git clean -fd; git checkout -f) before run."
            echo "                              Reverts all tracked files (including eval-results.md) and removes untracked files."
            echo "      --commit                Commit eval-results.md after the run (regardless of exit status)"
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

# Validate thinking level if provided
if [ -n "$THINK" ]; then
    case " $VALID_THINK_LEVELS " in
        *" $THINK "*) ;;
        *)
            echo "Error: invalid --think level '$THINK'. Must be one of: $VALID_THINK_LEVELS" >&2
            exit 1
            ;;
    esac
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

# Colours for output
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m' # No Colour

if [ ! -f "eval-prompt.md" ]; then
    echo "Error: eval-prompt.md not found in $SCRIPT_DIR" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# --clear: reset working directory before run
# ---------------------------------------------------------------------------
if [ "$CLEAR" -eq 1 ]; then
    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo -e "${RED}Error: --clear requires a git repository.${NC}" >&2
        exit 1
    fi
    echo -e "${DIM}Resetting working directory (git clean -fd; git checkout -f)...${NC}"
    cd "$SCRIPT_DIR"
    git clean -fd . || { echo -e "${RED}Error: git clean failed.${NC}" >&2; exit 1; }
    git checkout -f . || { echo -e "${RED}Error: git checkout failed.${NC}" >&2; exit 1; }
    # The results file lives in the docs site now; it must not reappear in
    # this directory from HEAD.
    rm -f "$SCRIPT_DIR/eval-results.md"
    # Revert the results file too — or drop it if it is not tracked at HEAD.
    git checkout -f -- "$RESULTS_FILE" 2>/dev/null || rm -f "$RESULTS_FILE"
    echo ""
fi

# ---------------------------------------------------------------------------
# Helper: append a row to eval-results.md (create header if missing)
# ---------------------------------------------------------------------------
append_eval_results() {
    local date="$1" model="$2" duration="$3" context="$4"
    local turns="$5" limit="$6" exceeded="$7" exit_code="$8"
    local passed_tests="$9" failed_tests="${10}" notes="${11}"

    mkdir -p "$(dirname "$RESULTS_FILE")"
    if [ ! -f "$RESULTS_FILE" ]; then
        printf '%s\n\n%s\n%s\n' \
            '# Evaluation Results' \
            '| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |' \
            '|---|---|---|---|---|---|---|---|---|---|---|' > "$RESULTS_FILE"
    fi

    printf "| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n" \
        "$model" "$notes" "$duration" "$context" \
        "$turns" "$limit" "$exceeded" "$exit_code" \
        "$passed_tests" "$failed_tests" "$date" >> "$RESULTS_FILE"

    echo -e "${GREEN}Results appended to:${NC} $RESULTS_FILE"
}

# ---------------------------------------------------------------------------
# Helper: parse basic stats from a session file and append to eval-results.md
# Used by the cleanup trap when the script is interrupted.
# ---------------------------------------------------------------------------
append_eval_results_from_session() {
    local session_file="$1" model="$2" max_context="$3" exit_code="$4" notes="$5"
    local passed_tests="${6:-?}" failed_tests="${7:-?}"

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
        [.[] | select(.message.usage != null) | {usage: .message.usage}] as $all |
        if ($all | length) == 0 then empty
        else
            # A failed final response (e.g. context overflow) carries zeroed
            # usage; use the last message with real usage as the context snapshot.
            ($all | map(select((.usage.totalTokens // 0) > 0))) as $withUsage |
            ($withUsage | last // {}) as $lastValid |
            {
                total_output: ($all | map(.usage.output) | add),
                turn_count:   ($all | length),
                last_total:   ((($lastValid | .usage) // {}) | .totalTokens // 0),
                last_input:   ((($lastValid | .usage) // {}) | .input // 0),
                last_output:  ((($lastValid | .usage) // {}) | .output // 0)
            }
        end
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
        "$turns" "$limit_str" "$exceeded_str" "$exit_code" "$passed_tests" "$failed_tests" "$notes"
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
        # Run tests too, so the row doesn't get "?" counts.
        local pt="?" ft="?" tn="interrupted"
        if [ -f "$SCRIPT_DIR/run_tests.sh" ]; then
            set +e
            local to
            to=$(./run_tests.sh 2>&1)
            local te=$?
            set -e
            echo "$to" | awk '/^---TEST_RESULTS---$/{exit} 1'
            local rb
            rb=$(echo "$to" | awk '/^---TEST_RESULTS---$/{f=1; next} /^---END_TEST_RESULTS---$/{exit} f')
            if [ -n "$rb" ]; then
                pt=$(echo "$rb" | awk -F= '/^testsPassed=/{print $2}')
                ft=$(echo "$rb" | awk -F= '/^testsFailed=/{print $2}')
                [ -z "$pt" ] && pt="?"
                [ -z "$ft" ] && ft="?"
            fi
            if [ "$te" -ne 0 ]; then
                tn="interrupted, vitest failed"
            fi
        fi
        tn="${USER_NOTES:+${USER_NOTES}, }${tn}"
        append_eval_results_from_session "$SESSION_FILE" "$MODEL" "$MAX_CONTEXT" 1 "$tn" "$pt" "$ft"
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
echo -e "${BOLD}Subagent:${NC}      disabled"
if [ -n "$THINK" ]; then
    echo -e "${BOLD}Thinking:${NC}      $THINK"
fi
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
# Build the pi command; --thinking is only added when --think was supplied.
# The subagent extension tool is excluded so the model under evaluation cannot
# delegate work to subagents (which would skew results / add uncontrolled token
# usage and tool invocations).
PI_ARGS=(--session-dir "$TMPDIR" --model "$MODEL" --mode json --exclude-tools subagent)
if [ -n "$THINK" ]; then
    PI_ARGS+=(--thinking "$THINK")
fi
pi "${PI_ARGS[@]}" @eval-prompt.md > "$STREAM_FILE" &
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
                # NB: never wrap the decoded delta in $(...) — command
                # substitution strips trailing newlines, so deltas that
                # carry line breaks (e.g. "\n\n") would print nothing.
                printf '%b' "${DIM}"
                printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null
                printf '%b' "${NC}"
                ;;
            TEXT)
                printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null
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
# Helper: process newly appended session lines that carry token usage data.
#
# Each assistant message in the session file (a completed turn) carries a
# usage record. A single jq pass extracts usage from all lines after
# start_line; for every turn found it updates the LATEST_* globals and prints
# the current total token count. LAST_SESSION_LINE_COUNT is advanced past the
# lines actually consumed.
# ---------------------------------------------------------------------------
process_session_usage() {
    local start_line="$1"
    local TOTAL INPUT OUTPUT
    local snapshot

    # Snapshot the newly appended lines once. The bookmark below is derived
    # from this snapshot's actual length, so lines appended while we read
    # are processed exactly once — never skipped, never duplicated.
    snapshot=$(tail -n "+$((start_line + 1))" "$SESSION_FILE" 2>/dev/null)

    while IFS=$'\t' read -r TOTAL INPUT OUTPUT; do
        if [ -n "$TOTAL" ] && [ "$TOTAL" != "null" ] && [ "$TOTAL" -gt 0 ] 2>/dev/null; then
            LATEST_TOTAL_TOKENS=$TOTAL
            LATEST_USAGE_INPUT=$INPUT
            LATEST_USAGE_OUTPUT=$OUTPUT

            # Turn complete: report the current total token count
            LIVE_TURNS=$((LIVE_TURNS + 1))
            echo -e "  ${GREEN}✓ turn ${LIVE_TURNS} complete — total tokens: $(printf "%'d" "$LATEST_TOTAL_TOKENS")${NC}"

            # Check if limit exceeded
            if [ "$MAX_CONTEXT" -gt 0 ] && [ "$LATEST_TOTAL_TOKENS" -gt "$MAX_CONTEXT" ]; then
                LIMIT_EXCEEDED=1
            fi
        fi
    done < <(printf '%s\n' "$snapshot" | jq -r '
        select(.message.usage != null) |
        [.message.usage.totalTokens, .message.usage.input, .message.usage.output] |
        @tsv
    ' 2>/dev/null)

    # Advance the bookmark by the number of lines actually consumed. The
    # printf '%s\n' restores the trailing newline stripped by the command
    # substitution, keeping the count consistent with the file's wc -l.
    if [ -n "$snapshot" ]; then
        LAST_SESSION_LINE_COUNT=$((start_line + $(printf '%s\n' "$snapshot" | wc -l)))
    fi
}

# ---------------------------------------------------------------------------
# Monitor session file for token usage, and stream file for text output
# ---------------------------------------------------------------------------
LIMIT_EXCEEDED=0
LIVE_TURNS=0
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
    # Get the initial line count for the stream file. The session file stays
    # at the pre-initialized 0 so turns that completed before monitoring
    # began are still reported.
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
            process_session_usage "$LAST_SESSION_LINE_COUNT"
            # Stop monitoring as soon as the context limit is exceeded
            if [ "$LIMIT_EXCEEDED" -eq 1 ]; then
                break
            fi
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

# Final drain: capture any remaining session usage events after pi exited
if [ -n "${SESSION_FILE:-}" ] && [ -f "$SESSION_FILE" ]; then
    CURRENT_SESSION_COUNT=$(wc -l < "$SESSION_FILE" 2>/dev/null || echo 0)
    if [ "$CURRENT_SESSION_COUNT" -gt "${LAST_SESSION_LINE_COUNT:-0}" ]; then
        process_session_usage "$LAST_SESSION_LINE_COUNT"
    fi
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

# Capture pi exit code (if it has exited). The wait is wrapped in
# set +e: when pi was killed (context limit), wait returns non-zero and
# must not abort the script under set -e. In the limit-exceeded path pi
# was already reaped above, so wait reports 127 here — PI_EXIT_CODE is
# only surfaced when no session file exists, so this is harmless.
PI_EXIT_CODE=""
if ! kill -0 "$PI_PID" 2>/dev/null; then
    set +e
    wait "$PI_PID" 2>/dev/null
    PI_EXIT_CODE=$?
    set -e
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
    [.[] | select(.message.usage != null) | {usage: .message.usage, stopReason: .message.stopReason, errorMessage: .message.errorMessage}] as $all |
    if ($all | length) == 0 then empty
    else
        # The final response may be a failed call (e.g. context overflow) whose
        # usage is all zeros; snapshot the final context from the last message
        # that actually carried usage data.
        ($all | map(select((.usage.totalTokens // 0) > 0))) as $withUsage |
        ($withUsage | last // {}) as $lastValid |
        {
            total_output:      ($all | map(.usage.output) | add),
            total_cost:        ($all | map(.usage.cost.total // 0) | add),
            turn_count:        ($all | length),
            last_input:        ((($lastValid | .usage) // {}) | .input // 0),
            last_output:       ((($lastValid | .usage) // {}) | .output // 0),
            last_total:        ((($lastValid | .usage) // {}) | .totalTokens // 0),
            last_stop_reason:  ($all | last | (.stopReason // "")),
            last_error_message: ($all | last | (.errorMessage // "")),
            overflow_total:    (
                ($all | last | (.errorMessage // "")) as $err |
                if ($err | test("exceeds the available context size")) then
                    ($err | capture("request \\((?<n>[0-9]+) tokens\\)") | .n | tonumber)
                else 0 end
            )
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
    LAST_ERROR_MESSAGE=$(echo "$STATS" | jq -r '.last_error_message // ""')
    OVERFLOW_TOTAL=$(echo "$STATS" | jq -r '.overflow_total // 0')

    # If the final response died with a context-size error, the last usage
    # snapshot predates the failed request. Use the request size reported by
    # the engine as the true final context and flag the limit as exceeded.
    if [ "$MAX_CONTEXT" -gt 0 ] && [ "$OVERFLOW_TOTAL" -gt 0 ] 2>/dev/null && [ "$OVERFLOW_TOTAL" -gt "$MAX_CONTEXT" ]; then
        LIMIT_EXCEEDED=1
        LAST_TOTAL=$OVERFLOW_TOTAL
    fi

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
            (if ((.message.errorMessage // null) != null) and ((.message.errorMessage | length) > 0) then
                "  error: " + .message.errorMessage
            else "" end) +
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
        if [ -n "$LAST_ERROR_MESSAGE" ] && [ "$LAST_ERROR_MESSAGE" != "null" ]; then
            echo -e "  ${DIM}Last response error: ${LAST_ERROR_MESSAGE}${NC}"
        fi
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

NOTES="$USER_NOTES"
PASSED_TESTS="?"
FAILED_TESTS="?"

# ---------------------------------------------------------------------------
# Post-checks: run tests and validate test files were not modified.
# These run unconditionally (even if context limit was exceeded) so that the
# eval-results.md row always contains real test counts.
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}Running post-checks...${NC}"

# Check 1: run_tests.sh
# Always run if the file exists, regardless of EXIT_CODE.
echo -e "${DIM}  [1/2] Running ./run_tests.sh...${NC}"
if [ ! -f "$SCRIPT_DIR/run_tests.sh" ]; then
    echo -e "  ${YELLOW}⚠ run_tests.sh not found, skipping tests${NC}"
    NOTES="${NOTES:+${NOTES}, }run_tests.sh missing"
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
        NOTES="${NOTES:+${NOTES}, }vitest failed"
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
    NOTES="${NOTES:+${NOTES}, }test files modified"
    EXIT_CODE=1
else
    echo -e "  ${GREEN}✓ No unauthorized modifications${NC}"
fi

if [ "$EXIT_CODE" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All checks passed.${NC}"
else
    echo -e "${RED}${BOLD}Post-checks failed.${NC}"
fi

# Append row to eval-results.md
append_eval_results "$RUN_DATE" "$MODEL" "$DURATION" "$TOTAL_CONTEXT" \
    "$TURNS" "$LIMIT_STR" "$EXCEEDED_STR" "$EXIT_CODE" \
    "$PASSED_TESTS" "$FAILED_TESTS" "$NOTES"
RESULTS_WRITTEN=1

# ---------------------------------------------------------------------------
# --commit: commit eval-results.md after the run
# ---------------------------------------------------------------------------
if [ "$COMMIT" -eq 1 ]; then
    echo ""
    echo -e "${BOLD}Committing eval-results.md...${NC}"

    if ! git rev-parse --git-dir >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠ Not a git repository, skipping commit.${NC}"
    elif ! git config user.name >/dev/null 2>&1 || ! git config user.email >/dev/null 2>&1; then
        echo -e "  ${YELLOW}⚠ Git user.name or user.email not set, skipping commit.${NC}"
    else
        git add "$RESULTS_FILE"
        COMMIT_DATE=$(date '+%Y-%m-%d %H:%M')
        git commit -m "eval: $MODEL ($COMMIT_DATE) exit=$EXIT_CODE"
        echo ""
    fi
fi

exit "$EXIT_CODE"