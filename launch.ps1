$dist = "C:\Users\liuyb07\Desktop\project\ielts-vocab\node_modules\electron\dist"
$env:ELECTRON_RUN_AS_NODE = $null
[System.Environment]::SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", $null, "Process")
Start-Process -FilePath "$dist\electron.exe" -WorkingDirectory $dist
