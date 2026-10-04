import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand, isReadOnlyTool, isReadOnlyPermissionRequest, isReadOnlyCommandRequest } from './approval-policy.js';

test('static read commands include Windows wrappers, pipelines and sequences', () => {
  const reads = [
    'Get-Content README.md',
    'Get-ChildItem -Force',
    'Get-ChildItem -LiteralPath "C:\\Project Files" | Select-Object Name,Length',
    'Get-Content README.md | Select-Object -First 20',
    'Get-Content command-handler.js; Get-Content write-report.md',
    'powershell.exe -NoProfile -Command "Get-Content README.md | Select-Object -First 20"',
    '& "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem"',
    'pwsh -NonInteractive -Command "Get-Content README.md"',
    "bash -lc 'cat README.md && git status'",
    'git status; git diff --stat',
    'git -c safe.directory=C:/example -C .public-release status --short',
    'git branch --list',
    'git remote -v',
    'rg -n "write|delete" command-handler.js',
    "cat 'write;delete.txt'",
    'Get-Content README.md\nGet-FileHash README.md',
    'Get-Content README.md;\n',
  ];
  for (const command of reads) assert.equal(isReadOnlyCommand(command), true, command);
});

test('unknown or writing commands never become reads because of a filename or keyword', () => {
  const commands = [
    '', 'Get-Content a | Set-Content b', 'git status; Remove-Item report.xlsx',
    'cat README.md > copy.md', 'cat README.md 2>&1', 'git branch new-branch',
    'git branch -D main', 'git diff --output=result.txt', 'git log --ext-diff',
    'git -c core.pager=evil log', 'rg --pre=evil README.md',
    'rg --hostname-bin evil README.md', 'find . -exec touch x ;',
    'awk "BEGIN { system(command) }"', 'sed -n "w output" input',
    'python -c "import openpyxl; exec(code)"', 'node -e "writeExcel()"',
    'Remove-Item report.xlsx', 'curl https://example.com/read.csv',
    'powershell -EncodedCommand YQ==', 'powershell -File read.ps1',
    'powershell -Command "Get-Content a; Remove-Item b"',
    'Get-Content $(Remove-Item b)', 'Get-Content "a$(Remove-Item b)"',
    'Get-Content a | ForEach-Object { Remove-Item $_ }',
    'Get-Content a & Remove-Item b', 'Get-Content a |',
    'Get-Content a &&', 'Get-Content a || evil', 'Get-Content a < input', 'Get-Content @options', 'where -FilterScript script',
    'C:\\untrusted\\cat.exe README.md', '/tmp/cat README.md',
    'cat \\\\server\\share\\file', 'cat //server/share/file',
    'g"it" status', 'psql -c "SELECT * FROM users"',
    'psql -c "SELECT dangerous_function()"',
    'git show "unterminated', 'cat file\x00; evil',
  ];
  for (const command of commands) assert.equal(isReadOnlyCommand(command), false, command);
});

test('Claude classifies tool operations without scanning paths or search text', () => {
  for (const [name, input] of [
    ['Read', { file_path: 'command-handler.js' }],
    ['Grep', { pattern: 'write|delete|network', path: '.' }],
    ['Glob', { pattern: '**/remove*.js' }],
    ['Bash', { command: 'cat README.md | head -n 20' }],
    ['PowerShell', { command: 'Get-ChildItem | Select-Object Name' }],
  ]) assert.equal(isReadOnlyTool(name, input), true, name);
  for (const [name, input] of [
    ['Edit', { file_path: 'read.md' }],
    ['Write', { file_path: 'read.md' }],
    ['Bash', { command: 'cat x; rm y' }],
    ['Bash', { command: 'cat x', dangerouslyDisableSandbox: true }],
    ['mcp__custom__Read', {}], ['AskUserQuestion', {}],
  ]) assert.equal(isReadOnlyTool(name, input), false, name);
});

test('permission grants use structured access fields, including current entries', () => {
  const request = permissions => ({ params: { reason: 'read write command documentation', permissions } });
  assert.equal(isReadOnlyPermissionRequest(request({ fileSystem: { read: ['write/network.txt'], write: null }, network: { enabled: false } })), true);
  assert.equal(isReadOnlyPermissionRequest(request({ fileSystem: { entries: [{ access: 'read', path: { type: 'path', path: '/docs/remove.md' } }] } })), true);
  assert.equal(isReadOnlyPermissionRequest({ params: { additionalPermissions: { fileSystem: { read: ['report.xlsx'] } } } }), true);
  for (const permissions of [
    { fileSystem: { read: ['x'], write: ['y'] } },
    { fileSystem: { read: ['x'] }, network: { enabled: true } },
    { fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/readme' } }] } },
    { fileSystem: { read: ['x'], fullAccess: true } },
    { fileSystem: { read: ['x'] }, execute: true },
    {}, { fileSystem: { read: 'x' } },
  ]) assert.equal(isReadOnlyPermissionRequest(request(permissions)), false);
  assert.equal(isReadOnlyPermissionRequest({ params: { reason: 'please read report.xlsx' } }), false);
});

test('read commands do not automatically approve stdin, network or extra write grants', () => {
  const request = extra => ({ params: { command: 'Get-Content README.md', ...extra } });
  assert.equal(isReadOnlyCommandRequest(request({})), true);
  assert.equal(isReadOnlyCommandRequest(request({ kind: 'stdin' })), false);
  assert.equal(isReadOnlyCommandRequest(request({ networkApprovalContext: { host: 'example.com' } })), false);
  assert.equal(isReadOnlyCommandRequest(request({ additionalPermissions: { fileSystem: { write: ['x'] } } })), false);
  assert.equal(isReadOnlyCommandRequest(request({ additionalPermissions: { fileSystem: { read: ['x'] } } })), true);
});
