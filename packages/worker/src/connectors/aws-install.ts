import { execFile } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { findCommand } from "../managed-tools.js";

/**
 * Installs AWS CLI v2 for the worker's own user with AWS's official
 * installer (docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
 * never with sudo. The layout is the one AWS's user-level install script
 * uses: the program in ~/.local/share/aws-cli, `aws` and `aws_completer`
 * linked in ~/.local/bin, so the person's terminal finds it too. Linux runs
 * the zip's `install` with --install-dir/--bin-dir (and --update over an
 * earlier copy); macOS runs the pkg for the current user with a
 * customLocation choice and links the programs as AWS documents. A link in
 * Foundry's tools makes sessions find this copy first. Downloads go through
 * the device's HTTP(S)_PROXY settings; the zip's PGP signature is checked
 * against AWS's published key when gpg is on the device, the pkg's Apple
 * signature always. The result is verified with `aws --version`.
 */

export interface AwsInstallResult {
  /** The `aws` sessions run (Foundry's link). */
  path: string;
  version: string;
}

export interface AwsInstallOptions {
  /** Foundry's tools folder that sessions search first. */
  managedBin: string;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Downloads `url` into `file`; tests replace it. */
  download?: (url: string, file: string) => Promise<void>;
  /** Runs a program; tests replace it. */
  run?: (
    command: string,
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Finds a program on the device; tests replace it. */
  which?: (name: string) => string | undefined;
}

const origin = "https://awscli.amazonaws.com";
const maxDownloadBytes = 400 * 1024 * 1024;
// AWS CLI Team <aws-cli@amazon.com>, as published in the install guide.
const signingFingerprint = "FB5DB77FD5C118B80511ADA8A6310ACC4672475C";
const signingKey = `
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
akV0ygUJDqP4lQAKCRCmMQrMRnJHXFHjD/9eyZLYcKuQOlLvtqSDtUBiEZf6ZZjM
i3ygYH8rJNtuToUH+HvSpe819urJCquXhDrlK6N+aqW0hCLtNABJG/vsafIgvIYJ
hSGgpgtNnQyMV1jViRWqPjbouw8OkYKBThUfT1i2Y+wn58ifs6ODBCmTexWtXspA
Si+Gt49xDOW0APmbOPnI+a4HJW6tVEo6MWS0WjzpiBayR3d1A4pt4YrPfSdDgpLo
h2SLQqlRqvvVZJaWBjhkErNFpfsBA06sDcPEOb0G8LBUbR4WOcdvhe5LubJbZuxC
AG9kNPCVeQP1ixwjgjXKysaxeQ6rv0VzIQgRp6tLVLWhy6AKDNvLjFSsmXZ1Wl08
Y/RlOHXlzLuQMRE6sR1wOdRxc9TsrNWTGiBK65cvSWOy03JeBkQQ8pesqltiyxI9
U21kkgiXtTSKNGfKK8pO27D81YANhRqPK7iTp6kuFiY2WtOg90KTMNlIT+Ff85Y2
b1rHj6Z0SrCkJujhWk3IBPic/wJgz01LEc/OAdUPlby90RJZcIBhSlWhT7mXnXIO
c0HWlNQrns2s3CTyYwZSiSlYe9ApeLwhjDo8NhbFuCAy61l6O5UsR4AfZxx/rGKv
2wFb1/RN/P4gNe6vmxZAPjR0AQcwD3tc2McimOLr/22kmPz8IH3I0X7WoSFr0Biz
E91G7bb0hOb/cA==
=knv7
-----END PGP PUBLIC KEY BLOCK-----
`;

/** Where the user-level install puts AWS CLI, under `home`. */
export function awsInstallPaths(home: string): {
  installDir: string;
  binDir: string;
} {
  return {
    installDir: join(home, ".local", "share", "aws-cli"),
    binDir: join(home, ".local", "bin"),
  };
}

function defaultRun(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failed = error as (Error & { code?: unknown }) | null;
        resolveRun({
          stdout: String(stdout ?? ""),
          stderr: String(stderr || failed?.message || ""),
          code: failed
            ? typeof failed.code === "number"
              ? failed.code
              : 1
            : 0,
        });
      },
    );
  });
}

