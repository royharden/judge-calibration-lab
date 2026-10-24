/** Explicit download-only utility; never called by imports, eval, app or answer data.
 * No assumed dataset endpoint, credential or licence grant. Future owner command:
 * npx tsx scripts/fetch-real-set.ts --url https://... --dest <new-file> 
 *   --license-ack I-verified-dataset-and-source-licences
 * The acknowledgement includes annotator overlap and source/article rights. It
 * records an operator assertion; the utility cannot establish legal permission.
 * HTTPS:443 only; public IPv4 pinned after DNS resolution; no redirects, cookies,
 * proxy, auth, extraction, conversion, provider calls or automatic import.
 */
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { open, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const LICENSE_ACK = 'I-verified-dataset-and-source-licences';
export const MAX_BYTES = 50 * 1024 * 1024;
export const TIMEOUT_MS = 30000;
/** Conservative public IPv4 allow rule: excludes local, metadata, reserved,
 * carrier NAT, documentation, benchmark, multicast and future-use blocks.
 * IPv6-only hosts are deliberately unsupported rather than risk IPv4-mapped,
 * translated or scoped addresses reaching private infrastructure.
 */
export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  const a = octets[0]!; const b = octets[1]!; const c = octets[2]!;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}
export function downloadArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]; const next = args[++i];
    if (flag === undefined || !['--url', '--dest', '--license-ack'].includes(flag) || !next || next.startsWith('--') || values.has(flag)) throw new Error('use --url <explicit-https-url> --dest <new-local-file> --license-ack I-verified-dataset-and-source-licences (each exactly once)');
    values.set(flag, next);
  }
  if (!values.get('--url') || !values.get('--dest') || values.get('--license-ack') !== LICENSE_ACK) throw new Error('explicit URL, destination and exact licence acknowledgement required; verify dataset/source licences and annotator overlap first');
  const url = new URL(values.get('--url')!);
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password || url.hash) throw new Error('URL must be HTTPS:443 without credentials or fragment; redirects are refused');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal') || url.hostname.endsWith('.') || url.hostname.includes(':') || !url.hostname.includes('.')) throw new Error('URL must name a public IPv4-capable host; local/private/metadata and IPv6 destinations are refused');
  if (isIP(url.hostname) !== 0 && !isPublicIPv4(url.hostname)) throw new Error('private, metadata or reserved IP destination refused');
  return { url, dest: resolve(values.get('--dest')!), acknowledgement: LICENSE_ACK };
}
export async function main(args: readonly string[]) {
  const opts = downloadArgs(args);
  // Require an existing directory; do not create arbitrary directory trees.
  if (!(await stat(dirname(opts.dest))).isDirectory()) throw new Error('destination parent must be an existing directory');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const records = await Promise.race([
      lookup(opts.url.hostname, { all: true, family: 4 }),
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('download/DNS deadline exceeded')), { once: true })),
    ]);
    if (records.length === 0 || records.some((r) => !isPublicIPv4(r.address))) throw new Error('DNS resolves to a private, metadata, reserved or unsupported address; download refused');
    const pinnedAddress = records[0]!.address;
    // Exclusive create: existing files/symlinks cannot be overwritten. A partial
    // file is intentionally retained and explicitly reported on failure.
    file = await open(opts.dest, 'wx');
    const response = await new Promise<import('node:http').IncomingMessage>((accept, reject) => {
      const req = request({ protocol: 'https:', hostname: pinnedAddress, servername: opts.url.hostname,
        port: 443, method: 'GET', path: opts.url.pathname + opts.url.search,
        headers: { Host: opts.url.host, 'User-Agent': 'judge-calibration-lab-download/0.1', 'Accept-Encoding': 'identity' },
        signal: controller.signal }, accept);
      req.once('error', reject);
      req.end();
    });
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`HTTP ${String(response.statusCode)}; only 200 accepted, redirects refused (verify a direct public download URL)`); }
    if (response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity') { response.destroy(); throw new Error('compressed HTTP body refused; provide a direct unencoded file'); }
    const declared = response.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) { response.destroy(); throw new Error(`content-length invalid or exceeds ${MAX_BYTES} bytes`); }
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > MAX_BYTES) { response.destroy(); throw new Error(`body exceeds ${MAX_BYTES} bytes; partial destination retained`); }
      hash.update(buffer);
      await file.writeFile(buffer);
    }
    if (bytes === 0 || (declared !== undefined && bytes !== Number(declared))) throw new Error('empty or truncated download; partial destination retained');
    await file.sync();
    console.log(JSON.stringify({ status: 'downloaded-only', destination: opts.dest, bytes, sha256: hash.digest('hex'), host: opts.url.hostname, acknowledgement: opts.acknowledgement, warning: 'Not imported or licence-verified by code; inspect and adapt locally before use. No dataset is shipped by the project.' }, null, 2));
  } finally {
    clearTimeout(timer);
    await file?.close();
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { console.error(`fetch-real-set: ${error instanceof Error ? error.message : String(error)}. Any partial destination is retained; inspect it and choose a new --dest before retrying.`); process.exitCode = 1; });
}
