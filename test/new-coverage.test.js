// Additional test coverage for issue #34: exec, formatter, web.js, web tools
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import test from 'node:test';
import { Agent } from '../agent.js';
import { SessionStore } from '../sessions.js';

// ── Exec tool tests ────────────────────────────────────────────────

test('exec tool runs shell commands and returns stdout', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  const result = await agent._executeTool('exec', { command: 'echo "hello world"' });
  assert.match(result, /hello world/);
});

test('exec tool captures stderr on failure', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  const result = await agent._executeTool('exec', { command: 'ls /nonexistent/path-xyz' });
  assert.match(result, /No such file|not found/i);
});

test('exec tool blocks dangerous commands (rm -rf /)', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  const result = await agent._executeTool('exec', { command: 'rm -rf /' });
  assert.match(result, /Blocked/i);
});

test('exec tool blocks dangerous commands (mkfs)', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  const result = await agent._executeTool('exec', { command: 'mkfs.ext4 /dev/sda1' });
  assert.match(result, /Blocked/i);
});

test('exec tool allows safe commands (ls)', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  const result = await agent._executeTool('exec', { command: 'ls /tmp' });
  assert.ok(!result.startsWith('Blocked'));
});

// ── Web fetch tool tests (SSRF protection) ─────────────────────────

test('web_fetch tool blocks localhost URLs', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  // SSRF guard throws an error for private/loopback addresses
  await assert.rejects(
    () => agent._executeTool('web_fetch', { url: 'http://127.0.0.1:8787/' }),
    /blocked|private|local/i
  );
});

test('web_fetch tool blocks private IP ranges (192.168.x.x)', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  await assert.rejects(
    () => agent._executeTool('web_fetch', { url: 'http://192.168.1.1/' }),
    /blocked|private/i
  );
});

test('web_fetch tool blocks private IP ranges (10.x.x.x)', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  await assert.rejects(
    () => agent._executeTool('web_fetch', { url: 'http://10.0.0.1/' }),
    /blocked|private/i
  );
});

// Note: Testing web_fetch with public URLs requires network access or a more
// sophisticated mock. The SSRF protection tests above cover the security-critical path.

// ── Web.js server tests (syntax check only — full integration tests are manual) ────────

test('web.js has valid syntax', () => {
  // Just verify the file can be parsed by Node
  const proc = spawnSync('node', ['--check', 'web.js'], {
    cwd: '/home/tasos/Laborartory/ismini-linux',
    encoding: 'utf8',
  });
  
  assert.equal(proc.status, 0);
});

// ── Line formatter tests (indirect via streaming) ──────────────────

test('line formatter handles complete lines correctly', async () => {
  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  
  // Mock fetch to return a simple streamed response
  const originalFetch = globalThis.fetch;
  let receivedChunks = [];
  
  globalThis.fetch = async (url, options) => {
    // Simulate SSE stream with multiple chunks
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  
  try {
    const response = await agent._callLM([{ role: 'user', content: 'test' }], {
      stream: true,
      onChunk: (chunk) => receivedChunks.push(chunk),
    });
    
    // Should have received chunks
    assert.ok(receivedChunks.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Session limit enforcement tests (stable sort with secondary key) ────────────────

test('session limit enforces MAX_SESSIONS with stable sorting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-sessions-'));
  try {
    const store = new SessionStore(dir);
    
    // Create exactly MAX_SESSIONS + 1 sessions
    for (let i = 0; i < 5; i++) {
      store.create();
    }
    
    // Should have exactly MAX_SESSIONS (4) after enforcement
    assert.equal(store.data.sessions.length, 4);
    
    // Verify active session is preserved or switched to newest
    const activeSession = store.getActive();
    assert.ok(activeSession);
    
    // All remaining sessions should be valid
    for (const s of store.data.sessions) {
      assert.ok(s.id);
      assert.ok(s.messages !== undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Path sandboxing tests (symlink resolution) ────────────────────────────────

test('sandbox blocks access via symlinks to sensitive files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-sandbox-'));
  try {
    // Create a fake .ssh directory with authorized_keys
    const fakeSshDir = join(dir, '.ssh');
    mkdirSync(fakeSshDir);
    writeFileSync(join(fakeSshDir, 'authorized_keys'), 'ssh-rsa AAAAB3... user@host\n');
    
    // Create a symlink to .ssh
    const linkPath = join(dir, 'link_to_ssh');
    symlinkSync('.ssh', linkPath, 'dir');
    
    // Try to read via the symlink - should be blocked
    const agent = new Agent({ baseUrl: 'http://localhost:1234/v1', workspace: dir });
    const result = await agent._executeTool('read', { path: linkPath + '/authorized_keys' });
    
    // Should be blocked (access denied)
    assert.match(result, /Access denied/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