async function defaultDownload(url: string, file: string): Promise<void> {
  if (!url.startsWith(`${origin}/`))
    throw new Error(`refusing to download from ${new URL(url).origin}`);
  let response;
  try {
    response = await undiciFetch(url, {
      dispatcher: new EnvHttpProxyAgent(),
      signal: AbortSignal.timeout(8 * 60_000),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    throw new Error(
      `could not download ${url}: ${cause?.message ?? (error as Error).message}`,
    );
  }
  if (!response.ok || !response.body)
    throw new Error(`could not download ${url}: HTTP ${response.status}`);
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(
        size > maxDownloadBytes ? new Error("download is too large") : null,
        chunk,
      );
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    limit,
    createWriteStream(file, { mode: 0o600 }),
  );
}

/** The first meaningful line of a failed command, as a reason. */
function reason(result: { stdout: string; stderr: string }): string {
  return (
    `${result.stderr}\n${result.stdout}`
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 240) ?? "no output"
  );
}

/** `~/…` for a path under home, for messages a person reads. */
function shown(path: string, home: string): string {
  return path.startsWith(`${home}/`)
    ? `~/${path.slice(home.length + 1)}`
    : path;
}

/**
 * Refuses to replace a program in ~/.local/bin that is not this install's
 * link (pip's AWS CLI v1 lives there): the person decides what to remove.
 */
function checkBinFree(
  name: string,
  binDir: string,
  installDir: string,
  home: string,
) {
  const entry = join(binDir, name);
  let stat;
  try {
    stat = lstatSync(entry);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = resolve(binDir, readlinkSync(entry));
    if (target === installDir || target.startsWith(`${installDir}/`)) return;
    if (!existsSync(entry)) return;
  }
  throw new Error(
    `${shown(entry, home)} is another AWS CLI. Remove it (for version 1 from pip: pip uninstall awscli), then install again.`,
  );
}

