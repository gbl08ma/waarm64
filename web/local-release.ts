// The local helper's release as the page shows it (docs/plans/networking-local.md §1 "Plain install lines"): its version,
// the published SHA-256 of each binary, and the install lines for a platform, the same as the release's INSTALL.md
// (waarm64-net's build.sh `install`; tests/local-release.test.ts holds the two together). Each release replaces
// `RELEASE` from its SHA256SUMS (a change of waarm64's, separate from the release itself).

export type Os = 'linux' | 'darwin' | 'windows';
export type Arch = 'amd64' | 'arm64';
export type Target = { os: Os; arch: Arch };
export type Release = { version: string; /** SHA256SUMS: file name to hash. */ sums: Record<string, string> };

/** The release the page offers: its SHA256SUMS, from github.com/gbl08ma/waarm64-net/releases (built twice there, and matched). */
export const RELEASE: Release = {
  version: 'v0.3.0',
  sums: {
    'LICENSES.txt': '871505601d614f0107098be41f93f10ea69e9d29bfc1bce9eae659aa8a32993f',
    'waarm64-net-v0.3.0-darwin-amd64': '4ac08fd59f906e6b4d526786a7e95f1727a2ba15349fb534bd68974365f0a0f7',
    'waarm64-net-v0.3.0-darwin-arm64': '8d2e335d07f83282a2cce14ed58e6fc638d270c5713a156f9c5edc3dc4ceb69a',
    'waarm64-net-v0.3.0-linux-amd64': '6a5aa7a9c6baedca8c555f12b8ef8b0cec4af3c2a0e5a5d3b7792580ff643908',
    'waarm64-net-v0.3.0-linux-arm64': '439d3efd180aeb10762cc30d393b1aa8969f8e309624e929db1220a0df4d349f',
    'waarm64-net-v0.3.0-windows-amd64.exe': 'b69e9032b81e50fff4ac3cedbee931308baf2ed086d710e0424de225d21476e1',
    'waarm64-net-v0.3.0-windows-arm64.exe': 'b23a420e78f6865f30b58f522c91237fb643911ce60146c4ed89d4f45facdc8e',
  },
};

export const TARGETS: Target[] = [
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'windows', arch: 'amd64' },
  { os: 'windows', arch: 'arm64' },
];

export const SOURCE = 'https://github.com/gbl08ma/waarm64-net';
const download = (version: string) => `https://github.com/gbl08ma/waarm64-net/releases/download/${version}`;

export const targetName = (t: Target) =>
  `${{ linux: 'Linux', darwin: 'macOS', windows: 'Windows' }[t.os]}, ${t.arch === 'amd64' ? 'x86-64' : 'ARM'}`;
const fileOf = (r: Release, t: Target) =>
  `waarm64-net-${r.version}-${t.os}-${t.arch}${t.os === 'windows' ? '.exe' : ''}`;

/** The install lines for `t` (a shell's, or PowerShell's on Windows): download, check the hash, mark it executable, run it. */
export function installLines(r: Release, t: Target): string {
  const file = fileOf(r, t);
  const sum = r.sums[file] ?? '';
  if (t.os === 'windows') {
    return [
      `$d = "$env:LOCALAPPDATA\\Programs\\waarm64-net"; New-Item -ItemType Directory -Force $d | Out-Null; $ProgressPreference = 'SilentlyContinue'`,
      `Invoke-WebRequest ${download(r.version)}/${file} -OutFile "$d\\waarm64-net.exe"`, // i18n-ignore: a PowerShell command
      `if ((Get-FileHash "$d\\waarm64-net.exe").Hash -ne '${sum}') { Remove-Item "$d\\waarm64-net.exe"; throw 'not the published hash' }`,
      `& "$d\\waarm64-net.exe"`,
    ].join('\n');
  }
  return [
    'mkdir -p ~/.local/bin',
    `curl -fLo ~/.local/bin/waarm64-net ${download(r.version)}/${file}`,
    `echo "${sum}  $HOME/.local/bin/waarm64-net" | ${t.os === 'darwin' ? 'shasum -a 256 -c' : 'sha256sum -c'} || rm ~/.local/bin/waarm64-net`,
    'chmod +x ~/.local/bin/waarm64-net',
    '~/.local/bin/waarm64-net',
  ].join('\n');
}

/** The release's SHA256SUMS text parsed. */
export function parseSums(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split('\n').flatMap((l) => {
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l.trim());
      return m ? [[m[2], m[1]]] : [];
    }),
  );
}

type UAData = { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; architecture?: string }> };

/** This browser's platform and architecture, where it says (Chromium's client hints; else the user agent's guess). */
export async function thisTarget(
  nav: { userAgentData?: UAData; userAgent: string } = navigator as never,
): Promise<Target | undefined> {
  let platform = '',
    arch = '';
  try {
    const v = await nav.userAgentData?.getHighEntropyValues(['platform', 'architecture']);
    [platform, arch] = [v?.platform ?? '', v?.architecture ?? ''];
  } catch {
    /* no client hints */
  }
  const ua = nav.userAgent;
  const os: Os | undefined = /mac/i.test(platform || ua)
    ? 'darwin'
    : /win/i.test(platform || ua)
      ? 'windows'
      : /linux|x11|cros/i.test(platform || ua)
        ? 'linux'
        : undefined;
  if (!os) return undefined;
  // Without client hints a Mac is assumed ARM (every Mac since 2020 and the user agent says Intel either way).
  const a: Arch = arch
    ? /arm/i.test(arch)
      ? 'arm64'
      : 'amd64'
    : os === 'darwin' || /aarch64|arm/i.test(ua)
      ? 'arm64'
      : 'amd64';
  return { os, arch: a };
}
