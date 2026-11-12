// The address's development knobs, parsed once on the page (web/gpu-knobs.ts `parseGpuKnobs` for the GPU worker,
// web/app/run/dev-knobs.ts `parseDevKnobs` for the machine worker): every spelling bench/, the dEQP runs and the tests
// use gives what the page's and the worker's parsers gave before (pinned here as they were).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGpuKnobs } from '../web/gpu-knobs.ts';
import { parseDevKnobs } from '../web/app/run/dev-knobs.ts';

/** The page's `gpuInitKnobs` before the parser (web/app/run/knobs.ts). */
function oldGpuInit(params: URLSearchParams, shaderMiB?: number) {
  const gpuKnobs = (params.get('gpu') ?? '').split(',');
  const knob = (prefix: string) => gpuKnobs.find((k) => k.startsWith(prefix))?.slice(prefix.length);
  const knobs = (prefix: string) => gpuKnobs.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  const knobNumber = (prefix: string) => { const v = knob(prefix); return v === undefined ? undefined : Number(v); };
  const knobList = (prefix: string) => knobs(prefix).flatMap((k) => k.split(/[+ ]/)).filter(Boolean);
  return {
    stats: params.has('displaystats'), debug: gpuKnobs.includes('debug'), probe: params.has('avprobe'), video: !gpuKnobs.includes('novideo'),
    softwareVideo: gpuKnobs.includes('swvideo'), waitAttached: gpuKnobs.includes('waitattached'),
    vkShare: (['readback', 'canvas', 'bitmap'] as const).find((w) => gpuKnobs.includes(`vk${w}`)), vkBreak: knobs('vkbreak='), vkVendor: knob('vkvendor='),
    vkPoll: gpuKnobs.includes('vkpoll=timeout') ? 'timeout' : gpuKnobs.includes('vkpoll=pump') ? 'pump' : undefined,
    vkSyncPipelines: gpuKnobs.includes('vkpipelines=sync'), vkPipeDelayMs: knobNumber('vkpipedelay='), vkNoCache: gpuKnobs.includes('vkcache=off'),
    vkImportRewrite: gpuKnobs.includes('vkimport=rewrite'), vkPremake: gpuKnobs.includes('vkpremake=on'), vkQueues: knobNumber('vkqueues='),
    vkShaderBudget: shaderMiB ? shaderMiB * 2 ** 20 : undefined, vkNudgeMs: knobNumber('vknudge='), vkGpuTime: gpuKnobs.includes('vkgputime'),
    vkTickMs: knobNumber('vktick='), vkIdleMs: knobNumber('vkidle='), vkHold: knobs('vkhold='), vkHeldFormats: gpuKnobs.includes('vkformats=held'),
    vkYcbcr: !gpuKnobs.includes('vkycbcr=off'), vkL9: knobs('vkl9='), vkSkip: knobs('vkskip='), capsNo: knobList('capsno='), capsYes: knobList('capsyes='),
    queryPoll: knob('querypoll='),
  };
}

/** The machine worker's parsing of the query before the page did it (web/app/worker.ts `gpuTuning`, `sndTuning`, `start`'s). */
function oldWorker(query: URLSearchParams) {
  const knobs = (query.get('gpu') ?? '').split(',');
  const q = knobs.find((k) => /^q\d+$/.test(k));
  const snd = (query.get('snd') ?? '').split(',');
  return {
    gpu: {
      paceFlushes: !knobs.includes('nopace'), queueSize: q ? Number(q.slice(1)) : 16, virglNull: knobs.includes('virgl-null'),
      noWatch: knobs.includes('nowatch'), capture: knobs.includes('capture'),
      screen2d: knobs.includes('canvas2d') ? 'canvas2d' : knobs.includes('gl2d') ? 'webgl2' : 'auto',
    },
    snd: { wake: snd.includes('timer') ? 'timer' : 'worklet', stats: snd.includes('stats') },
    compileWorker: query.get('jit') !== 'nocw', fma: query.get('fma') !== 'emul', exactCore: !query.has('growcore'),
    vcpuYieldMs: query.has('vyield') ? Number(query.get('vyield')) : undefined,
    sharesAsync: (query.get('sharesasync') ?? '').split(','),
    // The page's start message's (`|| undefined` there, true or absent).
    displayStats: query.has('displaystats'), ioStats: query.has('iostats'), noDiskCache: query.get('diskcache') === '0', avProbe: query.has('avprobe'),
    guestReadyOnly: query.get('ready') === 'guest', // added with the knob (docs/clipboard.md "The machine's state")
  };
}

