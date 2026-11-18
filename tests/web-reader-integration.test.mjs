import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
let temporary, server, base, tool;
const shutdown = [];
const ctx = { modelRegistry: { findOfType() { return undefined; } } };
const fixture = '<!doctype html><title>Fixture</title><h1>Selected title</h1><p>Outside the chosen heading, readable fixture content.</p>';
const run = (path, params = {}) => tool.execute('test', { url: base + path, extraWaitMs: 0, ...params }, undefined, undefined, ctx);
const text = result => result.content.find(part => part.type === 'text')?.text || '';

before(async () => {
  temporary = await mkdtemp(join(root, '.web-reader-test-'));
  const outfile = join(temporary, 'reader.mjs');
  await build({ entryPoints: [join(root, 'src/vendor/web-reader/index.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'silent' });
  const { default: register } = await import(pathToFileURL(outfile).href);
  register({ on(event, callback) { if (event === 'session_shutdown') shutdown.push(callback); }, registerTool(value) { tool = value; } });
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/slow') { setTimeout(() => { if (!res.destroyed) res.end(fixture); }, 600).unref(); return; }
    if (path === '/redirect') { res.writeHead(302, { location: '/html' }); res.end(); return; }
    if (path === '/pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end('%PDF-1.4\n'); return; }
    if (path === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ title: 'A quoted value', count: 42 })); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (/^\/status\//.test(path)) { res.statusCode = Number(path.split('/')[2]); res.end(); return; }
    if (path === '/frames') { res.end('<title>Frames</title><h1>Parent document</h1><main><iframe src="/frame"></iframe></main><aside><iframe src="/other-frame"></iframe></aside><iframe style="display:none" src="/hidden-frame"></iframe>'); return; }
    if (path === '/frame') { res.end('<p>Visible embedded editor content</p>'); return; }
    if (path === '/other-frame') { res.end('<p>Sidebar embedded content</p>'); return; }
    if (path === '/hidden-frame') { res.end('<p>Hidden embedded secret</p>'); return; }
    if (path === '/table') { res.end('<table><tr><td><table><tr><td colspan="2"><a href="/story">Unique story title</a></td></tr><tr><td>A</td><td>B</td></tr></table></td></tr></table>'); return; }
    if (path === '/delayed') { res.end('<title>Delayed</title><div id="loading">Loading...</div><script>setTimeout(() => { document.querySelector("#loading").remove(); document.body.insertAdjacentHTML("beforeend", "<p id=ready>Delayed body appeared</p>"); }, 500);</script>'); return; }
    if (path === '/shadow') { res.end('<p>Outside shadow content</p><div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML = "<h2>Shadow selected title</h2>";</script>'); return; }
    if (path === '/empty-scope') { res.end('<h1>Outside heading</h1><div id="empty" aria-hidden="true">Private hidden content</div>'); return; }
    res.end(fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const close of shutdown) await close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (temporary) {
    const target = await realpath(temporary);
    assert.equal(target, resolve(temporary));
    assert.ok(target.startsWith(join(root, '.web-reader-test-')));
    await rm(target, { recursive: true, force: true });
  }
});

test('complete tool call falls back when the classifier is unavailable and reads a short page', async () => {
  const result = await run('/html');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.details.incomplete, false);
  assert.equal(result.details.decisionFallback, true);
  assert.match(text(result), /content ready/);
});

test('explicit selector limits HTML, Markdown, text and ARIA to the selected subtree', async () => {
  for (const format of ['html', 'markdown', 'text', 'aria']) {
    const result = await run('/html', { format, selector: 'h1' });
    assert.equal(result.isError, false, text(result));
    const body = text(result).split('\n\n').slice(1).join('\n\n');
    assert.match(body, /Selected title/);
    assert.doesNotMatch(body, /Outside|<!doctype|<body/i);
    if (format === 'html') assert.equal(body, '<h1>Selected title</h1>');
  }
});

test('HTML selectors use the same shadow-piercing locator as accessibility extraction', async () => {
  for (const format of ['html', 'markdown']) {
    const result = await run('/shadow', { selector: 'h2', format });
    assert.equal(result.isError, false, text(result));
    const body = text(result).split('\n\n').slice(1).join('\n\n');
    assert.match(body, /Shadow selected title/);
    assert.doesNotMatch(body, /Outside shadow content/);
    if (format === 'html') assert.equal(body, '<h2>Shadow selected title</h2>');
  }
});

test('missing and invalid selectors fail with the selector and request URL, never unrelated body', async () => {
  for (const selector of ['#missing', '[']) {
    const result = await run('/html', { selector, timeoutMs: 100 });
    assert.equal(result.isError, true);
    assert.match(text(result), /selector/);
    assert.ok(text(result).includes(selector));
    assert.ok(text(result).includes(base + '/html'));
    assert.doesNotMatch(text(result), /Outside the chosen heading/);
  }
});

test('an empty selected accessibility subtree never falls back to unrelated full-page content', async () => {
  const result = await run('/empty-scope', { selector: '#empty' });
  assert.equal(result.isError, false, text(result));
  assert.doesNotMatch(text(result), /Outside heading|Private hidden content/);
});

test('waitSelector failures are explicit and delayed selectors can succeed', async () => {
  const failed = await run('/html', { waitSelector: '#missing', timeoutMs: 100 });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /waitSelector.*#missing/);
  const success = await run('/delayed', { waitSelector: '#ready', timeoutMs: 3000 });
  assert.equal(success.isError, false, text(success));
  assert.match(text(success), /Delayed body appeared/);
});

test('HTTP errors expose status, blocked kind and original URL even with an empty body', async () => {
  for (const status of [401, 403, 404, 500]) {
    const result = await run('/status/' + status);
    assert.equal(result.isError, true);
    assert.equal(result.details.status, status);
    assert.equal(result.details.blocked, 'error_page');
    assert.equal(result.details.incomplete, false);
    assert.ok(text(result).includes(base + '/status/' + status));
  }
});

test('PDF navigation reports unsupported document instead of empty about:blank', async () => {
  const result = await run('/pdf');
  assert.equal(result.isError, true);
  assert.match(text(result), /PDF|document|content type/i);
  assert.ok(text(result).includes(base + '/pdf'));
});

test('unreachable and timed-out navigation fail with diagnostic and requested URL', async () => {
  const result = await tool.execute('test', { url: 'http://127.0.0.1:1/', timeoutMs: 100 }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(text(result), /Navigation failed.*127\.0\.0\.1:1/);
  const slow = await run('/slow', { timeoutMs: 100 });
  assert.equal(slow.isError, true);
  assert.match(text(slow), /Navigation failed.*\/slow/);
});

test('redirects keep both final and requested URL', async () => {
  const result = await run('/redirect');
  assert.equal(result.details.url, base + '/html');
  assert.equal(result.details.requestedUrl, base + '/redirect');
  assert.match(text(result), /Requested URL:/);
});

test('nested table links and span markers appear once in real browser output', async () => {
  const result = await run('/table');
  assert.equal(result.isError, false, text(result));
  assert.equal(text(result).match(/Unique story title/g)?.length, 1);
  assert.match(text(result), /\[Unique story title\]\(\/story\)/);
  assert.match(text(result), /»/);
  const aria = await run('/table', { format: 'aria' });
  assert.match(text(aria), /\[colspan=2\]/);
  assert.doesNotMatch(text(aria), /\[colspan=2\]\s*\[colspan=2\]/);
});

test('JSON escapes are decoded and its extracted text remains parseable', async () => {
  const result = await run('/json', { format: 'text' });
  assert.equal(result.isError, false, text(result));
  const body = text(result).split('\n\n').slice(1).join('\n\n');
  assert.deepEqual(JSON.parse(body), { title: 'A quoted value', count: 42 });
});

test('visible iframe text is extracted; hidden and out-of-scope frames stay excluded', async () => {
  const full = await run('/frames', { autoSelector: false });
  assert.equal(full.isError, false, text(full));
  assert.equal(full.details.incomplete, false);
  assert.match(text(full), /Visible embedded editor content/);
  assert.match(text(full), /Sidebar embedded content/);
  assert.doesNotMatch(text(full), /Hidden embedded secret/);
  const scoped = await run('/frames', { selector: 'main' });
  assert.match(text(scoped), /Visible embedded editor content/);
  assert.doesNotMatch(text(scoped), /Sidebar embedded content|Hidden embedded secret|Parent document/);
});

test('body truncation and screenshots survive the complete tool pipeline', async () => {
  const result = await run('/html', { maxChars: 10, screenshot: true, fullPage: true });
  assert.equal(result.isError, false, text(result));
  assert.equal(result.details.truncated, true);
  const png = await readFile(result.details.screenshotPath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
