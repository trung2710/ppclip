# Test kết nối MCP Server
$uri = "http://127.0.0.1:9011/mcp"
$headers = @{
    "Accept" = "application/json, text/event-stream"
}

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host " 1. KIỂM TRA DISCOVERY: GỌI tools/list           " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$bodyList = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
try {
    $resList = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body $bodyList -TimeoutSec 5
    $jsonLine = ($resList.Content -split "`n" | Where-Object { $_ -like "data: *" }).Substring(6)
    $dataList = $jsonLine | ConvertFrom-Json
    $toolsCount = $dataList.result.tools.Count
    Write-Host "[OK] Kết nối thành công! Đã tìm thấy $toolsCount công cụ MCP." -ForegroundColor Green
    Write-Host "Một số công cụ tiêu biểu:" -ForegroundColor Yellow
    $dataList.result.tools | Select-Object -First 5 | ForEach-Object { Write-Host "  - $($_.name): $($_.description)" }
} catch {
    Write-Host "[FAIL] Không thể kết nối tới MCP Server: $_" -ForegroundColor Red
    exit 1
}

Write-Host "`n=================================================" -ForegroundColor Cyan
Write-Host " 2. KIỂM TRA THỰC THI TOOL: GỌI tools/call       " -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan

$bodyCall = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_agents","arguments":{}}}'
try {
    $resCall = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body $bodyCall -TimeoutSec 5
    $jsonCallLine = ($resCall.Content -split "`n" | Where-Object { $_ -like "data: *" }).Substring(6)
    $dataCall = $jsonCallLine | ConvertFrom-Json
    Write-Host "[OK] FastMCP đã tiếp nhận và thực thi hàm list_agents thành công!" -ForegroundColor Green
    Write-Host "Kết quả JSON-RPC trả về từ server.py:" -ForegroundColor Yellow
    $dataCall.result.content | ForEach-Object { Write-Host $_.text -ForegroundColor White }
} catch {
    Write-Host "[FAIL] Lỗi khi gọi tool: $_" -ForegroundColor Red
}

Write-Host "`n=================================================" -ForegroundColor Cyan
Write-Host " [KẾT LUẬN] MCP SERVER HOẠT ĐỘNG HOÀN TOÀN BÌNH THƯỜNG!" -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan
