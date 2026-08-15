const WORKER_BUNDLE_SENTINEL_KIB = 4198;

const wrangler = Bun.spawn([
  "bunx",
  "wrangler",
  "deploy",
  "--dry-run",
  "--outdir",
  ".wrangler-dry-run",
  "--config",
  "wrangler.jsonc",
], {
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(wrangler.stdout).text(),
  new Response(wrangler.stderr).text(),
  wrangler.exited,
]);

process.stdout.write(stdout);
process.stderr.write(stderr);

if (exitCode !== 0) process.exit(exitCode);

const match = stdout.match(
  /Total Upload:\s+([0-9]+(?:\.[0-9]+)?) KiB\s+\/\s+gzip:\s+([0-9]+(?:\.[0-9]+)?) KiB/,
);
if (!match) {
  console.error("Cloudflare Worker bundle size was not reported by Wrangler.");
  process.exit(1);
}

const totalUploadKiB = Number(match[1]);
const gzipKiB = Number(match[2]);
if (!Number.isFinite(totalUploadKiB) || !Number.isFinite(gzipKiB)) {
  console.error("Cloudflare Worker bundle size was not a finite numeric measurement.");
  process.exit(1);
}

const marginKiB = WORKER_BUNDLE_SENTINEL_KIB - totalUploadKiB;
console.log(
  `::notice title=Cloudflare Worker bundle::total_upload_kib=${totalUploadKiB.toFixed(2)} gzip_kib=${gzipKiB.toFixed(2)} sentinel_kib=${WORKER_BUNDLE_SENTINEL_KIB} margin_kib=${marginKiB.toFixed(2)}`,
);

if (totalUploadKiB >= WORKER_BUNDLE_SENTINEL_KIB) {
  console.error(
    `Cloudflare Worker bundle ${totalUploadKiB.toFixed(2)} KiB is at or above the ${WORKER_BUNDLE_SENTINEL_KIB} KiB repository sentinel.`,
  );
  process.exit(1);
}
