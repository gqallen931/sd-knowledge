!include "MUI2.nsh"

!define MUI_ICON "resources\icon.ico"
!define MUI_UNICON "resources\icon.ico"

!define APP_NAME "SD Knowledge"
!define APP_VERSION "1.0.0"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "SD-Setup-${APP_VERSION}.exe"
InstallDir "$DOCUMENTS\..\SD\Program"
RequestExecutionLevel admin

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimplifiedChinese"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  File /r "dist\*.*"
  File /r "dist-electron\*.*"
  File /r "resources\*.*"

  CreateDirectory "$DOCUMENTS\..\SD\Data"
  CreateDirectory "$DOCUMENTS\..\SD\Data\files\documents"
  CreateDirectory "$DOCUMENTS\..\SD\Data\files\spreadsheets"
  CreateDirectory "$DOCUMENTS\..\SD\Data\files\images"
  CreateDirectory "$DOCUMENTS\..\SD\Data\files\videos"
  CreateDirectory "$DOCUMENTS\..\SD\Data\files\others"
  CreateDirectory "$DOCUMENTS\..\SD\Data\references"
  CreateDirectory "$DOCUMENTS\..\SD\Data\thumbnails"
  CreateDirectory "$DOCUMENTS\..\SD\Data\indexes"
  CreateDirectory "$DOCUMENTS\..\SD\Data\backups"
  CreateDirectory "$DOCUMENTS\..\SD\Data\logs"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
SectionEnd
