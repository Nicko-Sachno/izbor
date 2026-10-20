#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: scripts/install-izbor.sh [--dry-run]\n'
  printf '  Builds and links izbor from this checkout.\n'
  printf '  --dry-run prints the checks and commands without changing files.\n'
  printf '  IZBOR_LINK_DIR names npm\047s global bin folder (default /opt/homebrew/bin).\n'
}

DRY_RUN=false
if [[ $# -eq 1 && "$1" == --dry-run ]]; then
  DRY_RUN=true
elif [[ $# -eq 1 && ( "$1" == -h || "$1" == --help ) ]]; then
  usage
  exit 0
elif [[ $# -ne 0 ]]; then
  usage >&2
  exit 2
fi

REPO=$(cd "$(dirname "$0")/.." >/dev/null && pwd -P)
BIN="$REPO/bin/izbor.js"
if [[ ! -f "$REPO/package.json" || ! -f "$BIN" ]]; then
  printf 'scripts/install-izbor.sh belongs in the Izbor checkout: %s has no package.json or bin/izbor.js\n' "$REPO" >&2
  exit 1
fi
if ! command -v realpath >/dev/null 2>&1; then
  printf 'scripts/install-izbor.sh needs realpath\n' >&2
  exit 1
fi
LINK_DIR="${IZBOR_LINK_DIR:-/opt/homebrew/bin}"
LINK="$LINK_DIR/izbor"

fail() {
  printf '  %s\n' "$1" >&2
  exit 1
}

run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '  would run: %s\n' "$*"
  else
    printf '  $ %s\n' "$*"
    "$@" || fail "$* failed; nothing after it ran."
  fi
}

check() {
  local found resolved
  if [[ "$DRY_RUN" == true ]]; then
    printf '  would check: command -v izbor resolves to %s\n' "$BIN"
    return
  fi
  found=$(command -v izbor || true)
  if [[ -z "$found" ]]; then
    if [[ -L "$LINK" ]]; then
      fail "izbor is not on PATH: $LINK points to $(readlink "$LINK"). Check that the link works and $LINK_DIR is on PATH."
    fi
    fail "izbor is not on PATH. Check that npm created $LINK and $LINK_DIR is on PATH."
  fi
  resolved=$(realpath "$found" 2>/dev/null || true)
  [[ "$resolved" == "$BIN" ]] || fail "izbor resolves to ${resolved:-$found}, not $BIN. Check your PATH."
  printf '  Verified: izbor → %s → %s\n' "$found" "$resolved"
}

printf '\n  Install Izbor'
[[ "$DRY_RUN" == true ]] && printf ' · dry run'
printf '\n\n  Checking %s\n' "$LINK"
if [[ -L "$LINK" ]]; then
  target=$(readlink "$LINK")
  resolved=$(realpath "$LINK" 2>/dev/null || true)
  [[ "$resolved" == "$BIN" ]] || fail "$LINK points to $target. Nothing changed; choose how to handle that existing command before installing Izbor."
  check
  printf '  Izbor is already linked from this checkout. After source changes, run npm run build.\n'
  exit 0
elif [[ -e "$LINK" ]]; then
  fail "$LINK already exists and is not a link. Nothing changed."
fi

if [[ "$DRY_RUN" == true ]]; then
  printf '  would check: npm prefix --global uses %s as its bin folder\n' "$LINK_DIR"
else
  npm_prefix=$(npm prefix --global) || fail "Could not read npm's global prefix. Nothing changed."
  npm_bin=$(realpath "$npm_prefix/bin" 2>/dev/null || true)
  expected_bin=$(realpath "$LINK_DIR" 2>/dev/null || true)
  [[ -n "$npm_bin" && "$npm_bin" == "$expected_bin" ]] || fail "npm links commands in $npm_prefix/bin, not $LINK_DIR. Set IZBOR_LINK_DIR to npm's bin folder and try again. Nothing changed."
fi

printf '\n  Building and linking in %s\n' "$REPO"
cd "$REPO"
run npm run build
run npm link
check
if [[ "$DRY_RUN" == true ]]; then
  printf '\n  Dry run: nothing changed. Run scripts/install-izbor.sh to install.\n'
else
  printf '\n  Izbor is installed. Run izbor from any folder.\n'
  printf '  To remove this command link: npm unlink -g izbor\n'
fi
