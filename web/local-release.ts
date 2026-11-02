// The local helper's release as the page shows it (docs/plans/networking-local.md §1 "Plain install lines"): its version,
// the published SHA-256 of each binary, and the install lines for a platform, the same as the release's INSTALL.md
// (webpc-net's build.sh `install`; tests/local-release.test.ts holds the two together). Each release replaces
// `RELEASE` from its SHA256SUMS (a change of webpc's, separate from the release itself).

export type Os = 'linux' | 'darwin' | 'windows';
export type Arch = 'amd64' | 'arm64';
export type Target = { os: Os; arch: Arch };
export type Release = { version: string; /** SHA256SUMS: file name to hash. */ sums: Record<string, string> };

/** The release the page offers: its SHA256SUMS, from github.com/gbl08ma/webpc-net/releases (built twice there, and matched). */
export const RELEASE: Release = {
  version: 'v0.1.0',
  sums: {
    'LICENSES.txt': '63b1e49ef5b5578bbc65bca9329a5bf89aae6509a9d0883ff0a9d72cbcbf54aa',
    'webpc-net-v0.1.0-darwin-amd64': '7679d35c5ed06998f82cd425308e5b9fa1ba1afe86821230563dfaae76cadd11',
    'webpc-net-v0.1.0-darwin-arm64': '5a5a95a9b327bcfbf94c7802d62f4d8e7f0cab62b50db030ffd2dce57b9f5508',
    'webpc-net-v0.1.0-linux-amd64': 'aeb459b109d4d948ca1534f9a4bce7a876fb09d4c846550ab23ece706b6602ea',
    'webpc-net-v0.1.0-linux-arm64': 'c5b39e8ba3c656d1cc9079d8123784034418d9ac7e8faa5bf1d68b73bbc3a96b',
    'webpc-net-v0.1.0-windows-amd64.exe': 'd87d3193e1c5ee75e8e86a7d3daf846dcc4e2320ca9b2b54bd6c58a3ca36669d',
    'webpc-net-v0.1.0-windows-arm64.exe': '20ca570f05469636c57c636f810423461c6582cacf3e299dd2d864edb8333d06',
  },
};

export const TARGETS: Target[] = [
  { os: 'linux', arch: 'amd64' }, { os: 'linux', arch: 'arm64' }, { os: 'darwin', arch: 'amd64' }, { os: 'darwin', arch: 'arm64' },
  { os: 'windows', arch: 'amd64' }, { os: 'windows', arch: 'arm64' },
];

export const SOURCE = 'https://github.com/gbl08ma/webpc-net';
const download = (version: string) => `https://github.com/gbl08ma/webpc-net/releases/download/${version}`;

export const targetName = (t: Target) => `${{ linux: 'Linux', darwin: 'macOS', windows: 'Windows' }[t.os]}, ${t.arch === 'amd64' ? 'x86-64' : 'ARM'}`;
const fileOf = (r: Release, t: Target) => `webpc-net-${r.version}-${t.os}-${t.arch}${t.os === 'windows' ? '.exe' : ''}`;

/** The install lines for `t` (a shell's, or PowerShell's on Windows): download, check the hash, mark it executable, run it. */
export function installLines(r: Release, t: Target): string {
  const file = fileOf(r, t);
  const sum = r.sums[file] ?? '';
  if (t.os === 'windows') {
    return [
      `$d = "$env:LOCALAPPDATA\\Programs\\webpc-net"; New-Item -ItemType Directory -Force $d | Out-Null; $ProgressPreference = 'SilentlyContinue'`,
      `Invoke-WebRequest ${download(r.version)}/${file} -OutFile "$d\\webpc-net.exe"`, // i18n-ignore: a PowerShell command
      `if ((Get-FileHash "$d\\webpc-net.exe").Hash -ne '${sum}') { Remove-Item "$d\\webpc-net.exe"; throw 'not the published hash' }`,
      `& "$d\\webpc-net.exe"`,
    ].join('\n');
  }
  return [
    'mkdir -p ~/.local/bin',
    `curl -fLo ~/.local/bin/webpc-net ${download(r.version)}/${file}`,
    `echo "${sum}  $HOME/.local/bin/webpc-net" | ${t.os === 'darwin' ? 'shasum -a 256 -c' : 'sha256sum -c'} || rm ~/.local/bin/webpc-net`,
    'chmod +x ~/.local/bin/webpc-net',
    '~/.local/bin/webpc-net',
  ].join('\n');
}

/** The release's SHA256SUMS text parsed. */
export function parseSums(text: string): Record<string, string> {
  return Object.fromEntries(text.split('\n').flatMap((l) => {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l.trim());
    return m ? [[m[2], m[1]]] : [];
  }));
}

type UAData = { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; architecture?: string }> };

/** This browser's platform and architecture, where it says (Chromium's client hints; else the user agent's guess). */
export async function thisTarget(nav: { userAgentData?: UAData; userAgent: string } = navigator as never): Promise<Target | undefined> {
  let platform = '', arch = '';
  try {
    const v = await nav.userAgentData?.getHighEntropyValues(['platform', 'architecture']);
    [platform, arch] = [v?.platform ?? '', v?.architecture ?? ''];
  } catch { /* no client hints */ }
  const ua = nav.userAgent;
  const os: Os | undefined = /mac/i.test(platform || ua) ? 'darwin' : /win/i.test(platform || ua) ? 'windows' : /linux|x11|cros/i.test(platform || ua) ? 'linux' : undefined;
  if (!os) return undefined;
  // Without client hints a Mac is assumed ARM (every Mac since 2020 and the user agent says Intel either way).
  const a: Arch = arch ? (/arm/i.test(arch) ? 'arm64' : 'amd64') : os === 'darwin' || /aarch64|arm/i.test(ua) ? 'arm64' : 'amd64';
  return { os, arch: a };
}
