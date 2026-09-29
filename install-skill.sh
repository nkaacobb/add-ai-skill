#!/usr/bin/env sh
# Install or update the ai-agent-drawer skill for Claude Code, Codex and GitHub Copilot (user-wide).
#
#   ./install-skill.sh                 install to ~/.claude/skills and ~/.agents/skills (covers all three tools)
#   ./install-skill.sh claude          only Claude Code's folder (claude | agents | copilot, any combination)
#   ./install-skill.sh --uninstall     remove the installed copies
#
# Only the ai-agent-drawer folder inside each skills directory is ever touched.
set -eu

NAME="ai-agent-drawer"
HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$HERE/$NAME"
UNINSTALL=0
TARGETS=""

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    claude|agents|copilot) TARGETS="$TARGETS $arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ -n "$TARGETS" ] || TARGETS="claude agents"
[ -f "$SOURCE/SKILL.md" ] || { echo "SKILL.md not found in $SOURCE" >&2; exit 1; }

for target in $TARGETS; do
  case "$target" in
    claude)  ROOT="$HOME/.claude/skills" ;;
    agents)  ROOT="$HOME/.agents/skills" ;;
    copilot) ROOT="$HOME/.copilot/skills" ;;
  esac
  DEST="$ROOT/$NAME"

  if [ -e "$DEST" ] && [ "$(cd "$DEST" && pwd -P)" = "$(cd "$SOURCE" && pwd -P)" ]; then
    echo "Skipped $DEST (it is the source folder)"
    continue
  fi

  if [ -L "$DEST" ]; then
    rm "$DEST"                 # a symlink: remove the link only
  elif [ -d "$DEST" ]; then
    rm -rf "$DEST"
  fi

  if [ "$UNINSTALL" -eq 1 ]; then
    echo "Removed   $DEST"
    continue
  fi

  mkdir -p "$ROOT"
  cp -R "$SOURCE" "$DEST"
  find "$DEST" -type d \( -name node_modules -o -name .git -o -name chrome-profile \) -prune -exec rm -rf {} +
  echo "Installed $DEST ($(find "$DEST" -type f | wc -l | tr -d ' ') files)"
done

if [ "$UNINSTALL" -eq 0 ]; then
  echo
  echo 'Done. In any project:'
  echo '  Claude Code : "Use the ai-agent-drawer skill to build an AI agent into this app"  (or /ai-agent-drawer)'
  echo '  Codex       : "$ai-agent-drawer build an AI agent into this app"'
  echo '  Copilot     : in agent mode, "/ai-agent-drawer build an AI agent into this app"'
fi
