// The guest's keyboard layout (web/app/keyboard.ts, docs/frontend.md "The keyboard layout"): the layouts, "Match this
// browser", the credentials as SMBIOS strings, and the script the guest runs, under dash on files of its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { oemStrings } from '../web/app/guest-unit.ts';
import { detectLayout, FOLLOW_BROWSER, KEYBOARD_LAYOUTS, keyboardCredentials, keyboardLayout, keyboardScript, keyboardSetting, resolveKeyboard, validKeyboard } from '../web/app/keyboard.ts';

const map = (o: Record<string, string>) => new Map(Object.entries(o));
const US = { KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyY: 'y', KeyZ: 'z', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyJ: 'j', KeyK: 'k', KeyM: 'm', KeyI: 'i', Digit0: '0', Digit2: '2', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Slash: '/', Comma: ',', Period: '.' };

test('layouts: unique ids, XKB names; Match this browser tells them apart', () => {
  assert.equal(new Set(KEYBOARD_LAYOUTS.map((l) => l.id)).size, KEYBOARD_LAYOUTS.length);
  for (const l of KEYBOARD_LAYOUTS) assert.match(`${l.layout} ${l.variant ?? ''} ${l.model ?? ''} ${l.vc}`, /^[a-z]+ [a-z]* [a-z0-9]* [a-zA-Z0-9_-]+$/, l.id);
  assert.equal(detectLayout(map(US))?.id, 'us');
  assert.equal(detectLayout(map({ ...US, KeyY: 'z', KeyZ: 'y', Semicolon: 'ö', Quote: 'ä', BracketLeft: 'ü', BracketRight: '+', Minus: 'ß', Equal: '´', Backquote: '^', Backslash: '#', Slash: '-' }))?.id, 'de');
  assert.equal(detectLayout(map({ ...US, Semicolon: 'ç', Quote: 'º', BracketLeft: '+', BracketRight: '´', Backslash: '~', Minus: "'", Equal: '«', Backquote: '\\' }))?.id, 'pt');
  assert.equal(detectLayout(map({ ...US, Semicolon: 'ç', Quote: '~', BracketLeft: '´', BracketRight: '[', Backslash: ']', Backquote: "'", IntlRo: '/' }))?.id, 'br');
  assert.equal(detectLayout(map({ ...US, KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', Semicolon: 'm', KeyM: ',', Digit2: 'é', Quote: 'ù', BracketLeft: '^', Minus: ')', Backquote: '²', Backslash: '*' }))?.id, 'fr');
  assert.equal(detectLayout(map({ ...US, Backslash: '#', IntlBackslash: '\\' }))?.id, 'gb');
  // Nothing like any of them, or too few keys: no answer.
  assert.equal(detectLayout(map({ KeyQ: 'й', KeyW: 'ц', KeyE: 'у', Semicolon: 'ж', Quote: 'э', BracketLeft: 'х' })), undefined);
  assert.equal(detectLayout(map({ KeyQ: 'q' })), undefined);
});

test("the setting's values: a layout, or the browser's at every start (none where it doesn't say)", async () => {
  assert.ok(validKeyboard('pt') && validKeyboard(FOLLOW_BROWSER) && !validKeyboard('xx') && !validKeyboard(''));
  const de = async () => keyboardLayout('de');
  assert.equal((await resolveKeyboard('pt', de))?.id, 'pt');
  assert.equal((await resolveKeyboard(FOLLOW_BROWSER, de))?.id, 'de');
  assert.equal(await resolveKeyboard(FOLLOW_BROWSER, async () => undefined), undefined);
  assert.equal(await resolveKeyboard(undefined, de), undefined);
  // Node has no Keyboard API: the browser's is none.
  assert.equal(await resolveKeyboard(FOLLOW_BROWSER), undefined);
});

test("which setting a start uses: the query's, a stored machine's own, the browser's for a disk the user opened", () => {
  assert.equal(keyboardSetting('gb', { keyboard: 'pt' }, false), 'gb');
  assert.equal(keyboardSetting(null, { keyboard: 'pt' }, false), 'pt');
  assert.equal(keyboardSetting(null, {}, false), undefined); // a stored machine set to "Don't set it"
  assert.equal(keyboardSetting(null, undefined, false), FOLLOW_BROWSER); // `?disk=`, or a file opened on the page
  assert.equal(keyboardSetting(null, undefined, true), undefined); // the tests' `?machine=`
  assert.equal(keyboardSetting('none', undefined, false), 'none'); // turned off by the query: no layout
  assert.equal(keyboardLayout('none'), undefined);
});

test('credentials: a unit, its drop-in on systemd-user-sessions and its script, as base64 SMBIOS strings', () => {
  const c = keyboardCredentials(keyboardLayout('ch-fr')!);
  assert.deepEqual(c.map((x) => x.name), ['webpc.keyboard.sh', 'systemd.extra-unit.webpc-keyboard.service', 'systemd.unit-dropin.systemd-user-sessions.service~webpc-keyboard']);
  assert.match(c[1].data, /^ImportCredential=webpc\.keyboard\.sh$/m);
  assert.match(c[1].data, /^ExecStart=\/bin\/sh %d\/webpc\.keyboard\.sh$/m);
  assert.match(c[1].data, /^ConditionPathExists=!\/etc\/initrd-release$/m);
  assert.equal(c[2].data, '[Unit]\nWants=webpc-keyboard.service\nAfter=webpc-keyboard.service\n');
  const s = oemStrings(c);
  for (const [i, x] of s.entries()) {
    const [, name, b64] = x.match(/^io\.systemd\.credential\.binary:([^=]+)=(.*)$/)!;
    assert.equal(name, c[i].name);
    assert.equal(Buffer.from(b64, 'base64').toString(), c[i].data);
  }
});

/** The script with its paths moved under `dir`, run by dash (Debian's sh). */
function runScript(id: string, dir: string, debian: boolean) {
  const script = keyboardScript(keyboardLayout(id)!)
    .replaceAll('/etc/default/keyboard', join(dir, 'keyboard'))
    .replaceAll('/etc/environment', join(dir, 'environment'))
    .replaceAll('/usr/share/dbus-1/system.d/systemd-localed-read-only.conf', debian ? join(dir, 'read-only.conf') : join(dir, 'none'))
    .replaceAll('command -v localectl', 'false').replaceAll('command -v setupcon', 'false');
  writeFileSync(join(dir, 's.sh'), script);
  execFileSync('dash', [join(dir, 's.sh')], { stdio: 'pipe' });
}

test("the script: Debian's /etc/default/keyboard and /etc/environment set, others' lines kept, the same again changes nothing", { skip: !process.env.PATH?.split(':').some((p) => { try { return readFileSync(join(p, 'dash')).length > 0; } catch { return false; } }) && 'no dash' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'webpc-kbd-'));
  try {
    writeFileSync(join(dir, 'read-only.conf'), '');
    writeFileSync(join(dir, 'keyboard'), 'XKBMODEL="pc105"\nXKBLAYOUT="us"\nXKBVARIANT="intl"\nXKBOPTIONS="ctrl:nocaps"\nBACKSPACE="guess"\n');
    writeFileSync(join(dir, 'environment'), 'PATH_EXTRA=1\nXKB_DEFAULT_LAYOUT=us\nXKB_DEFAULT_VARIANT=intl\n');
    runScript('br', dir, true);
    assert.equal(readFileSync(join(dir, 'keyboard'), 'utf8'), 'XKBMODEL="abnt2"\nXKBLAYOUT="br"\nXKBVARIANT=""\nXKBOPTIONS="ctrl:nocaps"\nBACKSPACE="guess"\n');
    assert.equal(readFileSync(join(dir, 'environment'), 'utf8'), 'PATH_EXTRA=1\nXKB_DEFAULT_LAYOUT=br\nXKB_DEFAULT_MODEL=abnt2\n');
    runScript('br', dir, true);
    assert.equal(readFileSync(join(dir, 'environment'), 'utf8'), 'PATH_EXTRA=1\nXKB_DEFAULT_LAYOUT=br\nXKB_DEFAULT_MODEL=abnt2\n');
    // A guest without /etc/default/keyboard (and not Debian's localed): it isn't made; a variant goes in the environment.
    rmSync(join(dir, 'keyboard'));
    rmSync(join(dir, 'environment'));
    runScript('ch-fr', dir, false);
    assert.throws(() => readFileSync(join(dir, 'keyboard')));
    assert.equal(readFileSync(join(dir, 'environment'), 'utf8'), 'XKB_DEFAULT_LAYOUT=ch\nXKB_DEFAULT_MODEL=pc105\nXKB_DEFAULT_VARIANT=fr\n');
    // Debian 13 without the file: made with the three lines.
    runScript('de', dir, true);
    assert.equal(readFileSync(join(dir, 'keyboard'), 'utf8'), 'XKBMODEL="pc105"\nXKBLAYOUT="de"\nXKBVARIANT=""\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the script elsewhere: localed's X11 keymap and the console's, each named; without that console keymap, the conversion", { skip: !process.env.PATH?.split(':').some((p) => { try { return readFileSync(join(p, 'dash')).length > 0; } catch { return false; } }) && 'no dash' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'webpc-kbd-'));
  try {
    const run = (id: string, keymapFails: boolean) => {
      // localectl a shell function that records its arguments (and refuses set-keymap when the keymap is missing).
      const script = `localectl() { echo "$*" >>${join(dir, 'log')}; [ "$1" != set-keymap ] || ${keymapFails ? 'false' : 'true'}; }\n` + keyboardScript(keyboardLayout(id)!)
        .replaceAll('/etc/default/keyboard', join(dir, 'keyboard')).replaceAll('/etc/environment', join(dir, 'environment'))
        .replaceAll('/usr/share/dbus-1/system.d/systemd-localed-read-only.conf', join(dir, 'none'));
      writeFileSync(join(dir, 's.sh'), script);
      rmSync(join(dir, 'log'), { force: true });
      execFileSync('dash', [join(dir, 's.sh')], { stdio: 'pipe' });
      return readFileSync(join(dir, 'log'), 'utf8');
    };
    assert.equal(run('de', false), 'set-x11-keymap --no-convert de pc105 \nset-keymap --no-convert de-latin1\n');
    assert.equal(run('ch-fr', true), 'set-x11-keymap --no-convert ch pc105 fr\nset-keymap --no-convert fr_CH-latin1\nset-x11-keymap ch pc105 fr\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
