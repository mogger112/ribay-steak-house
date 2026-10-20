$root = $PSScriptRoot
$startPort = if ($env:PORT) { [int]$env:PORT } else { 5173 }
$listener = $null
$port = $startPort
for ($p = $startPort; $p -lt $startPort + 20; $p++) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://localhost:$p/")
  try {
    $candidate.Start()
    $listener = $candidate
    $port = $p
    break
  } catch {
    $candidate.Close()
  }
}
if (-not $listener) { Write-Host "No free port found starting from $startPort"; exit 1 }
Write-Host "Serving $root on http://localhost:$port/"

$mime = @{
  ".html"="text/html; charset=utf-8"; ".css"="text/css; charset=utf-8"; ".js"="application/javascript; charset=utf-8";
  ".csv"="text/csv; charset=utf-8"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"; ".png"="image/png";
  ".svg"="image/svg+xml"; ".ico"="image/x-icon"; ".json"="application/json"
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $res = $context.Response
  try {
    $path = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ($path -eq "/") { $path = "/index.html" }
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart("/")))
    if ($filePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $filePath -PathType Leaf)) {
      $ct = $mime[[System.IO.Path]::GetExtension($filePath).ToLower()]
      if (-not $ct) { $ct = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $res.ContentType = $ct
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.OutputStream.Close()
  }
}
