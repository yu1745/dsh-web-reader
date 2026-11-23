import test from "node:test";
import assert from "node:assert/strict";
import { createJevClassifier } from "../src/vendor/shared/jev/runtime.ts";

const { classifyJev } = await import("../lib/web-reader.js");

const { readinessInput, visualReadinessInput, waitForReadableContent, decision, judge } = await import(
  "../src/vendor/web-reader/readiness.ts"
);

const sample = {
  title: "Example",
  text: "A sufficiently long article excerpt that should count as readable content.",
  textLength: 420,
  contentEvidence: true,
  listEvidence: false,
  pendingContent: false,
  consentText: "",
};
const weak = { ...sample, textLength: 40, contentEvidence: false, pendingContent: true, text: "Loading" };

const QUESTION_IDS = ["main_content_present", "still_loading", "consent_only", "consent_overlay_blocking", "login_or_paywall", "age_or_content_gate", "bot_check", "error_page"];

/** 构造一个完整的 Noul 答案集；overrides 只改指定问题。 */
const answers = (overrides = {}) => ({
  answers: Object.fromEntries(
    QUESTION_IDS.map((id) => [id, { type: "bool", probability: { main_content_present: 0.02, still_loading: 0.02, consent_only: 0.02, consent_overlay_blocking: 0.02, login_or_paywall: 0.02, age_or_content_gate: 0.02, bot_check: 0.02, error_page: 0.02, ...overrides }[id] }]),
  ),
});
const READY = { main_content_present: 0.97, still_loading: 0.03 };

function makePage({ current = sample, screenshot = true, failScreenshot = false, consentTools = null } = {}) {
  const calls = { screenshots: 0, scans: 0 };
  let clock = 0;
  const page = {
    calls,
    now: () => clock,
    async evaluate(expression) {
      const text = String(expression);
      if (text.includes("data-yu-overlay")) calls.scans++;
      if (text.includes("contentEvidence")) return typeof current === "function" ? current() : current;
      return false; // consent dismissal
    },
    async waitForTimeout(ms) { clock += ms; },
  };
  if (consentTools) Object.assign(page, consentTools);
  if (screenshot) {
    page.screenshot = async () => {
      calls.screenshots++;
      if (failScreenshot) throw new Error("screenshot failed");
      return new Uint8Array(2000);
    };
  }
  return page;
}
const run = (page, jev) => waitForReadableContent(page, "https://example.com", jev, undefined, page.now);

test("readiness requests are atomic Noul questions with complete instructions", () => {
  for (const input of [readinessInput("https://example.com", sample), visualReadinessInput("https://example.com", sample)]) {
    assert.deepEqual(Object.keys(input.questions).sort(), [...QUESTION_IDS].sort());
    for (const question of Object.values(input.questions)) {
      assert.equal(question.type, "bool", "the transport maps public bool to wire noul");
      assert.ok(question.instructions.length > 40, "the question id is never sent, so the instructions must stand alone");
    }
  }
});

