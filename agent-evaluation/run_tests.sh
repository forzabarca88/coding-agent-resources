#!/usr/bin/env bash
# =============================================================================
# Test Runner
# Runs vitest tests and reports the number of passed/failed tests.
# Usage: ./run_tests.sh
#
# Output:
#   - Full vitest output (default reporter) is printed to stdout
#   - A structured summary block is appended at the end for machine parsing:
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
# parsing of the human-readable console output.
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
# Run vitest: default reporter for console output, JSON reporter for parsing
# ---------------------------------------------------------------------------
TMPDIR=$(mktemp -d) || { echo "Error: Failed to create temp directory" >&2; exit 1; }
trap 'rm -rf "$TMPDIR"' EXIT
RESULTS_FILE="$TMPDIR/vitest-results.json"

set +e
npx vitest run test/ --reporter=default --reporter=json --outputFile="$RESULTS_FILE" 2>&1
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