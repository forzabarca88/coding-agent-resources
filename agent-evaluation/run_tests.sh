#!/usr/bin/env bash
# =============================================================================
# Test Runner
# Runs vitest tests and reports the number of passed/failed tests.
# Usage: ./run_tests.sh
#
# Output:
#   - Vitest's per-test console output is suppressed; only a structured
#     summary block is printed for machine parsing:
#       ---TEST_RESULTS---
#       testFilesPassed=<n>
#       testFilesFailed=<n>
#       testFilesTotal=<n>
#       testsPassed=<n>
#       testsFailed=<n>
#       testsTotal=<n>
#       exitCode=<n>
#       ---END_TEST_RESULTS---
# Return code matches vitest's exit code.
#
# Counts are extracted from vitest's structured JSON reporter
# (--reporter=json --outputFile=...) via jq, avoiding fragile regex
# parsing of the human-readable console output. If vitest fails to
# produce a report, its raw output is dumped to stderr so the cause
# is not lost.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
for cmd in npx jq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is required but not found in PATH." >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# Run vitest with only the JSON reporter: no per-test console output, just
# a structured report file. All output is captured in case the report fails
# to be produced (see the fallback below).
# ---------------------------------------------------------------------------
TMPDIR=$(mktemp -d) || { echo "Error: Failed to create temp directory" >&2; exit 1; }
trap 'rm -rf "$TMPDIR"' EXIT
RESULTS_FILE="$TMPDIR/vitest-results.json"
LOG_FILE="$TMPDIR/vitest.log"

set +e
npx vitest run test/ --reporter=json --outputFile="$RESULTS_FILE" >"$LOG_FILE" 2>&1
VITEST_EXIT=$?
set -e

# ---------------------------------------------------------------------------
# Extract counts from the structured JSON report
#
# jq is wrapped with || to avoid aborting the entire script if vitest wrote
# malformed JSON (e.g. from a crash mid-write).
# ---------------------------------------------------------------------------
if [ -f "$RESULTS_FILE" ] && [ -s "$RESULTS_FILE" ]; then
    TEST_FILES_PASSED=$(jq -r '.numPassedTestSuites // 0' "$RESULTS_FILE" 2>/dev/null || echo "?")
    TEST_FILES_FAILED=$(jq -r '.numFailedTestSuites // 0' "$RESULTS_FILE" 2>/dev/null || echo "?")
    TEST_FILES_TOTAL=$(jq -r '.numTotalTestSuites // 0' "$RESULTS_FILE" 2>/dev/null || echo "?")
    TESTS_PASSED=$(jq -r '.numPassedTests // 0' "$RESULTS_FILE" 2>/dev/null || echo "?")
    TESTS_FAILED=$(jq -r '.numFailedTests // 0' "$RESULTS_FILE" 2>/dev/null || echo "?")
    TESTS_TOTAL=$(jq -r '.numTotalTests // 0' "$RESULTS_FILE" 2>/dev/null || echo "?")

    # When no tests ran at all (suite-level failure, e.g. missing deps),
    # numFailedTests=0 is misleading — use ? instead so the table
    # doesn't show a confident "0" when nothing actually executed.
    if [ "$VITEST_EXIT" -ne 0 ] && [ "$TESTS_TOTAL" = "0" ]; then
        TESTS_PASSED="?"
        TESTS_FAILED="?"
    fi
else
    # No usable report (e.g. vitest crashed before writing JSON): dump its
    # raw output to stderr so the failure isn't reduced to just "?" counts.
    echo "Vitest produced no JSON report (exit code ${VITEST_EXIT}); raw output:" >&2
    cat "$LOG_FILE" >&2
    TEST_FILES_PASSED="?"
    TEST_FILES_FAILED="?"
    TEST_FILES_TOTAL="?"
    TESTS_PASSED="?"
    TESTS_FAILED="?"
    TESTS_TOTAL="?"
fi

# ---------------------------------------------------------------------------
# Output structured results for machine parsing
# ---------------------------------------------------------------------------
echo ""
echo "---TEST_RESULTS---"
echo "testFilesPassed=${TEST_FILES_PASSED}"
echo "testFilesFailed=${TEST_FILES_FAILED}"
echo "testFilesTotal=${TEST_FILES_TOTAL}"
echo "testsPassed=${TESTS_PASSED}"
echo "testsFailed=${TESTS_FAILED}"
echo "testsTotal=${TESTS_TOTAL}"
echo "exitCode=${VITEST_EXIT}"
echo "---END_TEST_RESULTS---"

exit "$VITEST_EXIT"