#!/usr/bin/env sh
# Install or update the add-ai-skill skill for Claude Code, Codex and GitHub Copilot (user-wide).
#
#   ./install-skill.sh                 install to ~/.claude/skills and ~/.agents/skills (covers all three tools)
#   ./install-skill.sh claude          only Claude Code's folder (claude | agents | copilot, any combination)
#   ./install-skill.sh --uninstall     remove the installed copies
#
# Copies installed under the skill's old name (ai-agent-drawer) are removed, so no tool lists the skill twice.
# Only those two folder names inside each skills directory are ever touched.
set -eu

NAME="add-ai-skill"
LEGACY="ai-agent-drawer"
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

remove_installed() {
  if [ -L "$1" ]; then
    rm "$1"                    # a symlink: remove the link only
  elif [ -d "$1" ]; then
    rm -rf "$1"
  else
    return 1
  fi
}

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

  for old in $LEGACY; do
    if remove_installed "$ROOT/$old"; then echo "Removed   $ROOT/$old (old name)"; fi
  done
  HAD=0
  if remove_installed "$DEST"; then HAD=1; fi

  if [ "$UNINSTALL" -eq 1 ]; then
    if [ "$HAD" -eq 1 ]; then echo "Removed   $DEST"; fi
    continue
  fi

  mkdir -p "$ROOT"
  cp -R "$SOURCE" "$DEST"
  find "$DEST" -type d \( -name node_modules -o -name .git -o -name .verify -o -name chrome-profile \) -prune -exec rm -rf {} +
  echo "Installed $DEST ($(find "$DEST" -type f | wc -l | tr -d ' ') files)"
done

if [ "$UNINSTALL" -eq 0 ]; then
  echo
  echo 'Done. In any project:'
  echo '  Claude Code : "Use the add-ai-skill skill to build an AI agent into this app"  (or /add-ai-skill)'
  echo '  Codex       : "$add-ai-skill build an AI agent into this app"'
  echo '  Copilot     : in agent mode, "/add-ai-skill build an AI agent into this app"'
fi
