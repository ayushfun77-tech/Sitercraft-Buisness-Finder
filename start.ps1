$ErrorActionPreference = "Stop"

$nodeDir = Join-Path $PSScriptRoot "tools\node-v24.14.1-win-x64"
$nodeExe = Join-Path $nodeDir "node.exe"
$serverFile = Join-Path $PSScriptRoot "server.js"

if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "Node.exe was not found at $nodeExe"
}

$env:PATH = "$nodeDir;$env:PATH"
& $nodeExe $serverFile
