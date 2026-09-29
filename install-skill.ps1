<#
.SYNOPSIS
  Install or update the add-ai-skill skill for Claude Code, Codex and GitHub Copilot (user-wide).

.DESCRIPTION
  Copies .\add-ai-skill (the folder next to this script) to:
    ~\.claude\skills\add-ai-skill   Claude Code
    ~\.agents\skills\add-ai-skill   Codex and GitHub Copilot
  Re-run it after you change the skill; it replaces the installed copies.
  Copies installed under the skill's old name (ai-agent-drawer) are removed, so no tool lists the skill twice.
  Only those two folder names inside each skills directory are ever touched.

.PARAMETER Targets
  Any of: claude, agents, copilot. Default: claude, agents (which covers all three tools).
  'copilot' adds ~\.copilot\skills — only needed if you use Copilot without ~\.agents\skills.

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
$name = 'add-ai-skill'
$legacy = @('ai-agent-drawer')
$exclude = @('node_modules', '.git', '.verify', 'chrome-profile')
$source = (Resolve-Path (Join-Path $PSScriptRoot $name)).Path

if (-not (Test-Path (Join-Path $source 'SKILL.md'))) {
  throw "SKILL.md not found in $source"
}

$roots = @{
  claude  = Join-Path $HOME '.claude\skills'
  agents  = Join-Path $HOME '.agents\skills'
  copilot = Join-Path $HOME '.copilot\skills'
}

function Remove-Installed([string] $path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    [IO.Directory]::Delete($path)          # a junction/symlink: remove the link only, never what it points to
    return $true
  }
  # Empty it first: that works even when the folder itself is in use (e.g. an open terminal's current folder).
  Get-ChildItem -LiteralPath $path -Force | Remove-Item -Recurse -Force
  try { Remove-Item -LiteralPath $path -Force } catch { Write-Host "  (left the empty folder $path; it is in use)" }
  return $true
}

foreach ($target in $Targets) {
  $root = $roots[$target]
  $dest = Join-Path $root $name
  if ((Split-Path $dest -Leaf) -ne $name) { throw "Refusing to touch $dest" }
  if ((Test-Path $dest) -and ((Resolve-Path $dest).Path -eq $source)) {
    Write-Host "Skipped $dest (it is the source folder)"
    continue
  }

  foreach ($old in $legacy) {
    $oldPath = Join-Path $root $old
    if (Remove-Installed $oldPath) { Write-Host "Removed   $oldPath (old name)" }
  }
  $had = Remove-Installed $dest

  if ($Uninstall) {
    if ($had) { Write-Host "Removed   $dest" }
    continue
  }

  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -notin $exclude } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force }
  Get-ChildItem -LiteralPath $dest -Recurse -Directory -Force |
    Where-Object { $_.Name -in $exclude } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
  $count = (Get-ChildItem -LiteralPath $dest -Recurse -File).Count
  Write-Host "Installed $dest ($count files)"
}

if (-not $Uninstall) {
  Write-Host ''
  Write-Host 'Done. In any project:'
  Write-Host '  Claude Code : "Use the add-ai-skill skill to build an AI agent into this app"  (or /add-ai-skill)'
  Write-Host '  Codex       : "$add-ai-skill build an AI agent into this app"'
  Write-Host '  Copilot     : in agent mode, "/add-ai-skill build an AI agent into this app"'
  Write-Host 'Restart the tool (or start a new session) if it was already running.'
}
