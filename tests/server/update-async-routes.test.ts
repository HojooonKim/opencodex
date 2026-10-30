import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { updateJobPath } from "../../src/update/job";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;

async function call(method: string, path: string, body?: object, deps: ManagementApiDeps = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const request = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleManagementAPI(request, url, config, deps, "admin-token");
}

describe("asynchronous package update routes", () => {
  test("non-source check leaves the event loop responsive while lookup is pending", async () => {
    let lookupEntered!: () => void;
    const entered = new Promise<void>(resolve => { lookupEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const pending = call("GET", "/api/update/check?tag=latest", undefined, {
      checkPackageUpdate: async channel => {
        expect(channel).toBe("latest");
        lookupEntered();
        await gate;
        return {
          currentVersion: "2.7.43", latestVersion: "2.7.44", channel,
          installer: "npm", updateAvailable: true, canUpdate: true,
          command: "npm install -g @bitkyc08/opencodex@2.7.44", releaseNotesUrl: "https://example.test/releases",
        };
      },
    }).then(response => { settled = true; return response; });
    try {
      await entered;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const response = await pending;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("npm");
    expect(body.latestVersion).toBe("2.7.44");
  });

  test("source checkout check returns guidance without registry work", async () => {
    const response = await call("GET", "/api/update/check?tag=latest");
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("source");
    expect(body.canUpdate).toBe(false);
  });

  test("source checkout run rejects a worker", async () => {
    const response = await call("POST", "/api/update/run", { tag: "latest", restart: false });
    expect(response?.status).toBe(409);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.code).toBe("source_checkout");
  });
});

describe("dashboard update restart supervision (#7967)", () => {
  const available = async (channel: "latest" | "preview") => ({
    currentVersion: "2.7.43", latestVersion: "2.7.44", channel,
    installer: "npm" as const, updateAvailable: true, canUpdate: true,
    command: "npm install -g @bitkyc08/opencodex@2.7.44", releaseNotesUrl: "https://example.test/releases",
  });

  test("a refused supervisor answers 409 before any update job starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-update-supervisor-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      const response = await call("POST", "/api/update/run", { tag: "latest", restart: true }, {
        checkPackageUpdate: available,
        dashboardRestartRefusal: () => "Dashboard restart is unavailable: fixture",
      });
      expect(response?.status).toBe(409);
      expect(await response!.json()).toEqual({ error: "Dashboard restart is unavailable: fixture", code: "update_restart_unsupervised" });
      expect(existsSync(updateJobPath())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  });

  test("status settles an active job whose worker died", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-update-status-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      const now = new Date().toISOString();
      mkdirSync(dirname(updateJobPath()), { recursive: true });
      writeFileSync(updateJobPath(), JSON.stringify({
        id: "dead-worker", status: "restarting", startedAt: now, updatedAt: now, pid: 2147483646,
        currentVersion: "2.7.43", latestVersion: "2.7.44", channel: "latest", installer: "npm",
        restart: true, command: "", releaseNotesUrl: "", log: [],
      }));
      const response = await call("GET", "/api/update/status?jobId=dead-worker");
      expect(response?.status).toBe(200);
      const body = await response!.json() as { job: { status: string; error?: string } };
      expect(body.job.status).toBe("failed");
      expect(body.job.error).toContain("is no longer running");
      expect(JSON.parse(readFileSync(updateJobPath(), "utf8")).status).toBe("failed");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  });
});
