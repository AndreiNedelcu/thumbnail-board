#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Thumbnail Tagger..."
# Kill anything on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null
sleep 0.5
python3 server.py &
SERVER_PID=$!
sleep 1.5
open http://localhost:3000/tagger.html
echo "Tagger running at http://localhost:3000/tagger.html"
echo "Press Ctrl+C to stop the server"
wait $SERVER_PID
