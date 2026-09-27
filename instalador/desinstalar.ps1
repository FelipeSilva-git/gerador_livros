# Desinstala o serviço, a liberação do firewall e os ícones do Livrinhos de Colorir.
# NÃO apaga os livros: o banco historias.db continua na pasta do projeto.
param([switch]$SemPausa)

$ErrorActionPreference = "Stop"
$NOME = "Livrinhos de Colorir"
$PORTA = 8765

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argumentos = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($SemPausa) { $argumentos += "-SemPausa" }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argumentos
    exit
}

Start-Transcript -Path (Join-Path $PSScriptRoot "desinstalacao.log") -Force | Out-Null
try {
    Write-Host "=== Desinstalando o $NOME ===" -ForegroundColor Yellow

    if (Get-ScheduledTask -TaskName $NOME -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $NOME -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $NOME -Confirm:$false
        Write-Host "Serviço removido."
    }
    Get-NetTCPConnection -LocalPort $PORTA -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host "Servidor parado." }

    Get-NetFirewallRule -DisplayName "$NOME*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Host "Liberação do firewall removida."

    foreach ($dir in @([Environment]::GetFolderPath("CommonDesktopDirectory"), [Environment]::GetFolderPath("CommonPrograms"))) {
        $atalho = Join-Path $dir "$NOME.lnk"
        if (Test-Path $atalho) { Remove-Item $atalho -Force; Write-Host "Ícone removido: $atalho" }
    }

    Write-Host "`n=== Pronto! Os livros continuam guardados em historias.db ===" -ForegroundColor Green
} catch {
    Write-Host "`nERRO: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Stop-Transcript | Out-Null
    if (-not $SemPausa) { Read-Host "`nAperte Enter para fechar" | Out-Null }
}