test("readiness passes TypeSafe bool-to-noul transport mapping and shared runtime validation", async () => {
  const model = { api: "typesafe", provider: "typesafe", id: "jev-latest", input: ["text"] };
  let requests = 0;
  const jev = createJevClassifier({ modelRegistry: {
    findOfType: () => model,
    classify: (selected, context, options) => classifyJev(selected, context, {
      ...options,
      apiKey: "local-test-only",
      fetch: async (url, init) => {
        assert.equal(url, "https://api.typesafe.ai/v1/systemone");
        assert.equal(init.headers.Authorization, "Bearer local-test-only");
        requests++;
        const wire = JSON.parse(init.body);
        assert.deepEqual(Object.keys(wire.questions).sort(), [...QUESTION_IDS].sort());
        for (const question of Object.values(wire.questions)) assert.equal(question.type, "noul");
        return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(wire.questions).map(id => [id, {
          type: "noul", noul: id === "main_content_present" ? 0.97 : 0.03,
        }])) }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  } });
  const result = await jev.evaluate(readinessInput("https://example.com", sample));
  assert.equal(result.answers.main_content_present.type, "bool");
  assert.equal(result.answers.main_content_present.probability, 0.97);
  const verdict = await run(makePage({ screenshot: false }), jev);
  assert.equal(verdict.pageKind, "content");
  assert.equal(verdict.fallback, false, "a protocol mismatch must not be concealed by mechanical readiness");
  assert.equal(verdict.verdicts, 1);
  assert.equal(requests, 2);
});

test('TypeSafe sends a referenced PNG asset and preserves reported token usage', async () => {
  const context = visualReadinessInput('https://example.com', sample);
  context.images = [{ mimeType: 'image/png', data: 'fixture-base64' }];
  const result = await classifyJev({ id: 'jev-latest' }, context, {
    apiKey: 'fixture-key',
    async fetch(_url, init) {
      assert.equal(init.headers['TypeSafe-Danger-Zone-Images'], 'true');
      const wire = JSON.parse(init.body);
      assert.deepEqual(wire.state, ['<image-1>', context.state]);
      assert.deepEqual(wire.assets, {
        '<image-1>': { type: 'image', format: 'png', data_base64: 'fixture-base64' },
      });
      return Response.json({
        answers: Object.fromEntries(QUESTION_IDS.map(id => [id, { type: 'noul', noul: 0.03 }])),
        usage: { input_tokens: 35, output_tokens: 4 },
      });
    },
  });
  assert.equal(result.usage.totalTokens, 39);
  assert.equal(result.answers.still_loading.probability, 0.03);
});

test("readiness requests carry list and video evidence and tell Jev to ignore consent overlays", () => {
  const input = visualReadinessInput("https://example.com", { ...sample, contentEvidence: false, listEvidence: true, mediaEvidence: true });
  assert.ok(input.state.observations.some((line) => line.includes("link-dense list")));
  assert.ok(input.state.observations.some((line) => line.includes("video player")));
  assert.ok(input.state.observations.some((line) => line.includes("screenshot")));
  assert.match(input.questions.main_content_present.instructions, /consent banners?, dialogs and dimmed backdrops are NOT the content/i);
  assert.match(input.questions.still_loading.instructions, /Ignore consent banners/i);
  assert.ok(!readinessInput("https://example.com", sample).state.observations.some((line) => line.includes("attached PNG")));
});

test("judge uses the 0.7 / 0.3 thresholds and leaves the middle band waiting", () => {
  const verdict = (overrides) => judge(decision(answers(overrides)));
  assert.equal(verdict(READY), "ready");
  assert.equal(verdict({ main_content_present: 0.69, still_loading: 0.03 }), "wait");
  assert.equal(verdict({ main_content_present: 0.8, still_loading: 0.5 }), "wait", "probable content still needs a clear not-loading");
  assert.equal(verdict({ main_content_present: 0.95, still_loading: 0.5 }), "ready", "certain content is not vetoed by a vague loading signal");
  assert.equal(verdict({ main_content_present: 0.95, still_loading: 0.8 }), "wait", "but a clear loading signal still waits");
  assert.deepEqual(verdict({ main_content_present: 0.05, bot_check: 0.95 }), { blocked: "bot_check" });
  assert.deepEqual(verdict({ main_content_present: 0.05, login_or_paywall: 0.9 }), { blocked: "login_wall" });
  assert.equal(verdict({ main_content_present: 0.5, bot_check: 0.95 }), "wait", "a blocker only wins when the content is clearly absent");
  assert.equal(decision({ answers: {} }), undefined);
  assert.equal(decision({ answers: { ...answers().answers, still_loading: { type: "bool", probability: 2 } } }), undefined);
});

test("one combined request carries the screenshot and every question, and nothing scans or hides overlays", async () => {
  const page = makePage();
  const requests = [];
  const jev = { async evaluate(request) { requests.push(request); return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.pageKind, "content");
  assert.equal(requests.length, 1, "text and visual judgements are one request, not two");
  assert.equal(requests[0].images.length, 1);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [...QUESTION_IDS].sort());
  assert.equal(page.calls.scans, 0);
  assert.equal(verdict.visualVerdicts, 1);
});

test("a consent dialog over visible content does not delay or block the read", async () => {
  const page = makePage({ current: { ...sample, consentText: "We use cookies. Accept or reject." } });
  let calls = 0;
  const jev = { async evaluate() { calls++; return answers({ ...READY, consent_only: 0.04 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.blocked, undefined);
  assert.equal(calls, 1);
  assert.equal(page.calls.scans, 0);
});

test("a strong verdict is accepted when the DOM heuristics are weak", async () => {
  const page = makePage({ current: weak });
  const jev = { async evaluate() { return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.pageKind, "content");
  assert.ok(verdict.visualScore >= 0.9);
});

test("a bot check page is reported as blocked", async () => {
  const page = makePage({ current: { ...sample, contentEvidence: false, textLength: 60, text: "Vérification de sécurité en cours" } });
  const jev = { async evaluate() { return answers({ main_content_present: 0.02, bot_check: 0.97 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.blocked, "bot_check");
  assert.equal(verdict.incomplete, false);
});

test("a consent wall with no content is only reported once the wait budget is spent", async () => {
  const page = makePage({ current: { ...sample, contentEvidence: false, textLength: 30, text: "", consentText: "Accept cookies" } });
  let calls = 0;
  const jev = { async evaluate() { calls++; return answers({ main_content_present: 0.03, consent_only: 0.96 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.blocked, "consent_wall");
  assert.ok(calls > 1, "keeps polling in case the content arrives");
  assert.ok(page.now() >= 7000);
});

test("a screenshot failure falls back to the same questions without an image", async () => {
  const page = makePage({ failScreenshot: true });
  const requests = [];
  const jev = { async evaluate(request) { requests.push(request); return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(requests[0].images, undefined);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [...QUESTION_IDS].sort());
  assert.equal(verdict.visualVerdicts, 0);
});

test("an unparseable text-only answer falls back to the mechanical rules", async () => {
  const page = makePage({ screenshot: false });
  const jev = { async evaluate() { return { answers: {} }; } };
  const verdict = await run(page, jev);
  assert.equal(verdict.fallback, true);
  assert.equal(verdict.incomplete, false);
});

test("persistent sampling errors expose the browser exception instead of silent incomplete", async () => {
  const page = makePage();
  const failure = new ReferenceError('__name is not defined');
  page.evaluate = async expression => {
    if (String(expression).includes('contentEvidence')) throw failure;
    return false;
  };
  await assert.rejects(run(page, undefined), error => {
    assert.match(error.message, /sampling failed throughout.*__name is not defined/);
    assert.equal(error.cause, failure);
    return true;
  });
});

test("a transient sampling failure can recover during the same budget", async () => {
  const page = makePage();
  const evaluate = page.evaluate;
  let failures = 0;
  page.evaluate = async expression => {
    if (String(expression).includes('contentEvidence') && failures++ === 0) throw new Error('Execution context was destroyed');
    return evaluate(expression);
  };
  assert.equal((await run(page, undefined)).pageKind, 'content');
});

test("missing samples also report an explicit sampling failure", async () => {
  const page = makePage();
  page.evaluate = async () => undefined;
  await assert.rejects(run(page, undefined), /page.evaluate returned no sample/);
});

test("an unparseable image answer also falls back to mechanical readiness", async () => {
  const page = makePage();
  const verdict = await run(page, { async evaluate() { return { answers: {} }; } });
  assert.equal(verdict.fallback, true);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.visualVerdicts, 1);
});

test("loaded video content does not require a long text transcript in mechanical fallback", async () => {
  const page = makePage({ current: { ...sample, text: "", textLength: 0, contentEvidence: false, mediaEvidence: true } });
  const verdict = await run(page, undefined);
  assert.equal(verdict.pageKind, "content");
});

test("a video page converges through the loaded player while timecodes and counters churn", async () => {
  let tick = 0;
  const page = makePage({ current: () => ({ ...sample, contentEvidence: false, listEvidence: false, mediaEvidence: true, pendingContent: false, text: `0:0${tick % 10} / 3:33 在线 ${1000 + tick++}`, textLength: 800 }) });
  const verdict = await run(page, undefined);
  assert.equal(verdict.pageKind, "content");
  assert.ok(page.now() < 3000, `video pages must not burn the wait budget (took ${page.now()}ms)`);
});

test("an indecisive Jev no longer starves a mechanically ready video page", async () => {
  let tick = 0;
  const page = makePage({ current: () => ({ ...sample, contentEvidence: false, listEvidence: false, mediaEvidence: true, pendingContent: false, text: `0:0${tick++ % 10} / 3:33`, textLength: 800 }) });
  const verdict = await run(page, { async evaluate() { return answers({ main_content_present: 0.5, still_loading: 0.5 }); } });
  assert.equal(verdict.pageKind, "content");
  assert.equal(verdict.fallback, true, "the decision came from DOM evidence, not Jev");
  assert.ok(page.now() < 4000, `took ${page.now()}ms`);
});

test("an indecisive Jev no longer starves a stable article", async () => {
  const page = makePage();
  const verdict = await run(page, { async evaluate() { return answers({ main_content_present: 0.5, still_loading: 0.5 }); } });
  assert.equal(verdict.pageKind, "content");
  assert.equal(verdict.jevScore, 0.5);
  assert.equal(verdict.fallback, true);
  assert.ok(page.now() < 2000, `took ${page.now()}ms`);
});

test("a strongly opposed Jev still outranks DOM readiness evidence", async () => {
  const page = makePage();
  const verdict = await run(page, { async evaluate() { return answers({ main_content_present: 0.05, still_loading: 0.95 }); } });
  assert.equal(verdict.incomplete, true);
  assert.equal(page.now(), 8000);
});

test("an image request that fails in transit is re-asked without the image instead of dropping Jev", async () => {
  const page = makePage();
  const requests = [];
  const jev = { async evaluate(request) { requests.push(request); if (request.images?.length) throw new Error("does not support image input"); return answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.pageKind, "content");
  assert.equal(verdict.fallback, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].images?.length, 1, "the screenshot is tried first");
  assert.equal(requests[1].images, undefined, "the same questions are re-asked as text only");
  assert.deepEqual(Object.keys(requests[1].questions).sort(), [...QUESTION_IDS].sort());
  assert.match(requests[1].questions.main_content_present.instructions, /Using `page_text`:/);
  assert.equal(verdict.visualVerdicts, 1, "the image attempt is still counted");
  assert.equal(verdict.visualScore, undefined, "but the decision came from the text re-ask");
  assert.equal(page.calls.scans, 0);
});

test("a single transient transport failure does not abandon Jev for the rest of the page", async () => {
  const page = makePage({ current: weak });
  const requests = [];
  let failures = 0;
  const jev = {
    async evaluate(request) {
      requests.push(request);
      if (failures++ === 0) throw new Error("transient congestion");
      return answers(READY);
    },
  };
  const verdict = await run(page, jev);
  assert.equal(verdict.pageKind, "content");
  assert.equal(verdict.fallback, false, "one failed ask must not flip the page to mechanical rules");
  assert.equal(verdict.jevScore, 0.97);
  assert.equal(requests[0].images?.length, 1);
  assert.equal(requests[1].images, undefined, "screenshots stop after the transport rejected one");
  assert.deepEqual(Object.keys(requests[1].questions).sort(), [...QUESTION_IDS].sort());
});

test("the mechanical fallback is used without Jev", async () => {
  const page = makePage({ screenshot: false });
  const verdict = await run(page, undefined);
  assert.equal(verdict.incomplete, false);
  assert.equal(verdict.fallback, true);
});

test("an uncertain answer keeps waiting until a confident one arrives", async () => {
  const page = makePage({ current: weak });
  let calls = 0;
  const jev = { async evaluate() { calls++; return calls < 3 ? answers({ main_content_present: 0.5, still_loading: 0.6 }) : answers(READY); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.equal(calls, 3);
});

test("a consent overlay that blocks the view is cleared, then the read is re-asked and completes", async () => {
  let cleared = false;
  const events = [];
  const page = makePage({
    current: { ...sample, contentEvidence: false, textLength: 30, text: "", consentText: "" },
    consentTools: {
      async clearConsentOverlay() { cleared = true; events.push("clear"); return { clicked: 0, hidden: 1 }; },
      async restoreConsentOverlay() { events.push("restore"); return 1; },
    },
  });
  let calls = 0;
  const jev = {
    async evaluate() {
      calls++;
      return cleared ? answers(READY) : answers({ main_content_present: 0.2, consent_overlay_blocking: 0.95 });
    },
  };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.deepEqual(events, ["clear"]);
  assert.equal(calls, 2);
  assert.equal(verdict.overlayCleared, 1);
});

test("content that is already ready never triggers consent clearing, even with a blocking dialog", async () => {
  const events = [];
  const page = makePage({ consentTools: { async clearConsentOverlay() { events.push("clear"); return { clicked: 1, hidden: 1 }; }, async restoreConsentOverlay() { return 0; } } });
  const jev = { async evaluate() { return answers({ ...READY, consent_overlay_blocking: 0.97 }); } };
  const verdict = await run(page, jev);
  assert.equal(verdict.incomplete, false);
  assert.deepEqual(events, []);
  assert.equal(verdict.overlayCleared, undefined);
});

test("clearing that makes the content probability collapse is restored and not retried", async () => {
  let cleared = false;
  const events = [];
  const page = makePage({
    current: weak,
    consentTools: {
      async clearConsentOverlay() { cleared = true; events.push("clear"); return { clicked: 0, hidden: 2 }; },
      async restoreConsentOverlay() { cleared = false; events.push("restore"); return 2; },
    },
  });
  const jev = {
    async evaluate() {
      return cleared ? answers({ main_content_present: 0.05, consent_overlay_blocking: 0.9 }) : answers({ main_content_present: 0.6, consent_overlay_blocking: 0.9 });
    },
  };
  const verdict = await run(page, jev);
  assert.deepEqual(events.slice(0, 2), ["clear", "restore"]);
  assert.equal(events.filter((e) => e === "clear").length, 1, "no second attempt after a harmful clear");
  assert.equal(verdict.overlayCleared, undefined);
});
