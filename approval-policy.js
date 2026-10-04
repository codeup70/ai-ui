// Classify only static, understood reads. Unknown commands remain interactive.
// This parser never runs a command. It deliberately rejects shell expansion,
// scripts, redirects and ambiguous syntax rather than guessing from filenames.
// Legacy modes remain valid for saved preferences, without increasing access.
export const approvalModes = new Set(['ask', 'auto-accept', 'auto-decline', 'default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
export const codexApprovalModes = new Set(['ask', 'auto-accept', 'auto-decline', 'workspace-auto', 'default', 'acceptEdits', 'bypassPermissions']);

function tokenize(command) {
  const tokens = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (';|\n&'.includes(ch)) {
      const op = (ch === '&' || ch === '|') && command[i + 1] === ch ? ch + command[++i] : ch;
      tokens.push({ op }); i++; continue;
    }
    let value = '', quoted = false;
    if (ch === '"' || ch === "'") {
      quoted = true;
      const quote = ch; i++;
      while (i < command.length && command[i] !== quote) {
        // No interpolation or escaping: their meaning differs across shells.
        if (command[i] === '\x60' || (quote === '"' && /[$\\]/.test(command[i]) && (
          command[i] === '$' || /["$\\\x60]/.test(command[i + 1] || '')
        ))) return null;
        value += command[i++];
      }
      if (command[i++] !== quote) return null;
      if (i < command.length && !/[\s;|&]/.test(command[i])) return null;
    } else {
      while (i < command.length && !/[\s;|&]/.test(command[i])) {
        if (/["'$@<>\x60(){}#]/.test(command[i])) return null;
        if (command[i] === '\\' && /[\s"'$<>\x60;|&\\]/.test(command[i + 1] || '')) return null;
        value += command[i++];
      }
    }
    if (!value && !quoted) return null;
    tokens.push({ value, quoted });
  }
  return tokens;
}

function commandName(value) {
  const name = value.toLowerCase();
  if (!/[\\/]/.test(name)) return name.replace(/\.exe$/, '');
  // Do not treat an arbitrary program named "cat" or "powershell" as trusted.
  if (/^\/(?:usr\/)?bin\/[a-z0-9-]+$/.test(name)) return name.split('/').at(-1);
  if (/^[a-z]:[\\/]windows[\\/]system32[\\/]windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/.test(name)) return 'powershell';
  if (/^[a-z]:[\\/]program files[\\/]powershell[\\/]7[\\/]pwsh\.exe$/.test(name)) return 'pwsh';
  return '';
}

const psOptions = {
  'get-content': 'path literalpath totalcount head tail raw encoding delimiter readcount wait stream',
  'get-childitem': 'path literalpath filter include exclude recurse depth force name file directory hidden attributes',
  'get-item': 'path literalpath filter include exclude force stream',
  'test-path': 'path literalpath pathtype isvalid',
  'get-location': 'psprovider psdrive',
  'resolve-path': 'path literalpath relative',
  'select-object': 'property excludeproperty expandproperty first last skip skiplast unique',
  'select-string': 'path literalpath pattern simplematch casesensitive allmatches context list quiet notmatch encoding',
  'measure-object': 'property allstats sum average minimum maximum standarddeviation line word character ignorespace',
  'sort-object': 'property descending ascending unique casesensitive stable top bottom',
  'get-filehash': 'path literalpath algorithm',
  'convertfrom-json': 'ashashtable depth',
  'convertto-json': 'depth compress enumsasstrings asarray escapehandling',
  'format-table': 'property autosize hideTableHeaders wrap'.toLowerCase(),
  'format-list': 'property',
  'out-string': 'stream width',
};
function simpleRead(name, args) {
  if (Object.hasOwn(psOptions, name)) {
    const flags = new Set((psOptions[name] + ' erroraction warningaction verbose debug').split(' '));
    return args.every(arg => !arg.startsWith('-') || /^-\d+$/.test(arg) || flags.has(arg.slice(1).toLowerCase()));
  }
  if (name === 'rg') return !args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/i.test(arg));
  if (name === 'git') {
    let i = 0;
    while (i < args.length) {
      if (['--no-pager', '--no-optional-locks', '--literal-pathspecs'].includes(args[i])) { i++; continue; }
      if (args[i] === '-C' && args[i + 1]) { i += 2; continue; }
      if (args[i] === '-c' && /^safe\.directory=.+$/.test(args[i + 1] || '')) { i += 2; continue; }
      break;
    }
    const sub = args[i++], rest = args.slice(i);
    if (['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'].includes(sub)) {
      return !rest.some(arg => /^--(?:output|ext-diff|textconv|exec|open-files-in-pager)(?:=|$)/.test(arg));
    }
    if (sub === 'branch') return rest.every(arg => ['-a', '-r', '--all', '--remotes', '--list', '--show-current'].includes(arg));
    if (sub === 'remote') return rest.length === 1 && ['-v', '--verbose'].includes(rest[0]);
    return false;
  }
  return ['cat', 'type', 'head', 'tail', 'ls', 'dir', 'pwd', 'whoami', 'grep', 'wc', 'which'].includes(name);
}

function readSegment(tokens, depth) {
  if (!tokens.length || depth > 4) return false;
  const invocation = tokens[0].op === '&';
  if (invocation) tokens = tokens.slice(1);
  if (!tokens.length || tokens.some(t => t.op)) return false;
  const name = commandName(tokens[0].value);
  const args = tokens.slice(1).map(t => t.value);
  // Network paths and interpolation are not silently granted as local reads.
  if (args.some(arg => /^\\\\|^\/\//.test(arg))) return false;
  if (['powershell', 'pwsh', 'bash', 'sh', 'zsh'].includes(name)) {
    let i = 0;
    const ps = name === 'powershell' || name === 'pwsh';
    if (ps) while (['-noprofile', '-noninteractive', '-nologo'].includes(args[i]?.toLowerCase())) i++;
    if (!(ps ? ['-command', '-c'] : ['-c', '-lc']).includes(args[i]?.toLowerCase())) return false;
    const script = tokens.slice(i + 2);
    if (script.length !== 1) return false;
    return isReadOnlyCommand(script[0].value, depth + 1);
  }
  if (invocation) return false;
  return simpleRead(name, args);
}

export function isReadOnlyCommand(command, depth = 0) {
  if (typeof command !== 'string' || !command.trim() || command.length > 20000 || /[\0]/.test(command)) return false;
  const tokens = tokenize(command);
  if (!tokens?.length) return false;
  let segment = [], lastOp = null;
  for (const token of tokens) {
    if (!token.op || token.op === '&' && segment.length === 0 && lastOp === null) {
      segment.push(token); continue;
    }
    if (![';', '\n', '|', '&&', '||'].includes(token.op)) return false;
    if (!segment.length) {
      if (token.op === '\n' && (lastOp === '\n' || lastOp === ';' || lastOp === null)) continue;
      return false;
    }
    if (!readSegment(segment, depth)) return false;
    segment = []; lastOp = token.op;
  }
  return segment.length ? readSegment(segment, depth) : lastOp === ';' || lastOp === '\n';
}

export function isReadOnlyTool(name, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (['Read', 'Glob', 'Grep', 'LS'].includes(name)) return true;
  if (['Bash', 'PowerShell'].includes(name) && !input.dangerouslyDisableSandbox) return isReadOnlyCommand(input.command);
  return false;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export function isReadOnlyPermissionRequest(request = {}) {
  const permissions = request.params?.permissions ?? request.params?.additionalPermissions;
  if (!onlyKeys(permissions, ['fileSystem', 'network'])) return false;
  const network = permissions.network;
  if (network != null && (!onlyKeys(network, ['enabled']) || network.enabled != null && network.enabled !== false)) return false;
  const files = permissions.fileSystem;
  if (!onlyKeys(files, ['read', 'write', 'entries', 'globScanMaxDepth'])) return false;
  if (files.write != null && (!Array.isArray(files.write) || files.write.length)) return false;
  if (files.read != null && (!Array.isArray(files.read) || !files.read.every(p => typeof p === 'string' && p.length))) return false;
  if (files.entries != null && (!Array.isArray(files.entries) || !files.entries.every(entry =>
    onlyKeys(entry, ['access', 'path']) && entry.access === 'read' && object(entry.path)
  ))) return false;
  return Boolean(files.read?.length || files.entries?.length);
}

export function isReadOnlyCommandRequest(request = {}) {
  const params = request.params || {};
  if (params.kind != null && params.kind !== 'command' || params.networkApprovalContext != null) return false;
  if (params.additionalPermissions != null && !isReadOnlyPermissionRequest({ params: { permissions: params.additionalPermissions } })) return false;
  return isReadOnlyCommand(params.command);
}
