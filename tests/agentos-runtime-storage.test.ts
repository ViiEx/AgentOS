import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  prepareAgentOsRuntimeStorage,
  readAgentOsStoragePreparation,
  resolveAgentOsMissionControlRoot
} from "@/lib/agentos/runtime-storage";

function testEnv(values: Record<string, string> = {}) {
  return { NODE_ENV: "test", ...values } as NodeJS.ProcessEnv;
}

test("mission-control storage preserves source, Railway and explicit roots while relocating packaged state", () => {
  const cwd = path.join(os.tmpdir(), "agentos-source");
  assert.equal(resolveAgentOsMissionControlRoot(testEnv(), cwd), path.join(cwd, ".mission-control"));
  assert.equal(
    resolveAgentOsMissionControlRoot(testEnv({ AGENTOS_PACKAGE_RUNTIME: "1" }), cwd),
    path.join(os.homedir(), ".agentos", "mission-control")
  );
  assert.equal(
    resolveAgentOsMissionControlRoot(testEnv({ AGENTOS_PACKAGE_RUNTIME: "1", AGENTOS_RUNTIME_DIR: "/var/lib/agentos" }), cwd),
    "/var/lib/agentos/mission-control"
  );
  assert.equal(
    resolveAgentOsMissionControlRoot(testEnv({ AGENTOS_DEPLOYMENT_PLATFORM: "railway" }), cwd),
    path.join(cwd, ".mission-control")
  );
  assert.equal(
    resolveAgentOsMissionControlRoot(testEnv({ AGENTOS_MISSION_CONTROL_ROOT: "/data/agentos/mission-control" }), cwd),
    "/data/agentos/mission-control"
  );
});

test("Linux desktop state is writable outside a read-only installed application", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentos-linux-storage-"));
  const cwd = path.join(root, "usr", "lib", "AgentOS", "agentos-runtime", "agentos");
  const runtime = path.join(root, "user-data", "app.sapienx.agentos");
  const env = testEnv({ AGENTOS_DESKTOP: "1", AGENTOS_PACKAGE_RUNTIME: "1", AGENTOS_RUNTIME_DIR: runtime });
  try {
    await mkdir(cwd, { recursive: true });
    await chmod(cwd, 0o555);
    const result = await prepareAgentOsRuntimeStorage({ env, cwd });
    assert.equal(result.status, "ready");
    const target = resolveAgentOsMissionControlRoot(env, cwd);
    assert.equal(target, path.join(runtime, "mission-control"));
    await writeFile(path.join(target, "settings.json"), "{}", { mode: 0o600 });
    assert.deepEqual(await readdir(cwd), []);
    if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o700);
  } finally {
    await chmod(cwd, 0o755);
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged storage migration copies and verifies data, retains the original, and is replay-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentos-storage-migration-"));
  const cwd = path.join(root, "replaceable", "agentos");
  const runtime = path.join(root, "persistent", "runtime");
  const legacy = path.join(cwd, ".mission-control");
  const env = testEnv({ AGENTOS_PACKAGE_RUNTIME: "1", AGENTOS_RUNTIME_DIR: runtime });

  try {
    await mkdir(path.join(legacy, "channels"), { recursive: true });
    await writeFile(path.join(legacy, "channels", "registry.json"), "{\"channels\":[]}");
    const first = await prepareAgentOsRuntimeStorage({ env, cwd });
    assert.equal(first.status, "migrated");
    assert.equal(await readFile(path.join(runtime, "mission-control", "channels", "registry.json"), "utf8"), "{\"channels\":[]}");
    assert.equal(await readFile(path.join(legacy, "channels", "registry.json"), "utf8"), "{\"channels\":[]}");
    assert.deepEqual(await readAgentOsStoragePreparation(env), first);

    const replay = await prepareAgentOsRuntimeStorage({ env, cwd });
    assert.equal(replay.status, "migrated");

    await writeFile(path.join(runtime, "mission-control", "channels", "registry.json"), "{\"channels\":[\"new\"]}");
    const restarted = await prepareAgentOsRuntimeStorage({ env, cwd });
    assert.equal(restarted.status, "migrated");
    assert.equal(resolveAgentOsMissionControlRoot(env, cwd), path.join(runtime, "mission-control"));
    assert.equal(await readFile(path.join(runtime, "mission-control", "channels", "registry.json"), "utf8"), "{\"channels\":[\"new\"]}");
    assert.equal(await readFile(path.join(legacy, "channels", "registry.json"), "utf8"), "{\"channels\":[]}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration refuses to merge conflicting roots and continues reading the intact legacy copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentos-storage-conflict-"));
  const cwd = path.join(root, "app");
  const runtime = path.join(root, "runtime");
  const legacy = path.join(cwd, ".mission-control");
  const target = path.join(runtime, "mission-control");
  const env = testEnv({ AGENTOS_PACKAGE_RUNTIME: "1", AGENTOS_RUNTIME_DIR: runtime });

  try {
    await mkdir(legacy, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(legacy, "state.json"), "legacy");
    await writeFile(path.join(target, "state.json"), "persistent");
    const result = await prepareAgentOsRuntimeStorage({ env, cwd });

    assert.equal(result.status, "conflict");
    assert.equal(resolveAgentOsMissionControlRoot(env, cwd), legacy);
    assert.equal(await readFile(path.join(legacy, "state.json"), "utf8"), "legacy");
    assert.equal(await readFile(path.join(target, "state.json"), "utf8"), "persistent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration rejects symbolic links without deleting the legacy sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentos-storage-symlink-"));
  const cwd = path.join(root, "app");
  const runtime = path.join(root, "runtime");
  const legacy = path.join(cwd, ".mission-control");
  const env = testEnv({ AGENTOS_PACKAGE_RUNTIME: "1", AGENTOS_RUNTIME_DIR: runtime });

  try {
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(root, "outside.txt"), "external");
    await symlink(path.join(root, "outside.txt"), path.join(legacy, "linked.txt"));
    const result = await prepareAgentOsRuntimeStorage({ env, cwd });

    assert.equal(result.status, "failed");
    assert.equal(resolveAgentOsMissionControlRoot(env, cwd), legacy);
    assert.equal(await readFile(path.join(root, "outside.txt"), "utf8"), "external");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged migration blocks a symbolic-link persistent target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentos-storage-target-link-"));
  const cwd = path.join(root, "app");
  const runtime = path.join(root, "runtime");
  const legacy = path.join(cwd, ".mission-control");
  const target = path.join(runtime, "mission-control");
  const outside = path.join(root, "outside");
  const env = testEnv({ AGENTOS_PACKAGE_RUNTIME: "1", AGENTOS_RUNTIME_DIR: runtime });

  try {
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "state.json"), "preserved");
    await mkdir(outside, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await symlink(outside, target, "dir");
    const result = await prepareAgentOsRuntimeStorage({ env, cwd });

    assert.equal(result.status, "failed");
    assert.equal(resolveAgentOsMissionControlRoot(env, cwd), legacy);
    assert.equal(await readFile(path.join(legacy, "state.json"), "utf8"), "preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
