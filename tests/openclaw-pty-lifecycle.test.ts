import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { assertOAuthCallbackAvailable } from "@/lib/openclaw/application/oauth-callback-availability";

test("PTY provides a real terminal, preserves literal arguments and accepts a manual callback", {
  skip: process.platform !== "darwin" && process.platform !== "linux",
  timeout: 10_000
}, async () => {
  const literalArgument = "agent with spaces; $(not-a-command) 'quoted'";
  const child = spawn("/usr/bin/python3", [
    "scripts/openclaw-pty-runner.py", process.execPath, "-e",
    "console.log(JSON.stringify({tty: Boolean(process.stdin.isTTY && process.stdout.isTTY), arg: process.argv[1]})); process.stdin.once('data', value => { console.log('received:' + String(value).trim()); process.exit(0); });",
    literalArgument
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  let output = "";
  let sent = false;
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    if (!sent && output.includes('"tty":true')) {
      sent = true;
      child.stdin.write("http://localhost:1455/auth/callback?code=test&state=test\n");
    }
  });
  try {
    const [code] = await closed;
    assert.equal(code, 0);
    assert.ok(output.includes(JSON.stringify({ tty: true, arg: literalArgument })));
    assert.match(output, /received:http:\/\/localhost:1455\/auth\/callback\?code=test&state=test/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
});

for (const exitCode of [0, 7]) {
  test(`PTY preserves natural exit ${exitCode} after final output`, {
    skip: process.platform !== "darwin" && process.platform !== "linux",
    timeout: 10_000
  }, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const child = spawn("/usr/bin/python3", [
        "scripts/openclaw-pty-runner.py", process.execPath, "-e",
        `process.stdout.write('command finished\\n'); process.exit(${exitCode})`
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { errors += String(chunk); });
      const [code] = await once(child, "close");
      assert.equal(code, exitCode, errors);
      assert.match(output, /command finished/);
      assert.equal(errors, "");
    }
  });
}

test("occupied callback port blocks a new OAuth attempt until released", async () => {
  const server = createServer((socket) => socket.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(assertOAuthCallbackAvailable(address.port), /Another sign-in/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assertOAuthCallbackAvailable(address.port);
});

for (const termination of ["SIGTERM", "owner-pipe-closed"] as const) {
  test(`PTY ${termination} releases a real descendant callback listener`, {
    skip: process.platform !== "darwin" && process.platform !== "linux",
    timeout: 10_000
  }, async () => {
    // The listener ignores TERM to exercise escalation, not just cooperative exit.
    const listener = "import signal,socket,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1],flush=True); time.sleep(60)";
    const wrapper = `import signal,subprocess; signal.signal(signal.SIGTERM,signal.SIG_IGN); subprocess.run(['/usr/bin/python3','-c',${JSON.stringify(listener)}])`;
    const child = spawn("/usr/bin/python3", ["scripts/openclaw-pty-runner.py", "/usr/bin/python3", "-c", wrapper], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const closed = once(child, "close");
    try {
      const [chunk] = await once(child.stdout, "data");
      const port = Number(String(chunk).trim());
      assert.ok(port > 0);
      await assert.rejects(assertOAuthCallbackAvailable(port), /Another sign-in/);
      if (termination === "SIGTERM") child.kill("SIGTERM");
      else child.stdin.end();
      await closed;
      await assertOAuthCallbackAvailable(port);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
    }
  });
}
