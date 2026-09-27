# Instala o Livrinhos de Colorir neste computador:
#  - o servidor liga junto com o Windows (tarefa agendada como SYSTEM, escondida,
#    religada sozinha se cair), então a sincronização com o celular fica sempre pronta
#  - libera a porta no firewall para o celular (só em rede privada/doméstica)
#  - cria o ícone na área de trabalho e no menu Iniciar, que abre o app numa janela própria
param([switch]$SemPausa)

$ErrorActionPreference = "Stop"
$NOME = "Livrinhos de Colorir"
$PORTA = 8765

# Pede permissão de administrador, se ainda não tiver
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argumentos = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($SemPausa) { $argumentos += "-SemPausa" }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argumentos
    exit
}

$pasta = Split-Path -Parent $PSScriptRoot
$servidor = Join-Path $pasta "server.py"
$icone = Join-Path $PSScriptRoot "livrinhos.ico"
Start-Transcript -Path (Join-Path $PSScriptRoot "instalacao.log") -Force | Out-Null

function Passo($texto) { Write-Host "`n>> $texto" -ForegroundColor Cyan }

try {
    Write-Host "=== Instalando o $NOME ===" -ForegroundColor Yellow
    Write-Host "Pasta: $pasta"

    # 1. Python
    Passo "Procurando o Python"
    $python = $null
    $tentativas = @(
        { py -3 -c "import sys; print(sys.executable)" },
        { python -c "import sys; print(sys.executable)" }
    )
    foreach ($tentativa in $tentativas) {
        try {
            $caminho = (& $tentativa 2>$null | Select-Object -Last 1)
            if ($caminho -and (Test-Path $caminho.Trim())) { $python = $caminho.Trim(); break }
        } catch {}
    }
    if (-not $python) { throw "Python não encontrado. Instale em https://www.python.org/downloads/ e rode o instalador de novo." }
    $pythonw = Join-Path (Split-Path $python) "pythonw.exe"
    if (-not (Test-Path $pythonw)) { $pythonw = $python }
    Write-Host "Python: $pythonw"

    # 2. Para o que estiver rodando (versão antiga da tarefa ou janela aberta)
    Passo "Parando o servidor antigo, se estiver rodando"
    if (Get-ScheduledTask -TaskName $NOME -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $NOME -ErrorAction SilentlyContinue
    }
    Get-NetTCPConnection -LocalPort $PORTA -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host "Parado o processo $($_.OwningProcess)" }
    Start-Sleep -Seconds 1

    # 3. Tarefa que liga o servidor com o Windows
    Passo "Criando o serviço que liga junto com o Windows"
    $acao = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$servidor`" --servico" -WorkingDirectory $pasta
    $aoLigar = New-ScheduledTaskTrigger -AtStartup
    # A cada 5 minutos confere se está rodando; se tiver caído, liga de novo
    $vigia = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $conta = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $NOME -Action $acao -Trigger @($aoLigar, $vigia) -Principal $conta `
        -Settings $config -Description "Servidor do Livrinhos de Colorir (sincronização com o celular)" -Force | Out-Null
    Write-Host "Tarefa '$NOME' criada."

    # 4. Firewall
    Passo "Liberando o celular no firewall (rede privada)"
    Get-NetFirewallRule -DisplayName "$NOME*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "$NOME (sincronização com o celular)" -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $PORTA -Profile Private, Domain | Out-Null
    Write-Host "Porta $PORTA liberada nas redes privadas."

    $publicas = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq "Public" }
    foreach ($rede in $publicas) {
        Write-Host "`nA rede '$($rede.Name)' está marcada como PÚBLICA. Assim o celular não consegue sincronizar." -ForegroundColor Yellow
        $resposta = if ($SemPausa) { "N" } else { Read-Host "É a rede de casa? Marcar como PRIVADA? (S/N)" }
        if ($resposta -match "^[sS]") {
            Set-NetConnectionProfile -InterfaceIndex $rede.InterfaceIndex -NetworkCategory Private
            Write-Host "Rede '$($rede.Name)' agora é privada."
        } else {
            Write-Host "Mantida como pública. Para sincronizar, marque a rede de casa como privada nas configurações do Wi-Fi."
        }
    }

    # 5. Ícones
    Passo "Criando os ícones"
    $navegador = @(
        (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" -ErrorAction SilentlyContinue).'(default)',
        (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" -ErrorAction SilentlyContinue).'(default)'
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    $shell = New-Object -ComObject WScript.Shell
    $destinos = @(
        [Environment]::GetFolderPath("CommonDesktopDirectory"),
        [Environment]::GetFolderPath("CommonPrograms")
    )
    foreach ($dir in $destinos) {
        $atalho = $shell.CreateShortcut((Join-Path $dir "$NOME.lnk"))
        if ($navegador) {
            # Abre como app: janela própria, sem barra de endereço
            $atalho.TargetPath = $navegador
            $atalho.Arguments = "--app=http://localhost:$PORTA"
        } else {
            $atalho.TargetPath = "$env:WINDIR\explorer.exe"
            $atalho.Arguments = "http://localhost:$PORTA"
        }
        $atalho.IconLocation = "$icone,0"
        $atalho.Description = "Montar e imprimir livrinhos de colorir"
        $atalho.WorkingDirectory = $pasta
        $atalho.Save()
        Write-Host "Ícone: $($atalho.FullName)"
    }

    # 6. Liga agora e confere
    Passo "Ligando o servidor"
    Start-ScheduledTask -TaskName $NOME
    $ok = $false
    for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
        Start-Sleep -Milliseconds 750
        $tcp = New-Object Net.Sockets.TcpClient
        try { $ok = $tcp.ConnectAsync("127.0.0.1", $PORTA).Wait(1000) -and $tcp.Connected } catch {} finally { $tcp.Dispose() }
    }
    if (-not $ok) { throw "O servidor não respondeu. Veja o arquivo servidor.log na pasta do projeto." }

    Write-Host "`n=== Pronto! ===" -ForegroundColor Green
    Write-Host "O Livrinhos agora liga sozinho junto com o computador."
    Write-Host "Use o ícone '$NOME' na área de trabalho para abrir."
    if (-not $SemPausa -and $navegador) { Start-Process $navegador "--app=http://localhost:$PORTA" }
} catch {
    Write-Host "`nERRO: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Stop-Transcript | Out-Null
    if (-not $SemPausa) { Read-Host "`nAperte Enter para fechar" | Out-Null }
}
