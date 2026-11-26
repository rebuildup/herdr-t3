param(
  [string]$OutDir = "C:\Users\rebui\ht3-perf\results",
  [int]$Rounds = 5,
  [int]$Iterations = 5,
  [int]$Spinners = 10
)
$ErrorActionPreference = "Continue"
$Bun = "C:\Users\rebui\.bun\bin\bun.exe"
$Rel = "$env:LOCALAPPDATA\herdr-t3\releases"
$script:Arms = [ordered]@{
  "0e3c14e" = "$Rel\0e3c14eba55bf9a827f617cc78882bc524e69e1a"
  "932ce11" = "$Rel\932ce11d341385006a6389591a329f74a550d9d4"
  "2febbbf" = "$Rel\2febbbf6cfe78e455c46c5709e171309295aaba0"
  "9bb50cf" = "C:\Users\rebui\ht3-perf\repo"
}
New-Item -ItemType Directory -Force $OutDir | Out-Null
$log = Join-Path $OutDir "runner.log"
function Log($m) { $l = "$(Get-Date -Format o) $m"; Add-Content $log $l; Write-Output $l }

$cpuCsv = Join-Path $OutDir "cpu-samples.csv"
"timestamp,cpu_pct,mem_avail_mb" | Out-File $cpuCsv -Encoding ascii
$script:cpuJob = Start-Job -ScriptBlock {
  param($csv)
  while ($true) {
    try {
      $c = (Get-Counter '\Processor(_Total)\% Processor Time','\Memory\Available MBytes' -ErrorAction Stop).CounterSamples
      $cpu = [math]::Round($c[0].CookedValue,1)
      $mem = [math]::Round($c[1].CookedValue,0)
      "$(Get-Date -Format o),$cpu,$mem" | Out-File $csv -Append -Encoding ascii
    } catch {}
    Start-Sleep -Seconds 2
  }
} -ArgumentList $cpuCsv
Log "sampler started job=$($script:cpuJob.Id)"

$script:loadJobs = @()
function Start-Load {
  for ($i = 0; $i -lt $Spinners; $i++) {
    $script:loadJobs += Start-Job -ScriptBlock { while ($true) { $x = 1 + 1 } }
  }
  Log "load started: $($script:loadJobs.Count) spinner jobs"
}
function Stop-Load {
  foreach ($j in $script:loadJobs) { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue }
  $script:loadJobs = @()
  Log "load stopped"
  Start-Sleep -Seconds 3
}

$armNames = @($script:Arms.Keys)
foreach ($cond in @("idle","loaded")) {
  if ($cond -eq "loaded") { Start-Load }
  for ($r = 1; $r -le $Rounds; $r++) {
    $order = @()
    for ($i = 0; $i -lt $armNames.Count; $i++) { $order += $armNames[($i + $r - 1) % $armNames.Count] }
    foreach ($arm in $order) {
      $dir = $script:Arms[$arm]
      $tag = "{0}-{1}-r{2}" -f $arm, $cond, $r
      $out = Join-Path $OutDir "$tag.json"
      Push-Location $dir
      $sw = [Diagnostics.Stopwatch]::StartNew()
      & $Bun scripts\perf-baseline.ts record --iterations $Iterations --out $out 2>&1 | Out-File (Join-Path $OutDir "$tag.log") -Encoding ascii
      $sw.Stop()
      Pop-Location
      Log "record $tag wall=$($sw.ElapsedMilliseconds)ms -> $out"
      Start-Sleep -Seconds 2
    }
  }
  if ($cond -eq "loaded") { Stop-Load }
}

Stop-Job $script:cpuJob -PassThru | Remove-Job -Force
Log "done"