/** Points `<folder>/<name>` at target, replacing an earlier link only. */
function link(folder: string, name: string, target: string): void {
  mkdirSync(folder, { recursive: true });
  const entry = join(folder, name);
  const staging = `${entry}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  renameSync(staging, entry);
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function installAwsCli(
  options: AwsInstallOptions,
): Promise<AwsInstallResult> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? defaultRun;
  const which = options.which ?? ((name: string) => findCommand(name));
  const download = options.download ?? defaultDownload;
  const { installDir, binDir } = awsInstallPaths(home);
  if (/\s/.test(installDir))
    throw new Error(
      "AWS's installer cannot use a home folder whose path contains spaces.",
    );
  for (const name of ["aws", "aws_completer"])
    checkBinFree(name, binDir, installDir, home);
  const scratch = mkdtempSync(join(tmpdir(), "foundry-aws-cli-"));
  try {
    if (platform === "linux") {
      const machine =
        arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : "";
      if (!machine)
        throw new Error(`AWS CLI v2 has no Linux installer for ${arch}.`);
      const unzip = which("unzip");
      if (!unzip)
        throw new Error(
          "AWS's installer needs unzip, which this device does not have. Install it (for example sudo apt install unzip), then install again.",
        );
      const url = `${origin}/awscli-exe-linux-${machine}.zip`;
      const zip = join(scratch, "awscliv2.zip");
      await download(url, zip);
      const gpg = which("gpg");
      if (gpg) await verifySignature(gpg, url, zip, scratch, run, download);
      const unzipped = await run(unzip, ["-q", zip, "-d", scratch], {
        timeoutMs: 180_000,
      });
      if (unzipped.code !== 0)
        throw new Error(`could not unpack the installer: ${reason(unzipped)}`);
      const args = ["--install-dir", installDir, "--bin-dir", binDir];
      if (existsSync(join(installDir, "v2", "current"))) args.push("--update");
      mkdirSync(binDir, { recursive: true });
      const installed = await run(join(scratch, "aws", "install"), args, {
        timeoutMs: 300_000,
      });
      if (installed.code !== 0)
        throw new Error(`AWS's installer failed: ${reason(installed)}`);
    } else if (platform === "darwin") {
      const url = `${origin}/AWSCLIV2.pkg`;
      const pkg = join(scratch, "AWSCLIV2.pkg");
      await download(url, pkg);
      const signature = await run("/usr/sbin/pkgutil", [
        "--check-signature",
        pkg,
      ]);
      if (signature.code !== 0 || !/Amazon/.test(signature.stdout))
        throw new Error(
          "the downloaded AWS CLI package is not signed by Amazon; nothing was installed.",
        );
      const parent = join(home, ".local", "share");
      mkdirSync(parent, { recursive: true });
      const choices = join(scratch, "choices.xml");
      writeFileSync(
        choices,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <array>
    <dict>
      <key>choiceAttribute</key>
      <string>customLocation</string>
      <key>attributeSetting</key>
      <string>${xmlText(parent)}</string>
      <key>choiceIdentifier</key>
      <string>default</string>
    </dict>
  </array>
</plist>
`,
      );
      const installed = await run(
        "/usr/sbin/installer",
        [
          "-pkg",
          pkg,
          "-target",
          "CurrentUserHomeDirectory",
          "-applyChoiceChangesXML",
          choices,
        ],
        { timeoutMs: 300_000 },
      );
      if (installed.code !== 0)
        throw new Error(`the macOS installer failed: ${reason(installed)}`);
      link(binDir, "aws", join(installDir, "aws"));
      link(binDir, "aws_completer", join(installDir, "aws_completer"));
    } else {
      throw new Error(
        `Foundry installs AWS CLI on Linux and macOS, not ${platform}.`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const program = join(binDir, "aws");
  const checked = await run(program, ["--version"], { timeoutMs: 60_000 });
  const version = /aws-cli\/(\d+\.\d+\.\d+)/.exec(
    `${checked.stdout} ${checked.stderr}`,
  )?.[1];
  if (checked.code !== 0 || !version || !version.startsWith("2."))
    throw new Error(
      `AWS CLI was installed but ${shown(program, home)} --version failed: ${reason(checked)}`,
    );
  link(options.managedBin, "aws", program);
  return { path: join(options.managedBin, "aws"), version };
}

/** Checks the zip against AWS's signing key, in a throwaway keyring. */
async function verifySignature(
  gpg: string,
  url: string,
  zip: string,
  scratch: string,
  run: NonNullable<AwsInstallOptions["run"]>,
  download: NonNullable<AwsInstallOptions["download"]>,
): Promise<void> {
  const signature = `${zip}.sig`;
  await download(`${url}.sig`, signature);
  const keyring = join(scratch, "gnupg");
  mkdirSync(keyring, { mode: 0o700 });
  const key = join(scratch, "aws-cli.asc");
  writeFileSync(key, signingKey.trim() + "\n");
  const imported = await run(gpg, [
    "--batch",
    "--homedir",
    keyring,
    "--import",
    key,
  ]);
  if (imported.code !== 0)
    throw new Error(`could not load AWS's signing key: ${reason(imported)}`);
  // VALIDSIG names the primary key's fingerprint last; it is printed for a
  // good signature whatever the local trust in the key.
  const verified = await run(gpg, [
    "--batch",
    "--homedir",
    keyring,
    "--status-fd",
    "1",
    "--verify",
    signature,
    zip,
  ]);
  const good = verified.stdout
    .split("\n")
    .some(
      (line) =>
        line.startsWith("[GNUPG:] VALIDSIG ") &&
        line.trim().endsWith(` ${signingFingerprint}`),
    );
  if (!good)
    throw new Error(
      "the downloaded AWS CLI installer does not carry AWS's signature; nothing was installed.",
    );
}
