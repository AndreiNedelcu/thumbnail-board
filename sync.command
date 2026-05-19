#!/bin/bash
cd "$(dirname "$0")"
echo "================================================"
echo "  Thumbnail Board — Syncing with Eagle..."
echo "================================================"
python3 sync.py
echo ""
echo "Press any key to close..."
read -n 1
