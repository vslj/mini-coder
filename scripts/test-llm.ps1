# test-llm.ps1 —— 手动验证一次 LLM API 调用（OpenAI 兼容协议）
# 用法：
#   1. 把下面三个配置改成你自己的（或用环境变量 LLM_API_KEY）
#   2. 终端运行:  .\test-llm.ps1
#   3. 可选参数:  .\test-llm.ps1 -Prompt "帮我写个冒泡排序" -MaxTokens 2048

param(
    [string]$Prompt = "你好，请用一句话介绍你自己",
    [int]$MaxTokens = 1024
)

# ================== 配置区：改这里 ==================
$ApiUrl  = "https://api.deepseek.com/chat/completions"   # DeepSeek 官方（/v1/chat/completions 也可以）
# key 读取顺序：环境变量 DEEPSEEK_API_KEY 优先；没设环境变量时用下面写死的值
$ApiKey  = if ($env:DEEPSEEK_API_KEY) { $env:DEEPSEEK_API_KEY } else { "sk-xxxx" }
$Model   = "deepseek-v4-pro"                             # deepseek-chat / deepseek-reasoner / deepseek-v4-pro
# ===================================================

Write-Host ""
Write-Host "===== 调用前自检 =====" -ForegroundColor Cyan

if ($ApiKey -and $ApiKey.Length -gt 10) {
    Write-Host "[OK] ApiKey 已配置 ($($ApiKey.Substring(0,6))...)" -ForegroundColor Green
} elseif ($env:DEEPSEEK_API_KEY) {
    Write-Host "[OK] ApiKey 来自环境变量 DEEPSEEK_API_KEY" -ForegroundColor Green
} else {
    Write-Host "[错误] ApiKey 为空！请先执行: " -ForegroundColor Red -NoNewline
    Write-Host "`$env:DEEPSEEK_API_KEY = 'sk-你的key'" -ForegroundColor Yellow
    exit 1
}

if ($ApiUrl -match "你的endpoint" -or $Model -match "你的模型名") {
    Write-Host "[错误] 配置区还没改！请打开脚本修改 ApiUrl / Model" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] URL : $ApiUrl"
Write-Host "[OK] 模型: $Model"

# 构造请求体（here-string 里的 JSON 不需要转义）
$body = @"
{
  "model": "$Model",
  "max_tokens": $MaxTokens,
  "messages": [
    { "role": "user", "content": "$Prompt" }
  ]
}
"@

Write-Host ""
Write-Host "===== 发起请求 =====" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
    $resp = Invoke-RestMethod -Uri $ApiUrl `
        -Method Post `
        -ContentType "application/json; charset=utf-8" `
        -Headers @{ Authorization = "Bearer $ApiKey" } `
        -Body $body `
        -TimeoutSec 120

    $sw.Stop()
    Write-Host "===== 调用成功 (耗时 $([math]::Round($sw.Elapsed.TotalSeconds, 1)) 秒) =====" -ForegroundColor Green
    Write-Host ""

    # OpenAI 兼容协议的标准响应结构
    $text = $resp.choices[0].message.content
    if ($text) {
        Write-Host "--- 模型回复 ---" -ForegroundColor Cyan
        Write-Host $text
    } else {
        Write-Host "--- 回复为空，完整响应如下 ---" -ForegroundColor Yellow
        $resp | ConvertTo-Json -Depth 10
    }

    # 思维链（reasoner / v4-pro 开 thinking 时会返回 reasoning_content）
    $reasoning = $resp.choices[0].message.reasoning_content
    if ($reasoning) {
        Write-Host "--- 思维链（前 500 字）---" -ForegroundColor DarkCyan
        if ($reasoning.Length -gt 500) { Write-Host ($reasoning.Substring(0, 500) + " ...") }
        else { Write-Host $reasoning }
    }

    # token 用量
    if ($resp.usage) {
        Write-Host ""
        Write-Host "Token 用量: 输入 $($resp.usage.prompt_tokens) / 输出 $($resp.usage.completion_tokens)"
    }
}
catch {
    $sw.Stop()
    Write-Host "===== 调用失败 (耗时 $([math]::Round($sw.Elapsed.TotalSeconds, 1)) 秒) =====" -ForegroundColor Red
    Write-Host "错误信息: $($_.Exception.Message)"
    # 服务端返回的原始错误体（含平台错误码和 request id）
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        Write-Host "服务端响应体: $($_.ErrorDetails.Message)" -ForegroundColor Yellow
    }

    if ($_.Exception.Response) {
        $code = [int]$_.Exception.Response.StatusCode
        Write-Host "HTTP 状态码: $code"
        # 把服务端返回的错误体也读出来（含平台自己的错误码和 request id）
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $errBody = $reader.ReadToEnd()
                if ($errBody) { Write-Host "服务端响应体: $errBody" -ForegroundColor Yellow }
            }
        } catch {}
        if ($code -eq 404) {
            Write-Host "404 提示: 方舟对『模型未开通/接入点不存在』也返回 404。" -ForegroundColor Yellow
            Write-Host "  -> 检查控制台是否已开通该模型，或改用 ep- 开头的推理接入点 ID 作为 model"
        }
    }

    Write-Host ""
    Write-Host "常见原因对照:" -ForegroundColor Cyan
    Write-Host "  401/403 -> key 错误，或平台要求不同的认证头"
    Write-Host "  404     -> URL 路径不对（注意 /v1/chat/completions）"
    Write-Host "  400     -> 模型名不对，或参数不被该平台支持（比如不认 max_tokens）"
    Write-Host "  超时    -> 网络不通，或需要配置代理"
    exit 1
}
