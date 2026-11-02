# ClaudeSwitcher's additions to electron-builder's NSIS installer (`nsis.include` in
# electron-builder.yml). electron-builder includes this file in the script header, before its
# templates, for both builds it compiles: the uninstaller (BUILD_UNINSTALLER defined) and the
# installer. The templates test each hook with `!ifmacrodef`, so a macro defined here replaces or
# extends the default.
#
# What the templates (node_modules/app-builder-lib/templates/nsis/, app-builder-lib 26.18.0) do:
#
# - The page. assistedInstaller.nsh inserts `customPageAfterChangeDir` after the directory page,
#   which is compiled only with `allowToChangeInstallationDirectory` (off here), and right before
#   MUI_PAGE_INSTFILES. So that macro is where the shortcut page goes. MUI2.nsh is included only
#   after this file (installer.nsi), so the page functions, which use MUI_HEADER_TEXT, are
#   defined inside that macro.
#
# - Uninstall order. In uninstaller.nsh, Section "un.${UNINSTALL_SECTION_NAME}" runs, in order:
#   `un.checkAppRunning` (non-silent; a silent run calls it in `un.onInit`), `setLinkVars`,
#   `customUnInstall`, and only then "delete the installed files" (`customRemoveFiles` or
#   RMDir /r $INSTDIR). So `customUnInstall` runs while the installed exe still exists, and no
#   earlier hook is needed. The template's own shortcut removal is compiled out, because
#   createDesktopShortcut and createStartMenuShortcut are false (DO_NOT_CREATE_DESKTOP_SHORTCUT,
#   DO_NOT_CREATE_START_MENU_SHORTCUT in NsisTarget.js); `customUnInstall` removes ours.
#
# - Upgrade. installSection.nsh runs `uninstallOldVersion` (include/installUtil.nsh), which starts
#   the old uninstaller with `/S` and `--updated`. That old uninstaller still runs
#   `customUnInstall`, so everything in it that must survive an upgrade (the Claude Code
#   integration, autostart, the shortcuts and their stored choices) is behind
#   `${IfNot} ${isUpdated}`. `isUpdated` tests the `--updated` flag (nsisScriptGenerator.js
#   `flags`). That uninstaller also deletes "${INSTALL_REGISTRY_KEY}" (`Software\${APP_GUID}`,
#   multiUser.nsh), which is why the shortcut choices live under their own key.
#
# - Closing the running app. include/allowOnlyOneInstallerInstance.nsh `CHECK_APP_RUNNING`
#   inserts `customCheckAppRunning` if defined, else `_CHECK_APP_RUNNING`, which finds the app by
#   its install path or process name and kills it (`KILL_PROCESS`: Stop-Process, or taskkill and
#   then taskkill /F). With our macro defined, `_CHECK_APP_RUNNING` and `KILL_PROCESS` are never
#   inserted, and getProcessInfo.nsh is not included (`!ifmacrondef customCheckAppRunning`).
#   `CHECK_APP_RUNNING` runs in the installer's install section (installSection.nsh, before
#   `uninstallOldVersion`) and in the uninstaller (`un.checkAppRunning`).
#
# The app's side of `--quit` and `--uninstall`: apps/desktop/src/main/index.ts `runHelper`, exit
# codes in apps/desktop/src/main/instance.ts `LAUNCH_EXIT_CODE`. A helper exits once it holds the
# single-instance lock: at once when nothing runs, otherwise after Electron released the lock
# during the running app's quit sequence, which is after that app's daemon stopped. That is not
# the same as the process being gone. The next installer step is always another Electron start
# (the old uninstaller's own `--quit`, or `--uninstall`) or file work after that.

!include LogicLib.nsh
!include nsDialogs.nsh

