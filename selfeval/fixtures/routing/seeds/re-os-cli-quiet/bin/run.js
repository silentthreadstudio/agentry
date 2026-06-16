#!/usr/bin/env node
// A small hand-rolled CLI. Parses --help and --target.
// On every run it prints a banner to stdout before doing its work.

const BANNER = [
  "buildtool 2.0.1",
  "----------------",
].join("\n");

function parseArgs(argv) {
  const opts = { help: false, target: "all" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--target") {
      opts.target = argv[++i] ?? opts.target;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }
  return opts;
}

function printBanner() {
  process.stdout.write(BANNER + "\n");
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: buildtool [options]",
      "",
      "Options:",
      "  --target <name>   What to build (default: all)",
      "  --help, -h        Show this help",
    ].join("\n") + "\n",
  );
}

function run(target) {
  // Pretend to do the build. Progress lines go to stdout.
  process.stdout.write(`building ${target}...\n`);
  process.stdout.write("done\n");
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  printBanner();
  run(opts.target);
  process.exit(0);
}

main(process.argv.slice(2));
