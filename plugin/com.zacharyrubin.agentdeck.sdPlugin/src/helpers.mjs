// Child-process plumbing shared by apps.mjs and power.mjs: one-shot commands,
// small Swift helpers compiled on first use, and long-lived children that get
// restarted if they die.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run a command; resolves with its stdout, rejects with the first line of the error. */
export function run(cmd, args, timeout = 15_000) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message.split("\n")[0]}${stderr ? `: ${String(stderr).trim().split("\n")[0]}` : ""}`)) : resolve(stdout)),
  );
}

/**
 * Path to the compiled form of a Swift helper (`src`, a .swift file),
 * compiling it on first use (or after the source changes) into
 * ~/Library/Caches/agent-deck. Needs the Xcode command line tools; rejects if
 * they're missing.
 */
export async function swiftHelper(src) {
  const hash = crypto.createHash("sha1").update(fs.readFileSync(src)).digest("hex").slice(0, 12);
  const dir = path.join(os.homedir(), "Library/Caches/agent-deck");
  const bin = path.join(dir, `${path.basename(src, ".swift")}-${hash}`);
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  const swiftc = fs.existsSync("/usr/bin/swiftc") ? "/usr/bin/swiftc" : "swiftc";
  await run(swiftc, ["-O", "-o", tmp, src], 180_000);
  fs.renameSync(tmp, bin);
  return bin;
}

/**
 * Run a long-lived child and feed its stdout lines to onLine. If it dies it is
 * started again after 1 s, waiting twice as long after each quick failure (up
 * to a minute); onRestart() runs after each restart. Returns { stop, write }:
 * stop() ends it for good; with `stdin: true`, write(line) sends it a line, and
 * stop() closes its stdin first so it can tidy up (killed a second later).
 */
export function supervise({ name, cmd, args = [], onLine, onRestart = () => {}, log = () => {}, now = () => Date.now(), stdin = false }) {
  let stopped = false;
  let child = null;
  let timer = null;
  const launch = (delay) => {
    const started = now();
    child = spawn(cmd, args, { stdio: [stdin ? "pipe" : "ignore", "pipe", "ignore"] });
    child.stdin?.on("error", () => {}); // a dead child's pipe: the exit handler restarts it
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    let done = false;
    const restart = (why) => {
      if (done || stopped) return;
      done = true;
      const next = now() - started > 60_000 ? 1000 : Math.min(delay * 2, 60_000);
      log(`${name} ${why}; restarting in ${delay} ms`);
      timer = setTimeout(() => {
        if (stopped) return;
        launch(next);
        onRestart();
      }, delay);
    };
    child.on("error", (err) => restart(`failed (${err.message})`));
    child.on("exit", (code, sig) => restart(`exited (${sig || code})`));
  };
  launch(1000);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (!stdin) return child?.kill();
      const c = child;
      c?.stdin.end();
      setTimeout(() => c?.kill(), 1000).unref();
    },
    write(line) {
      if (!child?.stdin?.writable) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
  };
}
