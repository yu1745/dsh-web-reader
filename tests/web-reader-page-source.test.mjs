import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import { waitForReadableContent } from '../src/vendor/web-reader/readiness.ts';
import { gateSignal } from '../src/vendor/web-reader/signals.ts';

// Transform only in memory: verify the keepNames configuration that injects __name,
// without touching lib or running the repository build.
const sourceURL = new URL('../src/vendor/web-reader/page.ts', import.meta.url);
const source = (await readFile(sourceURL, 'utf8')).replace("'./signals.ts'", JSON.stringify(new URL('../src/vendor/web-reader/signals.ts', import.meta.url).href));
const { code } = await transform(source, { loader: 'ts', format: 'esm', keepNames: true });
const { SAMPLE_SCRIPT, DISMISS_CONSENT_SCRIPT, CLEAN_CONSENT_SCRIPT } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function mechanical(sample, jev) {
  let clock = 0;
  return waitForReadableContent({
    evaluate: async expression => expression === SAMPLE_SCRIPT ? sample : false,
    waitForTimeout: async ms => { clock += ms; },
    screenshot: async () => new Uint8Array(2000),
  }, 'https://example.test', jev, undefined, () => clock);
}

test('source scripts survive keepNames serialization in Chromium, with semantic fallback classifications', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const fixtures = [
      ['short prose', '<p>Hello world.</p>', 'content'],
      ['bare short prose', 'Hello world.', 'content'],
      ['leaf div and span prose', `<div><span>${'A substantive quotation without semantic paragraph elements. '.repeat(3)}</span></div><div>${'Another quotation that explains a complete idea in plain text. '.repeat(2)}</div>`, 'content'],
      ['blockquote and definition prose', `<blockquote>${'A substantial quotation in a standalone blockquote. '.repeat(3)}</blockquote><dl><dd>${'A definition with enough explanatory detail to be requested content. '.repeat(2)}</dd></dl>`, 'content'],
      ['leaf menu excluded', `<nav><div>${'A long menu description. '.repeat(10)}</div></nav>`, undefined],
      ['leaf form excluded', `<form><div>${'A long form description. '.repeat(10)}</div></form>`, undefined],
      ['short leaf menu pieces excluded', `<div>${Array.from({length:20}, (_,i)=>`<span>Menu item ${i}</span>`).join('')}</div>`, undefined],
      ['linked title cards', `<main>${Array.from({length:7},(_,i)=>`<div><h3><a href="/video/${i}">A substantive video title ${i}</a></h3></div>`).join('')}</main>`, 'content'],
      ['navigation title cards excluded', `<main><nav>${Array.from({length:7},(_,i)=>`<h3><a href="/menu/${i}">A substantive menu title ${i}</a></h3>`).join('')}</nav></main>`, undefined],
      ['offscreen skeleton ignored', '<main><p>Readable article.</p><div class=skeleton style="position:absolute;top:5000px;width:600px;height:400px"></div></main>', 'content'],
      ['onscreen skeleton still waits', '<main><p>Readable article.</p><div class=skeleton style="width:100px;height:20px"></div></main>', undefined],
      ['dominant skeleton waits', '<main><p>Partial article.</p><div class=skeleton style="width:1000px;height:500px"></div></main>', undefined],
      ['empty primary skeleton waits', '<main><div class=skeleton style="width:300px;height:30px"></div></main>', undefined],
      ['offscreen busy ignored', '<main><p>Readable article.</p><div aria-busy=true style="position:absolute;top:5000px;width:600px;height:400px"></div></main>', 'content'],
      ['onscreen busy still waits', '<main><p>Readable article.</p><div aria-busy=true style="width:100px;height:20px"></div></main>', undefined],
      ['bare loading', '请稍候', undefined],
      ['JSON', '<pre>{"ok":true}</pre>', 'content'],
      ['short data table', '<table><tr><td>A</td><td>B</td></tr></table>', 'content'],
      ['short linked data table', '<table><tr><td><a href="/a">A</a></td><td><a href="/b">B</a></td></tr></table>', 'content'],
      ['hidden data table', '<table hidden><tr><td>A</td></tr></table>', undefined],
      ['hidden data cells', '<table><tr><td style="display:none">A</td><td hidden>B</td></tr></table>', undefined],
      ['navigation data table', '<nav><table><tr><td>A</td><td>B</td></tr></table></nav>', undefined],
      ['role navigation data table', '<div role="navigation"><table><tr><td>A</td></tr></table></div>', undefined],
      ['header only table', '<table><tr><th>A</th><th>B</th></tr></table>', undefined],
      ['empty data table', '<table><tr><td> </td></tr></table>', undefined],
      ['error', '<h1>404 Not Found</h1>', 'error_page'],
      ['error paragraph', '<p>Service unavailable</p>', 'error_page'],
      ['login form', '<main><h1>Sign in</h1><input type=password><button>Sign in</button></main>', 'login_wall'],
      ['bot', '<p>Checking your browser</p>', 'bot_check'],
      ['Google Chinese traffic wall', `<main><p>我们的系统检测到您的计算机网络中存在异常流量。</p><p>${'此网页用于确认这些请求来自您，而不是自动程序。'.repeat(12)}</p></main>`, 'bot_check'],
      ['Reddit network security', `<main><p>You've been blocked by network security.</p><p>${'To continue, log in to your Reddit account or use your developer token. '.repeat(5)}</p></main>`, 'bot_check'],
      ['Zhihu SMS login', '<main><h1>登录/注册知乎</h1><input placeholder="手机号"><input placeholder="输入6位短信验证码"><button>获取短信验证码</button><p>其他方式登录</p><p>未注册手机验证后自动登录，注册即代表同意用户协议和隐私保护指引。</p></main>', 'login_wall'],
      ['age gate', '<p>Please confirm your age</p>', 'content_gate'],
      ['loading', '<p>Loading...</p>', undefined],
      ['Chinese loading', '<main><p>请稍候</p><div aria-busy=true></div></main>', undefined],
      ['navigation', '<nav><p>A long navigation description without requested content.</p></nav>', undefined],
      ['hidden prose', '<p style="display:none">Hidden content</p>', undefined],
      ['consent', '<div class=cookie-banner>We use cookies <button>Accept</button></div>', 'consent_wall'],
      ['article discussing CAPTCHA', `<article><p>${'This article explains how CAPTCHA and access denied messages work. '.repeat(12)}</p></article>`, 'content'],
      ['shadow prose', '<div id=host></div>', 'content'],
    ];
    for (const [name, html, kind] of fixtures) await t.test(name, async () => {
      await page.setContent(html);
      if (name === 'shadow prose') await page.evaluate("document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<p>Short shadow article.</p>'");
      assert.equal(await page.evaluate(DISMISS_CONSENT_SCRIPT), false);
      const sample = await page.evaluate(SAMPLE_SCRIPT);
      const verdict = await mechanical(sample);
      assert.equal(verdict.pageKind, kind, JSON.stringify({ sample, verdict }));
      assert.equal(verdict.incomplete, kind === undefined);
      await page.evaluate(CLEAN_CONSENT_SCRIPT);
    });
    await page.setContent('<p>Readable short article.</p>');
    const sample = await page.evaluate(SAMPLE_SCRIPT);
    const verdict = await mechanical(sample, { evaluate: async () => { throw new Error('classifier unavailable'); } });
    assert.equal(verdict.pageKind, 'content');
    assert.equal(verdict.fallback, true);
    assert.equal(verdict.visualVerdicts, 1);
  } finally { await browser.close(); }
});

test('generic loading and article terminology do not independently imply bot verification', () => {
  assert.equal(gateSignal('请稍候'), undefined);
  assert.equal(gateSignal('正在验证数据格式'), undefined);
  assert.equal(gateSignal('How CAPTCHA works'), undefined);
  assert.equal(gateSignal('Verify you are human').kind, 'bot_check');
});
