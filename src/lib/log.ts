/** Tiny transcript logger: colored console output, optionally teed (without ANSI codes) to a file. */
import fs from "node:fs";
import path from "node:path";

const ANSI = /\x1b\[[0-9;]*m/g;
let sink: fs.WriteStream | null = null;

export function teeTo(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  sink = fs.createWriteStream(file, { flags: "w" });
}
export async function closeTee() {
  if (!sink) return;
  await new Promise<void>((r) => sink!.end(r));
  sink = null;
}

export function log(line = "") {
  console.log(line);
  sink?.write(line.replace(ANSI, "") + "\n");
}

export const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

export function section(title: string) {
  log("");
  log(c.bold(`━━━ ${title} ${"━".repeat(Math.max(0, 70 - title.length))}`));
}
