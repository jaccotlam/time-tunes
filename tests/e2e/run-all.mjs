// Runs every end-to-end script in sequence. Screenshots/PDF go to tests/e2e/out/ (or $E2E_OUT).
const suites = ['screens', 'card-flow', 'scanner', 'digital', 'bingo', 'print', 'pwa', 'spotify', 'playlists', 'playlists-spotify', 'playlists-top', 'multi', 'multi-playlist', 'multi-server', 'multi-server-playlist', 'multi-quiz', 'multi-mix'];
let failed = 0;
for (const name of suites) {
  console.log(`\n# ${name}`);
  try {
    const mod = await import(`./${name}.e2e.mjs`);
    await mod.default();
  } catch (e) {
    failed++;
    console.error(`FAILED ${name}:`, e.message);
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nall e2e suites passed');
process.exit(failed ? 1 : 0);
