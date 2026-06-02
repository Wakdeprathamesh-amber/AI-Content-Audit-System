#!/usr/bin/env bash
# Pre-commit secrets check. Run from repo root.
# Exits non-zero if it finds anything that looks like a leaked credential
# in tracked files (or, if not a git repo, in any file outside .gitignored paths).

set -u
cd "$(dirname "$0")/.."

# Patterns to flag. Add new ones here.
PATTERNS=(
  'sk-proj-[A-Za-z0-9_-]{20,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  # Anything that looks like a real password assignment, but not the obvious
  # placeholder values we use in docs / examples.
  'AMBER_DB_PASSWORD=(?!your_|REPLACE|placeholder|<|\s*$)[^[:space:]]+'
)

# Files / paths we never want to scan (docs containing placeholder examples,
# this script itself, the .env.example template, etc.).
EXCLUDE_GLOBS=(
  'scripts/check-secrets.sh'
  '.env.example'
  'README.md'
  'docs/'
  'SECURITY.md'
)

# Build list of files to scan. macOS ships with bash 3.2 so we avoid mapfile.
TMP_LIST="$(mktemp -t check-secrets.XXXXXX)"
trap 'rm -f "$TMP_LIST"' EXIT

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files >"$TMP_LIST"
else
  find . \
    \( -path '*/node_modules' -o \
       -path '*/venv' -o \
       -path '*/.venv' -o \
       -path '*/__pycache__' -o \
       -path '*/audit-results' -o \
       -path '*/logs' -o \
       -path '*/dist' -o \
       -path '*/.git' \) -prune -o \
    -type f \
    ! -name '.env' \
    ! -name '.env.local' \
    ! -name '.env.*' \
    ! -name '*.pyc' \
    ! -name '*.map' \
    -print | sed 's|^\./||' >"$TMP_LIST"
fi

should_skip() {
  local path="$1"
  for ex in "${EXCLUDE_GLOBS[@]}"; do
    case "$path" in
      "$ex"|"$ex"/*|*/"$ex"|*/"$ex"/*) return 0 ;;
    esac
  done
  return 1
}

FOUND=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue
  if should_skip "$f"; then
    continue
  fi
  # Skip binary files.
  if file --mime "$f" 2>/dev/null | grep -q 'charset=binary'; then
    continue
  fi
  for pat in "${PATTERNS[@]}"; do
    # grep -P for PCRE (negative lookahead). On macOS, GNU grep may not exist;
    # we fall back to a simpler match-then-filter approach.
    if grep -P "" /dev/null >/dev/null 2>&1; then
      matches=$(grep -P -n "$pat" "$f" 2>/dev/null || true)
    else
      matches=$(grep -E -n "$pat" "$f" 2>/dev/null | grep -vE 'your_|REPLACE|placeholder|<' || true)
    fi
    if [ -n "$matches" ]; then
      echo "$matches" | sed "s|^|$f:|"
      FOUND=1
    fi
  done
done <"$TMP_LIST"

if [ "$FOUND" -ne 0 ]; then
  echo
  echo "❌ Secrets check failed. Remove credentials from the files above before committing."
  exit 1
fi

echo "✅ Secrets check passed."
