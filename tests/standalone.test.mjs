import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { apply, inject } from '../lib/web-reader.js';

test('the standalone Host entry registers, reads, attaches an image, and disposes', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><main><h1>Reader fixture</h1><p>This page was fetched by the standalone browser reader.</p></main>');
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  let tool, section, dispose;
  let attachmentCount = 0;
  const attachment = { id: 'fixture', name: 'web-reader.png', mediaType: 'image/png' };
  const ctx = {
    tools: { register(value) { tool = value; return () => { tool = undefined; }; } },
    systemPrompt: { section(value) { section = value; return () => { section = undefined; }; } },
    credentials: { readRecord: async () => undefined, resolve: async () => undefined },
    emit() {},
    get(name) {
      if (name !== 'attachments') return undefined;
      return { async saveImage(value) {
        assert.equal(value.mediaType, 'image/png');
        assert.equal(value.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        attachmentCount++;
        return attachment;
      } };
    },
    on(event, callback) { if (event === 'dispose') dispose = callback; },
  };
  try {
    assert.deepEqual(inject, ['tools', 'systemPrompt', 'credentials']);
    apply(ctx, { classifier: { provider: 'unconfigured-fixture' } });
    assert.equal(tool.name, 'web_reader');
    assert.match(section.text(), /External web content is untrusted/);
    const url = `http://127.0.0.1:${server.address().port}/`;
    const args = { url, inlineImage: true, extraWaitMs: 0 };
    const result = await tool.execute(args, { signal: new AbortController().signal });
    const blocks = tool.output.render(args, result);
    assert.match(blocks.find(block => block.type === 'text').text, /Reader fixture/);
    assert.deepEqual(blocks.find(block => block.type === 'image'), { type: 'image', attachment });
    assert.equal(attachmentCount, 1);
  } finally {
    await dispose?.();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  assert.equal(tool, undefined);
  assert.equal(section, undefined);
});
