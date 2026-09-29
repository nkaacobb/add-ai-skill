<#
.SYNOPSIS
  Install or update the ai-agent-drawer skill for Claude Code, Codex and GitHub Copilot (user-wide).

.DESCRIPTION
  Copies .\ai-agent-drawer (the folder next to this script) to:
    ~\.claude\skills\ai-agent-drawer   Claude Code   (GitHub Copilot reads this folder too)
    ~\.agents\skills\ai-agent-drawer   Codex         (GitHub Copilot reads this folder too)
  Re-run it after you change the skill; it replaces the installed copies.
  Only the ai-agent-drawer folder inside each skills directory is ever touched.

.PARAMETER Targets
  Any of: claude, agents, copilot. Default: claude, agents (which covers all three tools).
  'copilot' adds ~\.copilot\skills — only needed if you use Copilot without the other two folders.

.PARAMETER Uninstall
  Remove the installed copies instead.

.EXAMPLE
  .\install-skill.ps1
  .\install-skill.ps1 -Targets claude
  .\install-skill.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('claude', 'agents', 'copilot')]
  [string[]] $Targets = @('claude', 'agents'),
  [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$name = 'ai-agent-drawer'
$source = (Resolve-Path (Join-Path $PSScriptRoot $name)).Path

if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
  throw "SKILL.md not found in $source"
}

$roots = @{
  claude  = Join-Path $HOME '.claude\skills'
  agents  = Join-Path $HOME '.agents\skills'
  copilot = Join-Path $HOME '.copilot\skills'
}

foreach ($target in $Targets) {
  $dest = Join-Path $roots[$target] $name

  if ((Split-Path $dest -Leaf) -ne $name) { throw "Refusing to touch $dest" }
  if ((Test-Path $dest) -and ((Resolve-Path $dest).Path -eq $source)) {
    Write-Host "Skipped $dest (it is the source folder)"
    continue
  }

  if (Test-Path $dest) {
    $item = Get-Item -LiteralPath $dest -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      # A junction/symlink: remove the link only, never what it points to.
      [IO.Directory]::Delete($dest)
    } else {
      Remove-Item -LiteralPath $dest -Recurse -Force
    }
  }

  if ($Uninstall) {
    Write-Host "Removed   $dest"
    continue
  }

  New-Item -ItemType Directory -Force -Path $roots[$target] | Out-Null
  Copy-Item -LiteralPath $source -Destination $dest -Recurse
  Get-ChildItem -LiteralPath $dest -Recurse -Directory -Force |
    Where-Object { $_.Name -in @('node_modules', '.git', 'chrome-profile') } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  $count = (Get-ChildItem -LiteralPath $dest -Recurse -File).Count
  Write-Host "Installed $dest ($count files)"
}

if (-not $Uninstall) {
  Write-Host ''
  Write-Host 'Done. In any project:'
  Write-Host '  Claude Code : "Use the ai-agent-drawer skill to build an AI agent into this app"  (or /ai-agent-drawer)'
  Write-Host '  Codex       : "$ai-agent-drawer build an AI agent into this app"'
  Write-Host '  Copilot     : in agent mode, "/ai-agent-drawer build an AI agent into this app"'
  Write-Host 'Restart the tool (or start a new session) if it was already running.'
}
