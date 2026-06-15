#!/usr/bin/env node
// A small hand-rolled CLI. Parses --help and --name. There is no --version flag yet.

function parseArgs(argv) {
  const opts = { help: false, name: "world" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--name") {
      opts.name = argv[++i] ?? opts.name;
    } else {
      process.stderr.write(`unknown flag: ${arg}\n`);
      process.exit(1);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: greet [options]",
      "",
      "Options:",
      "  --name <name>   Who to greet (default: world)",
      "  --help, -h      Show this help",
    ].join("\n") + "\n",
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  process.stdout.write(`Hello, ${opts.name}!\n`);
  process.exit(0);
}

main(process.argv.slice(2));
