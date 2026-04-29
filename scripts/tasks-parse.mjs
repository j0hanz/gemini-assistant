// Pure parsers for ESLint JSON, tsc --pretty false, and Node TAP output.

export function parseEslintJson(jsonStr, cwd) {
  const results = JSON.parse(jsonStr);
  const errors = [];
  for (const file of results) {
    if (!file.messages?.length) continue;
    const rel = file.filePath?.startsWith(cwd)
      ? file.filePath.slice(cwd.length + 1).replace(/\\/g, '/')
      : (file.filePath ?? '').replace(/\\/g, '/');
    for (const msg of file.messages) {
      errors.push({
        file: rel,
        line: msg.line ?? 1,
        col: msg.column ?? 1,
        endCol: msg.endColumn ?? (msg.column ?? 1) + 3,
        rule: msg.ruleId ?? 'unknown',
        severity: msg.severity === 1 ? 'warning' : 'error',
        message: msg.message,
      });
    }
  }
  return errors;
}

const TSC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;

export function parseTscOutput(text) {
  const errors = [];
  for (const line of text.split('\n')) {
    const m = line.match(TSC_RE);
    if (!m) continue;
    errors.push({
      file: m[1].replace(/\\/g, '/'),
      line: Number(m[2]),
      col: Number(m[3]),
      endCol: Number(m[3]) + 3,
      rule: m[5],
      severity: m[4],
      message: m[6],
    });
  }
  return errors;
}

export function parseTapLine(line) {
  const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length;
  const ok = /^\s*ok \d+ - (.+?)(?:\s+#\s+time=(\S+))?$/.exec(line);
  if (ok)
    return {
      type: 'ok',
      depth: indent,
      name: ok[1].trim(),
      duration: ok[2] ? parseFloat(ok[2]) : 0,
    };
  const notOk = /^\s*not ok \d+ - (.+)$/.exec(line);
  if (notOk) return { type: 'not_ok', depth: indent, name: notOk[1].trim() };
  if (/^\s+---\s*$/.test(line)) return { type: 'yaml_start' };
  if (/^\s+\.\.\.\s*$/.test(line)) return { type: 'yaml_end' };
  return { type: 'raw', line };
}

export function parseYamlBlock(lines) {
  const result = {};
  let multiKey = null;
  const multiLines = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (multiKey) {
      if (/^\w+:/.test(trimmed)) {
        result[multiKey] = multiLines.join('\n').trim();
        multiKey = null;
        multiLines.length = 0;
      } else {
        multiLines.push(trimmed);
        continue;
      }
    }
    const kv = /^(\w+):\s*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '|-' || val === '|') {
      multiKey = key;
      multiLines.length = 0;
    } else {
      result[key] = val.replace(/^'|'$/g, '');
    }
  }
  if (multiKey) result[multiKey] = multiLines.join('\n').trim();
  if (!result.at && result.stack) {
    const m = result.stack.match(/at .+? \(([^)]+:\d+:\d+)\)/);
    if (m && !m[1].startsWith('node:')) result.at = m[1];
  }
  return result;
}
