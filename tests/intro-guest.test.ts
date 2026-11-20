// The introduction's guest (images/build.sh intro; docs/images.md "intro"), booted in Node under the JIT: its first
// picture is on the framebuffer before anything is on the console but the tour's first mark; a key ends the tour and
// hands over the shell, which runs a command; one toy has the screen at a time; Ctrl-C stops one; `cycle` leaves a toy started by hand
// alone; `poweroff` ends the machine.
// Skips without the image (a cloud session can't build it).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Exit } from '../web/core.ts';
import { markText } from '../web/app/intro/guest-protocol.ts';
import { bootVm } from '../web/vm.ts';

const IMAGE = new URL('../target/images/intro/intro.img', import.meta.url);
const skip = existsSync(IMAGE) ? false : 'SKIPPED: run images/build.sh intro';
const [W, H] = [512, 320];

test("the introduction's guest: a picture first, a key for the shell, one toy at a time, power off", { skip, timeout: 120_000 }, async () => {
  const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
  const vm = await bootVm(wasm, {
    ramSize: 64 << 20,
    kernel: readFileSync(IMAGE),
    cmdline: 'console=ttyAMA0 quiet waarm64.cols=64 waarm64.rows=12',
    framebuffer: { width: W, height: H },
    realtime: true,
    jit: 1,
  });
  let text = '';
  let off = false;
  const lit = () => new Uint32Array(vm.memory.buffer, vm.framebuffer!.addr, W * H).some((p) => p & 0xffffff);
  /** Runs the guest until `done` (60 s at most). */
  const until = async (what: string, done: () => boolean) => {
    for (const end = performance.now() + 60_000; !done(); ) {
      assert.ok(performance.now() < end, `timed out waiting for ${what}; the console: ${JSON.stringify(text.slice(-300))}`);
      const r = vm.run(300_000);
      text += vm.drain();
      if (r.kind === Exit.PSCI) off = true;
      if (off) break;
      if (r.kind === Exit.DEVICE) await vm.settle();
    }
  };
  try {
    await until('the first picture', lit);
    assert.ok(lit(), 'nothing was drawn');
    // Nothing that looks like Linux yet: the tour's first mark at most.
    assert.equal(text.replace(markText('scope'), ''), '', 'the console said something before the first picture');
    vm.send(' ');
    await until("the shell's prompt", () => /waarm64;shell\x07[^]*~ # /.test(text));
    vm.send('echo ok-$((6*7)); uname -m; stty size\n');
    await until("the command's answer", () => /ok-42\r\naarch64\r\n12 64\r\n/.test(text));
    // A toy started by hand takes the screen from the one that had it.
    vm.send('life & sleep 1; echo toys=$(pidof scope ridges life | wc -w)\n');
    await until('one toy', () => /toys=\d/.test(text.replace(/echo toys=/g, '')));
    assert.match(text, /\ntoys=1\r/, `more than one toy has the screen: ${JSON.stringify(text.slice(-200))}`);
    // Ctrl-C stops a toy run in the foreground, and the shell is back.
    vm.send('killall cycle; scope\n');
    await until('scope in the foreground', () => /killall cycle; scope\r\n/.test(text));
    for (const end = performance.now() + 1500; performance.now() < end; ) vm.run(300_000);
    vm.send('\x03');
    vm.send('echo back-$((6*8))\n');
    await until('the shell after Ctrl-C', () => /back-48\r\n/.test(text));
    // A toy started by hand while `cycle` waits its turn is the visitor's: cycle leaves it alone and stops.
    vm.send('killall cycle; cycle 2 & sleep 0.5; scope & sleep 4; echo kept=$(pidof scope | wc -w) cycling=$(pidof cycle | wc -w)\n');
    await until("cycle's turn", () => /\nkept=\d cycling=\d/.test(text));
    assert.match(text, /\nkept=1 cycling=0\r/, "cycle took the screen from a toy started by hand, or went on");
    // `poweroff` as anybody types it (BusyBox's asks PID 1, which is our init).
    vm.send('poweroff\n');
    await until('the power-off', () => off);
    assert.ok(off, "the guest didn't power off");
  } finally {
    await vm.close();
  }
});
