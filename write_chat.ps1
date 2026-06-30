$file = "C:\Users\johnr\SuppliWise\my-react-app\src\Pages\ChatAssistant.jsx"
$content = Get-Content $file -Raw
Write-Host "Current length: $($content.Length)"
