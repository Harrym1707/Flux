/**
 * The FLUX client runtime — the commands a downloaded user actually runs.
 *
 * Deliberately NOT `analyse`: that local-analysis dev tool pulls in the traffic
 * ingest, router, triage and observability-adapter code a client never needs,
 * and has no business shipping in a download. Keeping this entry lean keeps the
 * runtime bundle to the client surface: proxy + reducer + ledger + Theo.
 *
 * This is what scripts/build-cli-package.ts bundles into /flux-runtime; the
 * small /flux bootstrap fetches, caches, verifies and execs it.
 */
const TOP_USAGE = `flux — cut your LLM bill, verified on your own usage.

Usage: flux <command> [options]

  start      Start the FLUX proxy, point Claude Code at it, and run Theo
             alongside you. One command; reverts cleanly on exit.
  install    Always-on: run FLUX as a background service so every Claude Code
             session is optimised, with nothing to start by hand.
  uninstall  Stop and remove the background service; restore Claude Code.
  status     Is the service up, and what has Theo saved so far?
  verify     Re-prove FLUX's claims on this machine: the build's provenance,
             your ledger's hash-chain, and a deterministic invoice recompute.

Run "flux <command> --help" for command options.`;

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "start") {
    await (await import("./start.js")).runStart(process.argv.slice(3));
  } else if (sub === "serve") {
    await (await import("./start.js")).runServe(process.argv.slice(3));
  } else if (sub === "install") {
    await (await import("./daemon.js")).runInstall(process.argv.slice(3));
  } else if (sub === "uninstall") {
    (await import("./daemon.js")).runUninstall(process.argv.slice(3));
  } else if (sub === "status") {
    await (await import("./daemon.js")).runStatus(process.argv.slice(3));
  } else if (sub === "verify") {
    await (await import("./verify.js")).runVerify(process.argv.slice(3));
  } else {
    console.log(TOP_USAGE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