# The two shortcut choices, kept across installs. DWORD values: StartMenuShortcut (default 1)
# and DesktopShortcut (default 0).
!define CS_INSTALLER_KEY "Software\ClaudeSwitcher\Installer"
!define CS_HELPER_EXE "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
# instance.ts LAUNCH_EXIT_CODE
!define CS_EXIT_OK 0
!define CS_EXIT_INTEGRATION_FAILED 2

# Runs the installed exe with a helper flag (`--quit` or `--uninstall`) and leaves its exit code in
# $0. While it reports that the running app could not be closed, it asks to close the app from the
# tray and retries; Cancel (and any silent run) quits the installer or uninstaller, as the
# template's own check does. ACCEPTED is one more exit code, besides ok, that ends the loop. If the
# exe does not exist (a first install) or cannot be started, nothing can be asked to quit, so it
# goes on. It never kills a process.
!macro csRunHelper FLAG ACCEPTED
  StrCpy $0 ${CS_EXIT_OK}
  ${If} ${FileExists} "${CS_HELPER_EXE}"
    ${Do}
      ClearErrors
      ExecWait '"${CS_HELPER_EXE}" ${FLAG}' $0
      ${If} ${Errors}
        DetailPrint `Could not start "${CS_HELPER_EXE}" ${FLAG}.`
        StrCpy $0 ${CS_EXIT_OK}
        ${ExitDo}
      ${EndIf}
      ${If} $0 == ${CS_EXIT_OK}
      ${OrIf} $0 == ${ACCEPTED}
        ${ExitDo}
      ${EndIf}
      ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Nem sikerült bezárni a futó ClaudeSwitchert. Zárd be a tálcáról, aztán válaszd az Újra gombot." /SD IDCANCEL IDCANCEL`
        # A cancelled run must not look like success, for example to `uninstallOldVersion`,
        # whose `handleUninstallResult` reports any non-zero exit code of the old uninstaller.
        SetErrorLevel 1
        Quit
      ${EndIf}
    ${Loop}
  ${EndIf}
!macroend

# Replaces the default kill: asks the running app to quit through its normal `before-quit`
# sequence, which lets its daemon release held permission requests.
!macro customCheckAppRunning
  Push $0
  !insertmacro csRunHelper "--quit" ${CS_EXIT_OK}
  Pop $0
!macroend

