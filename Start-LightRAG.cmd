@echo off
setlocal
set "PYTHONIOENCODING=utf-8"
set "LIGHTRAG_WORKING_DIR=%~dp0Data\lightrag"
set "LIGHTRAG_HOST=127.0.0.1"
set "LIGHTRAG_PORT=9621"

rem 需要先在本机启动并配置 Ollama（或在未来设置页选择其它兼容模型端点）。
rem 可用 LIGHTRAG_SERVER 指定 lightrag-server 可执行文件路径，未指定时从 PATH 查找。
if not defined LIGHTRAG_SERVER set "LIGHTRAG_SERVER=lightrag-server"
"%LIGHTRAG_SERVER%" --host %LIGHTRAG_HOST% --port %LIGHTRAG_PORT% --working-dir "%LIGHTRAG_WORKING_DIR%"
