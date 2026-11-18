import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporary = await mkdtemp(join(tmpdir(), 'web-reader-render-'));
const bundle = join(temporary, 'render.mjs');
await build({ entryPoints: [new URL('../src/vendor/web-reader/render.ts', import.meta.url).pathname], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
after(() => rm(temporary, { recursive: true, force: true }));
const { parseAria, ariaToMarkdown, ariaToText, renderTable, linkText } = await import(pathToFileURL(bundle).href);

test('paragraphs retain inline links and do not repeat aggregate accessible names', () => {
  const yaml = `- main "Read the guide today":
  - paragraph "Read the guide today":
    - text: Read
    - link "the guide":
      - /url: https://example.com/guide
      - text: the guide
    - text: today`;
  assert.equal(ariaToMarkdown(yaml), 'Read [the guide](https://example.com/guide) today');
  assert.equal(ariaToText(yaml), 'Read the guide today');
});

test('nested layout tables render each inner data table and sibling link once', () => {
  const yaml = `- table "Overview Product Docs":
  - row "Overview Product Docs":
    - cell "Overview Product Docs":
      - paragraph: Overview
      - table:
        - row:
          - columnheader: Product
          - columnheader: Docs
        - row:
          - cell "Widget":
            - link "Widget":
              - /url: https://example.com/widget
          - cell "Read":
            - link "Read":
              - /url: https://example.com/docs
      - link "Contact":
        - /url: https://example.com/contact`;
  const md = ariaToMarkdown(yaml);
  assert.equal((md.match(/Overview/g) || []).length, 1);
  assert.equal((md.match(/\[Widget\]/g) || []).length, 1);
  assert.equal((md.match(/\[Read\]/g) || []).length, 1);
  assert.equal((md.match(/\[Contact\]/g) || []).length, 1);
  assert.match(md, /\| Product \| Docs \|/);
  assert.match(md, /\| \[Widget\]\(https:\/\/example.com\/widget\) \| \[Read\]\(https:\/\/example.com\/docs\) \|/);
});

test('YAML quoted JSON, quoted keys, names, URLs and single quotes are decoded once', () => {
  const json = '{"message":"hello", "path":"C:\\tmp"}';
  const yaml = `- text: ${JSON.stringify(json)}
- ${JSON.stringify('link "Say \\"hello\\""') }:
  - /url: ${JSON.stringify('https://example.com/?q="hello"')}
- text: 'it''s done'
- text: colon:`;
  const root = parseAria(yaml);
  assert.equal(root.children[0].name, json);
  assert.equal(root.children[1].name, 'Say "hello"');
  assert.equal(root.children[1].url, 'https://example.com/?q="hello"');
  assert.equal(root.children[2].name, "it's done");
  assert.equal(root.children[3].name, 'colon:');
  assert.ok(ariaToMarkdown(yaml).includes(json));
});

test('ordinary W3C rowspan and colspan preserve column placement', () => {
  const md = ariaToMarkdown(`- table:
  - row:
    - cell "A" [rowspan=2]:
    - cell "B" [colspan=2]:
  - row:
    - cell: C
    - cell: D`);
  assert.equal(md, '| A | B | » |\n| --- | --- | --- |\n| « | C | D |');
  const annotated = ariaToMarkdown(`- table:
  - row:
    - cell: A [colspan=2]
  - row:
    - cell: B
    - cell: C`);
  assert.match(annotated, /^\| A \| » \|/);
  assert.ok(!annotated.includes('colspan='));
});

test('malicious enormous spans remain bounded and do not allocate an enormous matrix', () => {
  const table = parseAria(`- table:
  - row:
    - cell "A" [rowspan=999999999999999999] [colspan=999999999999999999]:
  - row:
    - cell: B`).children[0];
  const out = [];
  renderTable(table, out);
  const md = out.join('');
  assert.ok(md.length < 10000);
  assert.ok(md.includes('A'));
  assert.ok(md.split('\n').filter(line => line.startsWith('|')).length <= 3);
});

test('long URLs survive by default and explicit max URL settings still work', () => {
  const previous = process.env.DSH_WEBREADER_MAXURL;
  try {
    delete process.env.DSH_WEBREADER_MAXURL;
    const url = 'https://example.com/' + 'a'.repeat(1000);
    assert.equal(linkText(url, 'long'), `[long](${url})`);
    process.env.DSH_WEBREADER_MAXURL = '120';
    assert.equal(linkText(url, 'long'), 'long');
    assert.equal(linkText('https://example.com', 'short'), '[short](https://example.com)');
  } finally {
    if (previous === undefined) delete process.env.DSH_WEBREADER_MAXURL;
    else process.env.DSH_WEBREADER_MAXURL = previous;
  }
});

test('headings, nested lists, code and plain text maintain useful structure without duplication', () => {
  const yaml = `- heading "Title" [level=1]
- list:
  - listitem "Item Child":
    - text: Item
    - list:
      - listitem: Child
- code: "one__PI_NL__two"`;
  assert.match(ariaToMarkdown(yaml), /^# Title/);
  assert.match(ariaToMarkdown(yaml), /- Item\n  - Child/);
  assert.match(ariaToMarkdown(yaml), /```\none\ntwo\n```/);
  assert.equal(ariaToText('- paragraph "same":\n  - text: same'), 'same');
});
