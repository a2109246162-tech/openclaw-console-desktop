; OpenClaw 控制台 安装程序脚本（v2）
; 产物：D:\opclaw\OpenClaw-Setup.exe
; 支持：Windows 10 / Windows 11（不支持 Win7/8）
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"

!define APP_NAME "OpenClaw 控制台"
!define APP_EXE "OpenClawConsole.exe"
!define APP_PUBLISHER "OpenClaw"
!define APP_VERSION "2.0.0"
!define REG_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenClawConsole"

Name "${APP_NAME}"
OutFile "D:\opclaw\OpenClaw-Setup.exe"
; 默认装到 D 盘（省 C 盘空间）；无 D 盘的机器由 .onInit 自动改为 C:\OpenClaw
InstallDir "C:\OpenClaw"
InstallDirRegKey HKLM "Software\OpenClawConsole" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 64

VIProductVersion "2.0.0.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "OpenClaw"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"

; ---------- 界面 ----------
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME}"
!define MUI_WELCOMEPAGE_TEXT "本程序将安装 OpenClaw 微信机器人控制台。$\r$\n$\r$\n仅支持 Windows 10 / Windows 11，不支持 Windows 7/8。$\r$\n$\r$\n点击「下一步」继续。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择安装位置。建议安装到非系统盘（例如 D 盘）以节省 C 盘空间。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ---------- 安装前检查 ----------
Function .onInit
  ; 系统版本检测（仅 Windows 10 / 11）
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "本程序仅支持 Windows 10 或更高版本，不支持 Windows 7/8。"
    Abort
  ${EndIf}

  ; 覆盖安装时自动关闭「目标目录里」的旧实例（按 exe 路径精确匹配，
  ; 绝不触碰电脑上其它 OpenClaw 实例，如 F:\openclaw 的生产环境）。
  ; 解决：旧实例占用文件导致"Error opening file for writing"，用户点忽略 → 装出残缺版本。
  ReadRegStr $0 HKLM "Software\OpenClawConsole" "InstallDir"
  StrCmp $0 "" pickDefault
  DetailPrint "正在关闭旧版实例（仅限 $0）..."
  System::Call 'kernel32::SetEnvironmentVariable(t "OC_TARGET", t "$0") i .r1'
  nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "Get-Process OpenClawConsole,node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith($$env:OC_TARGET) } | Stop-Process -Force"'
  Sleep 1000
  MessageBox MB_OKCANCEL|MB_ICONQUESTION "${APP_NAME} 已安装在：$\r$\n$0$\r$\n$\r$\n将继续覆盖安装（旧实例已自动关闭），是否继续？" IDOK done
  Abort

  pickDefault:
  ; 默认路径智能选择：有 D 盘 → D:\OpenClaw；否则 → C:\OpenClaw
  IfFileExists "D:\*.*" 0 noDDisk
    StrCpy $INSTDIR "D:\OpenClaw"
    Goto done
  noDDisk:
    StrCpy $INSTDIR "C:\OpenClaw"

  done:
FunctionEnd

; ---------- 安装 ----------
Section "主程序" SecMain
  SetOutPath "$INSTDIR"

  ; 注意：绝不终止或删除系统上其他 OpenClaw 实例（本安装只写自己的目录）

  ; 部分系统（尤其精简版）可能缺少 VC++ 运行库 → Node 网关无法启动，这里自动补装
  IfFileExists "$SYSDIR\vcruntime140.dll" vcSkip 0
    DetailPrint "正在安装 VC++ 2015-2022 运行库（网关运行必需）..."
    SetOutPath "$TEMP"
    File "vc_redist.x64.exe"
    ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart' $0
    DetailPrint "VC++ 运行库安装完成（返回码 $0）"
    Delete "$TEMP\vc_redist.x64.exe"
    SetOutPath "$INSTDIR"
  vcSkip:

  DetailPrint "正在安装组件（界面 / 运行时 / 模型配置）..."
  File /r /x OpenClawConsole.exe /x debug.log /x console-boot.log /x gateway.log /x gw-test.log "app-root\*.*"

  DetailPrint "正在安装主程序..."
  File "app-root\OpenClawConsole.exe"

  ; 注册表：安装路径 + 卸载信息
  WriteRegStr HKLM "Software\OpenClawConsole" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${REG_UNINST}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${REG_UNINST}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${REG_UNINST}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "${REG_UNINST}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKLM "${REG_UNINST}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${REG_UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${REG_UNINST}" "NoModify" 1
  WriteRegDWORD HKLM "${REG_UNINST}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 快捷方式
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  ; 计算安装体积
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${REG_UNINST}" "EstimatedSize" "$0"
SectionEnd

; ---------- 卸载 ----------
Section "Uninstall"
  ; 只清理本安装创建的项，绝不触碰其他 OpenClaw 实例

  ; 删除程序文件
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.log"
  Delete "$INSTDIR\*.vbs"
  Delete "$INSTDIR\LICENSE*"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  ; 若仍有文件残留（程序未退出），提示手动处理
  IfFileExists "$INSTDIR\${APP_EXE}" 0 noWarn
    MessageBox MB_ICONEXCLAMATION "部分文件正在使用，未能删除。$\r$\n$\r$\n请退出「${APP_NAME}」（包括托盘图标）后重新运行卸载程序。"
  noWarn:

  ; 快捷方式
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  ; 注册表（仅本安装写入的键）
  DeleteRegKey HKLM "${REG_UNINST}"
  DeleteRegKey HKLM "Software\OpenClawConsole"
  ; 开机自启 Run 键（任务管理器 → 启动 项）
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenClaw 控制台"

  ; 交互模式才询问是否删除用户数据；静默卸载默认保留
  IfSilent keepData
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本程序的用户配置与聊天记录（$PROFILE\.openclaw）？$\r$\n$\r$\n⚠ 注意：若本机还有其他 OpenClaw 实例，选「是」会一并删除其配置，请谨慎。$\r$\n$\r$\n选「否」将保留配置。" IDYES delData IDNO keepData
  delData:
    RMDir /r "$PROFILE\.openclaw"
    RMDir /r "$APPDATA\OpenClawConsole"
  keepData:
SectionEnd
