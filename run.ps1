param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ToolArguments
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw 'Node.js 22.15 or newer is required. Install Node.js, reopen PowerShell 7, then run this launcher again.'
}

$versionText = (& $node.Source -p 'process.versions.node').Trim()
$version = [version]$versionText
if ($version -lt [version]'22.15') {
  throw "Node.js 22.15 or newer is required; found $versionText."
}

$entrypoint = Join-Path $PSScriptRoot 'dist\cli.js'
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
  throw 'Built CLI not found. Run npm run build from the project folder first.'
}

& $node.Source $entrypoint @ToolArguments
exit $LASTEXITCODE
