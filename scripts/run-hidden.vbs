' Launch a command line with no window at all.
'
' Why this exists: `启动全部.cmd` used to start the services through the scheduled
' tasks, and those tasks ran node.exe under the interactive token, which made a
' Windows Terminal window pop up every 2-5 minutes. Simply spawning `cmd.exe /c
' something.bat` from Node with CREATE_NO_WINDOW + DETACHED_PROCESS does not help:
' a detached child has no console, so cmd.exe allocates a brand new one - and that
' console gets a visible window again (verified 2026-11-15: cmd.exe /d /c
' launcher.bat showed up as a Windows Terminal tab titled "node  ./index.mjs").
'
' WshShell.Run with window style 0 creates the console hidden, and every process
' the .bat starts inherits that hidden console, so nothing ever flashes on screen.
'
' Usage:
'   wscript //nologo //B run-hidden.vbs "<command line>" ["<working dir>" ["<log file>"]]
'
' The log file is appended by THIS script (`>> "log" 2>&1`) instead of being part of
' the command line: WScript's argument parser does not understand the \" escapes Node
' puts around inner quotes, so passing a pre-quoted redirection silently failed
' (2026-11-15: nothing started and nothing was logged).
Option Explicit
On Error Resume Next

Dim shell, commandLine, workingDirectory, logFile, fso, handle
If WScript.Arguments.Count < 1 Then WScript.Quit 2

commandLine = WScript.Arguments(0)
If WScript.Arguments.Count > 1 Then workingDirectory = WScript.Arguments(1)
If WScript.Arguments.Count > 2 Then logFile = WScript.Arguments(2)

If Len(logFile) > 0 Then commandLine = commandLine & " >> """ & logFile & """ 2>&1"

Set shell = CreateObject("WScript.Shell")
If Len(workingDirectory) > 0 Then shell.CurrentDirectory = workingDirectory
shell.Run commandLine, 0, False

If Err.Number <> 0 Then
    If Len(logFile) > 0 Then
        Set fso = CreateObject("Scripting.FileSystemObject")
        Set handle = fso.OpenTextFile(logFile, 8, True)
        handle.WriteLine "[run-hidden] launch failed: " & Err.Description & " | " & commandLine
        handle.Close
    End If
    WScript.Quit 1
End If
