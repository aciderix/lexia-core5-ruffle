#!/bin/bash
# Local test runner — mirrors the GitHub Actions workflow
# Usage: ./test/run-local.sh

set -e

PORT=8080
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Lexia Core5 Ruffle Local Test ==="
echo "Working dir: $DIR"

# Check files
echo "--- Checking files ---"
for f in index.html sw.js amf.js crossdomain.xml swf/main.swf ruffle/web/ruffle.js; do
    if [ -f "$DIR/$f" ]; then
        echo "  ✅ $f ($(du -h "$DIR/$f" | cut -f1))"
    else
        echo "  ❌ $f MISSING"
    fi
done

# Install deps
echo "--- Installing test deps ---"
cd "$DIR/test"
npm ci 2>/dev/null || npm install

# Install Playwright if needed
if ! npx playwright --version &>/dev/null; then
    echo "--- Installing Playwright ---"
    npx playwright install chromium --with-deps
fi

# Start server
echo "--- Starting HTTP server ---"
cd "$DIR"
python3 server.py &
SERVER_PID=$!
sleep 2

# Verify server
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/index.html" | grep -q 200; then
    echo "  ✅ Server running on port $PORT"
else
    echo "  ❌ Server failed to start"
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

# Run test
echo "--- Running tests ---"
cd "$DIR/test"
PORT=$PORT node runner.js
TEST_EXIT=$?

# Cleanup
kill $SERVER_PID 2>/dev/null
echo "--- Done (exit code: $TEST_EXIT) ---"

# Show results
echo ""
echo "=== Results ==="
cat logs/summary.txt 2>/dev/null || echo "No summary"
echo ""
echo "Screenshots:"
ls -la screenshots/ 2>/dev/null || echo "No screenshots"
echo ""
echo "Console log (last 20 lines):"
tail -20 logs/console.log 2>/dev/null || echo "No console log"

exit $TEST_EXIT
