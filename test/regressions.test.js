import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Agent } from '../agent.js';
import { MemoryStore } from '../memory.js';
import { SessionStore } from '../sessions.js';

test('disabled tools cannot be invoked outside the model tool list', async () => {
  const agent = new Agent({
    baseUrl: 'http://localhost:1234/v1',
    enabledTools: ['read'],
  });

  assert.equal(
    await agent._executeTool('exec', { command: 'touch /tmp/ismini-disabled-tool-test' }),
    'Tool is disabled: exec',
  );
});

test('tool calls without provider IDs keep matching IDs in history and results', async () => {
  const ui = {
    showWarning() {},
    showError() {},
    showModelMessage() {},
    showToolOutput() {},
    _c(_color, text) { return text; },
  };
  const agent = new Agent({
    baseUrl: 'http://localhost:1234/v1',
    enabledTools: ['read'],
    ui,
  });
  let responseCount = 0;
  agent._callLM = async () => {
    responseCount++;
    return responseCount === 1
      ? { choices: [{ message: { tool_calls: [{ function: { name: 'read', arguments: '{}' } }] } }] }
      : { choices: [{ message: { content: 'done' } }] };
  };
  agent._executeTool = async () => 'read result';

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await agent.run('read something');
  } finally {
    process.stdout.write = originalWrite;
  }

  const assistant = agent.messages.find((message) => message.role === 'assistant' && message.tool_calls);
  const toolResult = agent.messages.find((message) => message.role === 'tool');
  assert.ok(assistant.tool_calls[0].id);
  assert.equal(toolResult.tool_call_id, assistant.tool_calls[0].id);
});

test('corrupt session JSON is reported without replacing the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-sessions-'));
  const file = join(dir, 'sessions.json');
  try {
    for (const original of ['{not valid JSON', '{"activeId":null}']) {
      writeFileSync(file, original);
      assert.throws(() => new SessionStore(dir), /Could not load sessions/);
      assert.equal(readFileSync(file, 'utf8'), original);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid sessions still restore and save normally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-sessions-'));
  try {
    const store = new SessionStore(dir);
    const session = store.create();
    store.saveActive([{ role: 'user', content: 'hello' }]);
    assert.deepEqual(new SessionStore(dir).getActive().messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(session.id, store.getActive().id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid memory records are reported without replacing the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-memory-'));
  const file = join(dir, 'memory.json');
  const original = JSON.stringify({ memories: [{ id: 'broken' }] });
  try {
    writeFileSync(file, original);
    assert.throws(() => new MemoryStore(dir), /Could not load memory/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid memories still persist and support search and deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-memory-'));
  try {
    const store = new MemoryStore(dir);
    const memory = store.add('Prefers concise answers', 'preference');
    assert.equal(new MemoryStore(dir).search('concise')[0].id, memory.id);
    assert.equal(store.delete(memory.id), true);
    assert.equal(store.search('concise').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstalling from the source folder removes only the installed app', () => {
  const home = mkdtempSync(join(tmpdir(), 'ismini-uninstall-'));
  const fakeBin = join(home, 'bin');
  const app = join(home, 'ismini');
  const source = resolve('uninstall.sh');
  mkdirSync(fakeBin);
  mkdirSync(app);
  writeFileSync(join(app, 'sentinel'), 'installed app');

  const safeRm = `#!/bin/sh
for arg do
  case "$arg" in
    -*) ;;
    "$TEST_HOME"/*) ;;
    *) exit 0 ;;
  esac
done
exec /bin/rm "$@"
`;
  writeFileSync(join(fakeBin, 'rm'), safeRm, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(fakeBin, 'update-desktop-database'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  try {
    const result = spawnSync('bash', [source], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        TEST_HOME: home,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(app), false);
    assert.equal(existsSync(source), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
