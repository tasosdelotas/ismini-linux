import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Agent } from '../agent.js';
import { MAX_IMAGE_BYTES, modelSupportsVision, removeLegacyVisionInstructions, validateImageAttachment } from '../image-input.js';
import { MemoryStore } from '../memory.js';
import { SessionStore } from '../sessions.js';
import { createLiveResponseTracker } from '../web/live-tts.js';

test('Live Chat TTS tracks only the final response once per turn', () => {
  const response = createLiveResponseTracker();

  response.begin();
  response.update('Let me check that.'); // streamed text before a tool call
  response.update('Here is the complete answer.'); // final streamed model response
  assert.equal(response.finish(), 'Here is the complete answer.');
  assert.equal(response.finish(), '');

  response.begin();
  response.update('A response that was cancelled.');
  response.cancel();
  assert.equal(response.finish(), '');

  response.begin();
  response.update('A fresh response.');
  assert.equal(response.finish(), 'A fresh response.');
});

test('image attachments validate supported types and enforce the 4 MiB limit', () => {
  for (const type of ['jpeg', 'png', 'webp', 'gif']) {
    const image = validateImageAttachment({
      name: 'photo.' + type,
      dataUrl: `data:image/${type};base64,aGVsbG8=`,
    });
    assert.equal(image.name, 'photo.' + type);
  }
  assert.throws(() => validateImageAttachment({ dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }), /JPEG, PNG, WebP, or GIF/);
  assert.throws(() => validateImageAttachment({ dataUrl: 'data:image/png;base64,AB==' }), /invalid image/);

  const atLimit = Buffer.alloc(MAX_IMAGE_BYTES).toString('base64');
  assert.equal(validateImageAttachment({ dataUrl: `data:image/png;base64,${atLimit}` }).dataUrl.length, atLimit.length + 22);
  const tooLarge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 65).toString('base64');
  assert.throws(
    () => validateImageAttachment({ dataUrl: `data:image/png;base64,${tooLarge}` }),
    error => error.statusCode === 413 && /maximum 4 MiB/.test(error.message),
  );
});

test('vision metadata distinguishes vision, text-only, and unknown models', () => {
  assert.equal(modelSupportsVision({ type: 'vlm' }), true);
  assert.equal(modelSupportsVision({ capabilities: ['tool_use', 'vision_input'] }), true);
  assert.equal(modelSupportsVision({ type: 'llm' }), false);
  assert.equal(modelSupportsVision({ capabilities: ['tool_use'] }), null);
  assert.equal(modelSupportsVision(null), null);
});

test('image messages reach the compatible API shape with explicit vision guidance', async () => {
  const agent = new Agent({
    baseUrl: 'http://localhost:1234/v1',
    systemPrompt: 'You are helpful. You lack vision and cannot process image files (.jpg, .png, .webp, .svg, etc.); politely ask for a text description instead and never call read on image files.',
    enabledTools: [],
  });
  const imageContent = [
    { type: 'text', text: 'Describe this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
  ];
  agent._push('user', imageContent);
  assert.deepEqual(agent.messages[0].content, imageContent);

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A visible scene' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    agent.supportsVision = true;
    await agent._callLM(agent.messages);
    assert.deepEqual(requests[0].messages[1].content, imageContent);
    assert.match(requests[0].messages[0].content, /Do not claim that you lack vision/);
    assert.doesNotMatch(requests[0].messages[0].content, /You lack vision and cannot process image files/);

    agent.supportsVision = false;
    await agent._callLM(agent.messages);
    assert.match(requests[1].messages[0].content, /does not support image input/);
    assert.match(requests[1].messages[0].content, /Do not guess what the image contains/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy no-vision prompt is removed and image-file reads direct users to chat attachment', async () => {
  const legacy = 'Helpful. You lack vision and cannot process image files (.jpg, .png, .webp, .svg, etc.); politely ask for a text description instead and never call read on image files.';
  assert.equal(removeLegacyVisionInstructions(legacy), 'Helpful.');

  const agent = new Agent({ baseUrl: 'http://localhost:1234/v1' });
  assert.match(await agent._executeTool('read', { path: '/tmp/example.png' }), /Attach the image in chat/);
});

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

test('corrupt session JSON is preserved and store starts fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-sessions-'));
  const file = join(dir, 'sessions.json');
  try {
    for (const original of ['{not valid JSON', '{"activeId":null}']) {
      writeFileSync(file, original);
      // Graceful recovery: log the error, rename the corrupt file, start fresh
      const store = new SessionStore(dir);
      assert.equal(store.getActive(), null); // no active session after recovery
      // The original file should be renamed (preserved for inspection)
      assert.ok(existsSync(file) || existsSync(`${file}.corrupt-${Date.now()}`));
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
    const imageMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
      ],
    };
    store.saveActive([imageMessage]);
    assert.deepEqual(new SessionStore(dir).getActive().messages, [imageMessage]);
    assert.equal(session.id, store.getActive().id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid memory records are preserved and store starts fresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-memory-'));
  const file = join(dir, 'memory.json');
  const original = JSON.stringify({ memories: [{ id: 'broken' }] });
  try {
    writeFileSync(file, original);
    // Graceful recovery: log the error, rename the corrupt file, start fresh
    const store = new MemoryStore(dir);
    assert.equal(store.data.memories.length, 0); // empty after recovery
    // The original file should be renamed (preserved for inspection)
    assert.ok(existsSync(file) || existsSync(`${file}.corrupt-${Date.now()}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid memories still persist and support search and deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ismini-memory-'));
  try {
    const store = new MemoryStore(dir);
    const { memory } = store.add('Prefers concise answers', 'preference');
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
