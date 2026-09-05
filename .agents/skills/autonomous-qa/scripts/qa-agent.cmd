@echo off
rem Windows launcher for the installed skill. The POSIX sibling is `qa-agent`.
rem %~dp0 ends with a backslash, so ".." resolves against the scripts directory.
setlocal
set "SKILL_ROOT=%~dp0.."
node "%SKILL_ROOT%\scripts\qa-agent.mjs" %*
exit /b %ERRORLEVEL%
