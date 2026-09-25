# restart-server.ps1 - detached restart of the local dashboard service (AGENT.md S2.6).
# The ONLY sanctioned way to start/restart the 8123 service: `npm run service:restart`.
# Steps: full `netstat -ano` check (never truncated - LISTENING rows can sit at the
#   bottom) -> verify every port holder is a node process (refuse to kill anything
#   else) -> stop old listeners -> start a session-detached hidden process with logs
#   appended -> poll until the port is up -> smoke-test GET / -> report old/new PID.
# Exit codes: 0 = restarted and smoke 200; 1 = start or smoke failed; 2 = port held
#   by a non-node process, refused (nothing killed).

param(
    [int]$Port = 8123,
    [string]$BindHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $PSScriptRoot   # project root (parent of scripts/)

function Get-ListenerPids {
    # Full netstat -ano on purpose: truncating (e.g. `| head`) can cut LISTENING
    # rows and make a busy port look free (AGENT.md S2.6 lesson).
    $rows = netstat -ano | Select-String -Pattern "LISTENING"
    $found = @()
    foreach ($r in $rows) {
        $t = ($r.Line -split "\s+") | Where-Object { $_ -ne "" }
        if ($t.Count -ge 5 -and $t[1] -match ":$Port$") { $found += [int]$t[4] }
    }
    return ($found | Select-Object -Unique)
}

$old = @(Get-ListenerPids)
foreach ($p in $old) {
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne "node") {
        $name = if ($proc) { $proc.ProcessName } else { "exited" }
        Write-Output "[restart-server] REFUSED: port $Port held by non-node process (pid=$p name=$name). Nothing killed."
        exit 2
    }
}
foreach ($p in $old) {
    Write-Output "[restart-server] stopping old listener pid=$p"
    Stop-Process -Id $p -Force
}
for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-ListenerPids)) { break }
    Start-Sleep -Milliseconds 250
}

# Session-detached start (hidden window, logs appended, survives this shell).
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "node server.js >> server-8123.log 2>> server-8123.err.log" -WorkingDirectory $AppDir -WindowStyle Hidden

$new = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $new = @(Get-ListenerPids)
    if ($new) { break }
}
if (-not $new) {
    Write-Output "[restart-server] FAILED: no listener on port $Port after 30s. See server-8123.err.log in $AppDir"
    exit 1
}

$code = & curl.exe -s -o NUL --max-time 3 -w "%{http_code}" "http://${BindHost}:$Port/"
if ($code -eq "200") {
    Write-Output "[restart-server] OK: old=[$($old -join ',')] new=[$($new -join ',')] smoke=GET / -> 200"
    exit 0
}
Write-Output "[restart-server] FAILED: listener up (pid=$($new -join ',')) but smoke GET / -> $code"
exit 1