!ifndef BUILD_UNINSTALLER
  Var csStartMenuShortcut
  Var csDesktopShortcut
  Var csStartMenuCheckbox
  Var csDesktopCheckbox

  # Reads a stored choice as 1 or 0, with DEFAULT when it was never stored.
  !macro csReadChoice VAR NAME DEFAULT
    ClearErrors
    ReadRegDWORD ${VAR} HKCU "${CS_INSTALLER_KEY}" "${NAME}"
    ${If} ${Errors}
      StrCpy ${VAR} ${DEFAULT}
    ${ElseIf} ${VAR} != 0
      StrCpy ${VAR} 1
    ${EndIf}
  !macroend

  # Runs in .onInit, so a silent install, which shows no page, uses the stored choices too.
  !macro customInit
    !insertmacro csReadChoice $csStartMenuShortcut StartMenuShortcut 1
    !insertmacro csReadChoice $csDesktopShortcut DesktopShortcut 0
  !macroend

  !macro customPageAfterChangeDir
    Page custom csShortcutPageCreate csShortcutPageLeave

    Function csShortcutPageCreate
      ${If} ${Silent}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Parancsikonok" "Válaszd ki, hol legyen ClaudeSwitcher parancsikon."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateCheckbox} 0 0 100% 12u "Start menü parancsikon"
      Pop $csStartMenuCheckbox
      ${If} $csStartMenuShortcut == 1
        ${NSD_Check} $csStartMenuCheckbox
      ${EndIf}

      ${NSD_CreateCheckbox} 0 18u 100% 12u "Asztali parancsikon"
      Pop $csDesktopCheckbox
      ${If} $csDesktopShortcut == 1
        ${NSD_Check} $csDesktopCheckbox
      ${EndIf}

      nsDialogs::Show
    FunctionEnd

    Function csShortcutPageLeave
      ${NSD_GetState} $csStartMenuCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $csStartMenuShortcut 1
      ${Else}
        StrCpy $csStartMenuShortcut 0
      ${EndIf}
      ${NSD_GetState} $csDesktopCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $csDesktopShortcut 1
      ${Else}
        StrCpy $csDesktopShortcut 0
      ${EndIf}
    FunctionEnd
  !macroend

  # Creates a chosen shortcut, or removes an unchosen one left by an earlier install. LINK is the
  # template's own path ($newStartMenuLink or $newDesktopLink, common.nsh `setLinkVars`) and the
  # target $appExe is "$INSTDIR\${APP_EXECUTABLE_FILENAME}" (installSection.nsh), so the finish
  # page's launch link and the uninstaller agree with it. The AppUserModelID matches what the
  # template's addStartMenuLink sets.
  !macro csApplyShortcut CHOSEN LINK
    ${If} ${CHOSEN} == 1
      CreateShortCut "${LINK}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "${LINK}" "${APP_ID}"
    ${ElseIf} ${FileExists} "${LINK}"
      WinShell::UninstShortcut "${LINK}"
      Delete "${LINK}"
    ${EndIf}
  !macroend

  # Silent runs only: a stored choice of 1 whose shortcut file is gone means the user deleted it by
  # hand, so it counts as 0 and is not recreated (customInstall writes the 0 back). Without a
  # stored value the defaults apply. The interactive page keeps the stored choices as they are.
  !macro csForgetDeleted CHOSEN NAME LINK
    ${If} ${Silent}
    ${AndIf} ${CHOSEN} == 1
    ${AndIfNot} ${FileExists} "${LINK}"
      Push $0
      ClearErrors
      ReadRegDWORD $0 HKCU "${CS_INSTALLER_KEY}" "${NAME}"
      ${IfNot} ${Errors}
        StrCpy ${CHOSEN} 0
      ${EndIf}
      Pop $0
    ${EndIf}
  !macroend

  !macro customInstall
    !insertmacro csForgetDeleted $csStartMenuShortcut StartMenuShortcut "$newStartMenuLink"
    !insertmacro csForgetDeleted $csDesktopShortcut DesktopShortcut "$newDesktopLink"
    !insertmacro csApplyShortcut $csStartMenuShortcut "$newStartMenuLink"
    !insertmacro csApplyShortcut $csDesktopShortcut "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    WriteRegDWORD HKCU "${CS_INSTALLER_KEY}" StartMenuShortcut $csStartMenuShortcut
    WriteRegDWORD HKCU "${CS_INSTALLER_KEY}" DesktopShortcut $csDesktopShortcut
  !macroend
!endif

# A real uninstall only (Review Focus 1): an upgrade runs this with `--updated`, and must keep the
# integration, autostart and the shortcuts. `--uninstall` makes the app quit if it still runs,
# turn autostart off and remove the Claude Code integration (setup.ts stays the only writer of
# settings.json). userData is kept (deleteAppDataOnUninstall: false); repo builds share it.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Push $0
    !insertmacro csRunHelper "--uninstall" ${CS_EXIT_INTEGRATION_FAILED}
    ${If} $0 == ${CS_EXIT_INTEGRATION_FAILED}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Nem sikerült eltávolítani a Claude Code integrációt a settings.json fájlból. Az eltávolítás folytatódik, a ClaudeSwitcher bejegyzéseit kézzel kell törölni." /SD IDOK
    ${EndIf}
    Pop $0

    WinShell::UninstAppUserModelId "${APP_ID}"
    WinShell::UninstShortcut "$newStartMenuLink"
    Delete "$newStartMenuLink"
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    DeleteRegKey HKCU "${CS_INSTALLER_KEY}"
    DeleteRegKey /ifempty HKCU "Software\ClaudeSwitcher"
  ${EndIf}
!macroend
