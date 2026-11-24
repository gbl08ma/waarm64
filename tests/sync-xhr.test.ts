// The deterministic mode's remote reads (synchronous XHRs: web/chunked.ts `xhrGet`, web/disk-sources.ts
// `httpSource`) are bounded as `fetchBytes` is: a try that doesn't end in `SYNC_STALL_MS` is aborted (`timeout`) and tried
// again, and when every try timed out the read fails (the guest's I/O error); in a window, where a synchronous request
// refuses a `timeout`, none is set. XMLHttpRequest is faked here.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SYNC_STALL_MS, STALL_TRIES, xhrGet } from '../web/chunked.ts';
import { httpSource } from '../web/disk-sources.ts';

const g = globalThis as { XMLHttpRequest?: unknown; document?: unknown };
afterEach(() => {
  delete g.XMLHttpRequest;
  delete g.document;
});

/** Fakes XMLHttpRequest: each send takes the next of `answers` (`hang`: it times out if a timeout is set). */
function fake(answers: ('hang' | number)[]) {
  const sent: { method: string; timeout: number }[] = [];
  g.XMLHttpRequest = class {
    timeout = 0;
    responseType = '';
    status = 0;
    response: ArrayBuffer | null = null;
    method = '';
    open(method: string, _url: string, async: boolean) {
      assert.equal(async, false);
      this.method = method;
    }
    setRequestHeader() {}
    getResponseHeader(name: string) {
      return name === 'content-length' ? '8' : null;
    }
    send() {
      if (this.timeout && g.document) throw new DOMException('a window refuses it', 'InvalidAccessError');
      sent.push({ method: this.method, timeout: this.timeout });
      const a = answers.shift() ?? 'hang';
      if (a === 'hang') {
        if (this.timeout) throw new DOMException('timed out', 'TimeoutError');
        throw new Error('the test would hang here');
      }
      this.status = a;
      this.response = new ArrayBuffer(8);
    }
  };
  return sent;
}

test('a synchronous GET is bounded in a worker, tried again once it timed out, and fails when every try did', () => {
  let sent = fake(['hang', 200]);
  const r = xhrGet('http://h/x');
  assert.equal(r.status, 200);
  assert.equal(r.body?.length, 8);
  assert.deepEqual(
    sent.map((s) => s.timeout),
    [SYNC_STALL_MS, SYNC_STALL_MS],
  );
  sent = fake(Array.from({ length: STALL_TRIES }, () => 'hang' as const));
  assert.equal(xhrGet('http://h/x').status, 0, 'no answer: a failed read');
  assert.equal(sent.length, STALL_TRIES);
});

test("an HTTP source's range read that times out every try reads as failed; its opening throws", () => {
  fake([200, ...Array.from({ length: STALL_TRIES }, () => 'hang' as const), 206]);
  const src = httpSource('http://h/disk.img');
  assert.equal(src.size, 8);
  assert.equal(src.read(0, 8), undefined, 'every try timed out');
  assert.equal(src.read(0, 8)?.length, 8, 'the next read is asked again');
  fake(Array.from({ length: STALL_TRIES }, () => 'hang' as const));
  assert.throws(() => httpSource('http://h/disk.img'));
});

test('on a window, where a synchronous request refuses a timeout, none is set', () => {
  g.document = {};
  const sent = fake([200]);
  assert.equal(xhrGet('http://h/x').status, 200);
  assert.deepEqual(
    sent.map((s) => s.timeout),
    [0],
  );
});