const QUERIES = [
  '', 'gpu=', 'gpu=,', 'gpu=2d', 'gpu=2d,canvas2d', 'gpu=2d,gl2d', 'gpu=canvas2d', 'gpu=nopace', 'gpu=nopace,q4', 'gpu=q32', 'gpu=virgl', 'gpu=virgl-null',
  'gpu=virgl-null,capture', 'gpu=virgl,debug', 'gpu=virgl,video', 'gpu=virgl,novideo,swvideo,waitattached', 'gpu=vulkan', 'gpu=vulkan,nowatch',
  'gpu=virgl,vulkan,vkbitmap', 'gpu=vkcanvas', 'gpu=vkreadback', 'gpu=vkbreak=bitmap,vkbreak=canvas', 'gpu=vkvendor=nvidia', 'gpu=vkpoll=timeout',
  'gpu=vkpoll=pump', 'gpu=vkpipelines=sync', 'gpu=vkpipedelay=200', 'gpu=vkcache=off', 'gpu=vkimport=rewrite', 'gpu=vkpremake=on', 'gpu=vkqueues=2',
  'gpu=vknudge=0', 'gpu=vkgputime', 'gpu=vktick=3', 'gpu=vkidle=40', 'gpu=vkhold=float32-filterable,vkhold=bgra8unorm-storage', 'gpu=vkformats=held',
  'gpu=vkycbcr=off', 'gpu=vkycbcr', 'gpu=vkl9=bindgroups,pad', 'gpu=vkl9=all', 'gpu=vkskip=a,vkskip=b', 'gpu=capsno=B8G8R8A8_UNORM+R8_UNORM',
  'gpu=virgl,capsno=A capsno=B', 'gpu=capsyes=1+2,capsyes=3', 'gpu=querypoll=spin', 'displaystats', 'displaystats&gpu=virgl', 'avprobe&snd=',
  'snd=stats', 'snd=stats,timer', 'snd=', 'jit=nocw', 'jit=other', 'fma=emul', 'growcore', 'vyield=0', 'vyield=2', 'sharesasync=Host',
  'sharesasync=a,b', 'iostats', 'diskcache=0', 'diskcache=1', 'ready=guest', 'ready=serial', 'gpu=1', 'gpu=verify', 'gpu=vk',
];

test('knobs: the GPU worker\'s and the machine worker\'s from every spelling, as before', () => {
  for (const s of QUERIES) {
    const q = new URLSearchParams(s);
    for (const mib of [undefined, 0, 256]) assert.deepEqual(parseGpuKnobs(q, mib), oldGpuInit(q, mib), `?${s} (shader ${mib} MiB): the GPU worker's`);
    assert.deepEqual(parseDevKnobs(q), oldWorker(q), `?${s}: the machine worker's`);
  }
});

test('knobs: a few by value', () => {
  const g = parseGpuKnobs(new URLSearchParams('gpu=virgl,vkbitmap,vkqueues=2,capsno=A+B,vkhold=x&displaystats'), 64);
  assert.equal(g.vkShare, 'bitmap');
  assert.equal(g.vkQueues, 2);
  assert.deepEqual(g.capsNo, ['A', 'B']);
  assert.deepEqual(g.vkHold, ['x']);
  assert.equal(g.stats, true);
  assert.equal(g.vkShaderBudget, 64 * 2 ** 20);
  const d = parseDevKnobs(new URLSearchParams('gpu=2d,canvas2d,nopace,q4&snd=stats,timer&jit=nocw&vyield=3'));
  assert.deepEqual(d.gpu, { paceFlushes: false, queueSize: 4, virglNull: false, noWatch: false, capture: false, screen2d: 'canvas2d' });
  assert.deepEqual(d.snd, { wake: 'timer', stats: true });
  assert.equal(d.compileWorker, false);
  assert.equal(d.vcpuYieldMs, 3);
});
