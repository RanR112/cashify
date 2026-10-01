import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const CSV = "ram-usage.csv";
if (!existsSync(CSV)) writeFileSync(CSV, "timestamp,process_count,total_mb\n");

// Sums the working set of the OpenWA node process and all its descendants (Chromium).
const PS = `
$all = Get-CimInstance Win32_Process
$roots = $all | Where-Object { $_.CommandLine -match 'wa-automate' -and $_.ProcessId -ne $PID }
$ids = New-Object System.Collections.Generic.HashSet[uint32]
$queue = New-Object System.Collections.Queue
foreach ($r in $roots) { if ($ids.Add($r.ProcessId)) { $queue.Enqueue($r.ProcessId) } }
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue()
  foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $p })) { if ($ids.Add($c.ProcessId)) { $queue.Enqueue($c.ProcessId) } }
}
$sel = $all | Where-Object { $ids.Contains($_.ProcessId) }
$sum = ($sel | Measure-Object WorkingSetSize -Sum).Sum
if (-not $sum) { $sum = 0 }
"$($sel.Count),$([math]::Round($sum / 1MB, 1))"
`;

function sample() {
  const out = execFileSync("powershell", ["-NoProfile", "-Command", PS], { encoding: "utf8" }).trim();
  const line = `${new Date().toISOString()},${out}\n`;
  appendFileSync(CSV, line);
  process.stdout.write(line);
}

sample();
setInterval(sample, 60_000);
