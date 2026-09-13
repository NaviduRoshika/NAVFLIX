; NAVFLIX installer. Build it with installer\build.js, which stages the files and
; passes /DStage, /DOutDir, /DIcon and /DAppVersion. See README, "Making the
; installer".
;
; Installed per user, into %LOCALAPPDATA%\Programs\NAVFLIX, so it needs no admin
; password and NAVFLIX can write its data folder beside itself exactly as it does
; when run from a drive.

#ifndef Stage
  #error Build this with installer\build.js.
#endif

[Setup]
AppId={{6F1C2A7E-3B9D-4C8E-A5F4-2D7B9E1C0A63}
AppName=NAVFLIX
AppVersion={#AppVersion}
AppVerName=NAVFLIX {#AppVersion}
AppPublisher=Navidu Roshika
AppPublisherURL=https://github.com/NaviduRoshika/NAVFLIX
DefaultDirName={localappdata}\Programs\NAVFLIX
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
; Named with the version, so which one you are handing over is never a guess.
OutputBaseFilename={#OutputBase}
; The same version in the file's own properties, where Windows shows it.
VersionInfoVersion={#AppVersion}
VersionInfoProductName=NAVFLIX
VersionInfoDescription=NAVFLIX Setup
VersionInfoCompany=Navidu Roshika
SetupIconFile={#Icon}
UninstallDisplayIcon={app}\NAVFLIX.exe
UninstallDisplayName=NAVFLIX
WizardStyle=modern
; ultra, not ultra64: the 64 variant wants a dictionary of up to a gigabyte, which
; the compiler cannot hold ("Out of memory"). Compressing in a separate process
; keeps what memory it does need off the compiler's own.
Compression=lzma2/ultra
SolidCompression=yes
LZMAUseSeparateProcess=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; An upgrade over a running NAVFLIX: node.exe and VLC would hold their files open.
; PrepareToInstall below asks it to stop; this closes anything left.
CloseApplications=force
RestartApplications=no
SetupMutex=NAVFLIXSetupMutex

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\NAVFLIX"; Filename: "{app}\NAVFLIX.exe"; Comment: "Watch your films and shows"
Name: "{autodesktop}\NAVFLIX"; Filename: "{app}\NAVFLIX.exe"; Comment: "Watch your films and shows"; Tasks: desktopicon

[Run]
Filename: "{app}\NAVFLIX.exe"; Description: "{cm:LaunchProgram,NAVFLIX}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\NAVFLIX.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "StopNAVFLIX"

[Code]
// Before files are replaced on an upgrade, stop a NAVFLIX that is running.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Launcher: String;
begin
  Launcher := ExpandConstant('{app}\NAVFLIX.exe');
  if FileExists(Launcher) then
    Exec(Launcher, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

// The data folder is not something the installer put there, so uninstalling
// leaves it unless asked: reinstalling then picks up where you left off. A silent
// uninstall always keeps it.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if DirExists(ExpandConstant('{app}\data')) then
    begin
      if SuppressibleMsgBox('Also delete your watch history, settings and downloaded artwork?' + #13#10#13#10 +
        'Choose No to keep them, so that installing NAVFLIX again picks up where you left off.' + #13#10 +
        'Your films themselves are never touched either way.',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      begin
        DelTree(ExpandConstant('{app}\data'), True, True, True);
        DelTree(ExpandConstant('{localappdata}\NAVFLIX'), True, True, True);
        RemoveDir(ExpandConstant('{app}'));
      end;
    end;
  end;
end;
