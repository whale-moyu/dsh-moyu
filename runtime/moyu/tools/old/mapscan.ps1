param(
  [Parameter(Mandatory=$true)][string]$Image,
  [Parameter(Mandatory=$true)][double]$OriginX,
  [Parameter(Mandatory=$true)][double]$OriginY,
  [Parameter(Mandatory=$true)][double]$Pitch,
  [int]$ColCount = 20,
  [int]$RowCount = 12,
  [double]$Inner = 0.34
)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Image)
$scale = $b.Width / 1936.0
$out = New-Object System.Collections.ArrayList
for ($r = 0; $r -lt $RowCount; $r++) {
  for ($c = 0; $c -lt $ColCount; $c++) {
    $cx = ($OriginX + $c * $Pitch) * $scale
    $cy = ($OriginY + $r * $Pitch) * $scale
    $half = ($Pitch * $Inner) * $scale
    $sum = 0.0; $sum2 = 0.0; $n = 0; $bright = 0; $yellow = 0
    for ($dy = -$half; $dy -le $half; $dy += 1) {
      for ($dx = -$half; $dx -le $half; $dx += 1) {
        $x = [int]($cx + $dx); $y = [int]($cy + $dy)
        if ($x -lt 0 -or $y -lt 0 -or $x -ge $b.Width -or $y -ge $b.Height) { continue }
        $p = $b.GetPixel($x, $y)
        $v = ($p.R + $p.G + $p.B) / 3.0
        $sum += $v; $sum2 += $v * $v; $n++
        if ($v -gt 78) { $bright++ }
        if (($p.R - $p.B) -gt 25 -and $p.R -gt 90) { $yellow++ }
      }
    }
    $mean = if ($n -gt 0) { $sum / $n } else { 0 }
    $var = if ($n -gt 0) { ($sum2 / $n) - ($mean * $mean) } else { 0 }
    $sd = [math]::Sqrt([math]::Max($var, 0))
    [void]$out.Add([pscustomobject]@{ row = $r; col = $c; mean = [math]::Round($mean,1); sd = [math]::Round($sd,1); bright = $bright; yellow = $yellow })
  }
}
$b.Dispose()
$out | ForEach-Object { "$($_.row),$($_.col),$($_.mean),$($_.sd),$($_.bright),$($_.yellow)" }
