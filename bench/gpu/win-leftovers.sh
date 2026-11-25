#!/bin/bash
# What a run on the Windows VM (Chrome on its NVIDIA GPU: WIN-HANDOVER.md) may have left behind there and here: the
# harness's Chrome (by its profile path, never by name: the user's own Chrome may be open), and this side's ssh
# forwards to it. --kill stops them. Run it after every Windows run and before a measurement there.
# PowerShell reads stdin line by line: keep each statement on one line.
# The VM's address and key: WIN_SSH (default: the dev VM's `win` alias in ~/.ssh/config).
set -u
KILL=${1:-}
SSH=(${WIN_SSH:-ssh win})
PROFILE=${WIN_PROFILE_PATTERN:-waarm64-cdp}
ps1=$(cat <<PS
\$c = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { \$_.CommandLine -like '*$PROFILE*' })
'harness chrome processes: ' + \$c.Count
if ('$KILL' -eq '--kill' -or '$KILL' -eq '--kill-forwards') { \$c | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1; 'after --kill: ' + @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { \$_.CommandLine -like '*$PROFILE*' }).Count }
'other chrome processes (the user''s, left alone): ' + @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { \$_.CommandLine -notlike '*$PROFILE*' }).Count
'busiest processes (CPU s):'
Get-Process | Sort-Object CPU -Descending | Select-Object -First 6 Name, Id, @{n='CPU';e={[int]\$_.CPU}}, @{n='MB';e={[int](\$_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 120
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader 2>\$null | ForEach-Object { 'GPU (util, mem used, total): ' + \$_ }
PS
)
echo "$ps1" | timeout 60 "${SSH[@]}" 'powershell -NoProfile -Command -' || echo "the Windows VM didn't answer (down?)"
# This side: ssh sessions forwarding CDP (9333) or the page (8197). Listed, not killed by --kill: the user may run a
# forward of their own on those ports (one was killed so, 2026-11-25); the harness stops its own (its pid file).
# --kill-forwards kills them too.
pids=$(pgrep -a ssh | awk '/-L 9333:|-R 8197:/ {print $1}')
echo "local ssh forwards: ${pids:-none}"
if [ "$KILL" = --kill-forwards ] && [ -n "$pids" ]; then kill $pids; echo killed; fi
