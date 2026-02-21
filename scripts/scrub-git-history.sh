#!/usr/bin/env bash
# ============================================================================
# Git History Scrubbing Script
# ============================================================================
# WARNING: This script rewrites git history. All collaborators must re-clone 
# the repo after running this. Force-push is required.
#
# Run this AFTER rotating all credentials:
# 1. Database password (Neon dashboard)
# 2. Google OAuth client ID + secret (Google Cloud Console)
# 3. JWT secret (Vercel env vars)
# 4. LemonSqueezy API key + webhook secret (LemonSqueezy dashboard)
#
# Usage:
#   chmod +x scripts/scrub-git-history.sh
#   ./scripts/scrub-git-history.sh
# ============================================================================

set -euo pipefail

echo "=================================================="
echo "  Git History Scrubbing Tool"
echo "  This will PERMANENTLY rewrite git history!"
echo "=================================================="
echo ""

# Check if git-filter-repo is installed
if ! command -v git-filter-repo &> /dev/null; then
    echo "ERROR: git-filter-repo is not installed."
    echo ""
    echo "Install it:"
    echo "  pip install git-filter-repo"
    echo "  # or"
    echo "  brew install git-filter-repo  (macOS)"
    echo ""
    exit 1
fi

read -p "Are you sure? This CANNOT be undone! (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo "Step 1: Removing sensitive files from all git history..."
echo ""

# Remove files that contained secrets
git filter-repo \
    --path dburl.txt \
    --path gid.txt \
    --path gsecret.txt \
    --path add-env.js \
    --invert-paths \
    --force

echo ""
echo "Step 2: Done! Now you MUST:"
echo ""
echo "  1. Force-push to GitHub:"
echo "     git push --force --all"
echo "     git push --force --tags"
echo ""
echo "  2. Rotate ALL credentials NOW:"
echo "     - Database password (Neon dashboard)"
echo "     - Google OAuth credentials (Google Cloud Console)"
echo "     - JWT secret (Vercel env vars)"
echo "     - LemonSqueezy keys (LemonSqueezy dashboard)"
echo ""
echo "  3. Tell any collaborators to re-clone the repo"
echo ""
echo "  4. Enable GitHub secret scanning:"
echo "     Settings → Code security → Secret scanning → Enable"
echo ""
echo "=================================================="
echo "  DONE — Old secrets removed from history"
echo "=================================================="
