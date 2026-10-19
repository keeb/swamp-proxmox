import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import {
  model,
  parseNodeStatus,
  storageInstanceName,
  volidFilename,
} from "./proxmox_node.ts";
import {
  type FakeReply,
  type FakeRequest,
  ok,
  taskDone,
  withFakePve,
} from "./lib/fake_pve.ts";

const globalArgs = {
  apiUrl: "https://192.0.2.10:8006",
  username: "root",
  password: "hunter2",
  realm: "pam",
  node: "pve01",
  skipTlsVerify: true,
};

const freshAuth = () => ({
  node: {
    ticket: "CACHED-TICKET",
    csrfToken: "CACHED-CSRF",
    username: "root@pam",
    timestamp: new Date().toISOString(),
  },
});

// deno-lint-ignore no-explicit-any
type Ctx = any;

function route(
  routes: Record<string, (req: FakeRequest) => FakeReply>,
): (req: FakeRequest) => FakeReply {
  return (req) => {
    const key = `${req.method} ${req.url.pathname}`;
    const hit = routes[key];
    if (hit) return hit(req);
    if (req.url.pathname.includes("/tasks/")) return taskDone();
    return { status: 404, json: { data: null, message: `no route ${key}` } };
  };
}

const LOGIN = "POST /api2/json/access/ticket";
const loginOk = () =>
  ok({ ticket: "NEW-TICKET", CSRFPreventionToken: "NEW-CSRF" });

Deno.test("auth logs in and writes the node resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    route({ [LOGIN]: loginOk }),
    () => model.methods.auth.execute({}, context as Ctx),
  );
  const [w] = getWrittenResources();
  assertEquals(w.specName, "node");
  assertEquals(w.name, "node");
  assertEquals(w.data.ticket, "NEW-TICKET");
  assertEquals(w.data.csrfToken, "NEW-CSRF");
  assertEquals(w.data.username, "root@pam");
  assertFalse(requests[0].args.join(" ").includes("hunter2"));
  assertFalse(String(w.data.logs).includes("NEW-TICKET"));
});

Deno.test("auth fails on bad credentials without writing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withFakePve(
        route({ [LOGIN]: () => ({ status: 401, json: { data: null } }) }),
        () => model.methods.auth.execute({}, context as Ctx),
      ),
    Error,
    "authentication failed",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("auth requires username and password", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...globalArgs, password: undefined },
  });
  await assertRejects(
    () => model.methods.auth.execute({}, context as Ctx),
    Error,
    "No Proxmox auth available",
  );
});

Deno.test("status reuses fresh cached auth and writes status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  const { requests } = await withFakePve(
    route({
      "GET /api2/json/nodes/pve01/status": () =>
        ok({
          memory: { total: 1000, used: 400 },
          cpu: 0.25,
          cpuinfo: { cpus: 8 },
          uptime: 3600,
        }),
    }),
    () => model.methods.status.execute({}, context as Ctx),
  );
  assertEquals(requests.length, 1);
  assertEquals(requests[0].headers["Cookie"], "PVEAuthCookie=CACHED-TICKET");
  const [w] = getWrittenResources();
  assertEquals(w.name, "status");
  assertEquals(w.data.memoryFree, 600);
  assertEquals(w.data.cpuCount, 8);
});

Deno.test("status logs in again when cached auth is stale", async () => {
  const { context } = createModelTestContext({
    globalArgs,
    storedResources: {
      node: { ...freshAuth().node, timestamp: "2020-01-01T00:00:00Z" },
    },
  });
  const { requests } = await withFakePve(
    route({
      [LOGIN]: loginOk,
      "GET /api2/json/nodes/pve01/status": () =>
        ok({ memory: { total: 1, used: 1 }, cpuinfo: { cpus: 1 } }),
    }),
    () => model.methods.status.execute({}, context as Ctx),
  );
  assertEquals(`${requests[0].method} ${requests[0].url.pathname}`, LOGIN);
  assertEquals(requests[1].headers["Cookie"], "PVEAuthCookie=NEW-TICKET");
});

Deno.test("status throws on malformed or failed responses", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  await assertRejects(
    () =>
      withFakePve(
        route({ "GET /api2/json/nodes/pve01/status": () => ok({}) }),
        () => model.methods.status.execute({}, context as Ctx),
      ),
    Error,
    "missing memory",
  );
  await assertRejects(
    () =>
      withFakePve(
        route({
          "GET /api2/json/nodes/pve01/status": () => ({
            status: 500,
            text: "boom",
          }),
        }),
        () => model.methods.status.execute({}, context as Ctx),
      ),
    Error,
    "HTTP 500",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("storageList writes one resource per storage", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  await withFakePve(
    route({
      "GET /api2/json/nodes/pve01/storage": () =>
        ok([
          {
            storage: "local",
            type: "dir",
            content: "iso",
            active: 1,
            enabled: 1,
          },
          { storage: "status", type: "nfs", active: 0, enabled: 1 },
          { type: "broken" },
        ]),
    }),
    () => model.methods.storageList.execute({}, context as Ctx),
  );
  const written = getWrittenResources();
  assertEquals(written.map((w) => w.name), ["local", "storage-status"]);
  assertEquals(written[0].data.active, true);
  assertEquals(written[1].data.content, "");
  assertEquals(written[1].data.active, false);
});

Deno.test("isoList writes one resource per ISO", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  const { requests } = await withFakePve(
    route({
      "GET /api2/json/nodes/pve01/storage/local/content": () =>
        ok([
          { volid: "local:iso/alpine.iso", size: 100 },
          { volid: "local:iso/debian.iso", size: 200 },
        ]),
    }),
    () => model.methods.isoList.execute({ storage: "local" }, context as Ctx),
  );
  assertEquals(requests[0].url.searchParams.get("content"), "iso");
  assertEquals(getWrittenResources().map((w) => w.name), [
    "alpine.iso",
    "debian.iso",
  ]);
});

Deno.test("downloadIso skips when the ISO is already present", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  const { requests } = await withFakePve(
    route({
      "GET /api2/json/nodes/pve01/storage/local/content": () =>
        ok([{ volid: "local:iso/alpine.iso", size: 100 }]),
    }),
    () =>
      model.methods.downloadIso.execute({
        storage: "local",
        url: "https://example.com/alpine.iso",
        filename: "alpine.iso",
        verifyCertificates: true,
      }, context as Ctx),
  );
  assertFalse(requests.some((r) => r.method === "POST"));
  assertEquals(getWrittenResources()[0].data.size, 100);
});

Deno.test("downloadIso downloads, waits for the task and verifies", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  let listed = 0;
  const { requests } = await withFakePve(
    route({
      "GET /api2/json/nodes/pve01/storage/local/content": () =>
        ok(listed++ === 0 ? [] : [{ volid: "local:iso/new.iso", size: 42 }]),
      "POST /api2/json/nodes/pve01/storage/local/download-url": () =>
        ok("UPID:pve01:download"),
    }),
    () =>
      model.methods.downloadIso.execute({
        storage: "local",
        url: "https://example.com/new.iso",
        filename: "new.iso",
        checksum: "abc",
        checksumAlgorithm: "sha256",
        verifyCertificates: false,
      }, context as Ctx),
  );
  const post = requests.find((r) => r.method === "POST")!;
  const form = new URLSearchParams(post.body);
  assertEquals(form.get("url"), "https://example.com/new.iso");
  assertEquals(form.get("checksum-algorithm"), "sha256");
  assertEquals(form.get("verify-certificates"), "0");
  assertEquals(getWrittenResources()[0].data.volid, "local:iso/new.iso");
});

Deno.test("downloadIso throws when the task fails, without writing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
    storedResources: freshAuth(),
  });
  await assertRejects(
    () =>
      withFakePve(
        (req) => {
          if (req.url.pathname.includes("/tasks/")) {
            return taskDone("download failed");
          }
          if (req.method === "POST") return ok("UPID:x");
          return ok([]);
        },
        () =>
          model.methods.downloadIso.execute({
            storage: "local",
            url: "https://example.com/new.iso",
            filename: "new.iso",
            verifyCertificates: true,
          }, context as Ctx),
      ),
    Error,
    "ISO download failed",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("downloadIso argument schema rejects unsafe values", () => {
  const schema = model.methods.downloadIso.arguments;
  const base = {
    storage: "local",
    url: "https://example.com/a.iso",
    filename: "a.iso",
  };
  assert(schema.safeParse(base).success);
  assertFalse(schema.safeParse({ ...base, filename: "../etc/a.iso" }).success);
  assertFalse(schema.safeParse({ ...base, filename: "a.img" }).success);
  assertFalse(schema.safeParse({ ...base, url: "file:///etc/passwd" }).success);
  assertFalse(
    schema.safeParse({ ...base, checksumAlgorithm: "crc32" }).success,
  );
});

Deno.test("password global argument is marked sensitive", () => {
  const meta = model.globalArguments.shape.password.meta();
  assertEquals(meta?.sensitive, true);
});

Deno.test("valid-connection check", async () => {
  const check = model.checks["valid-connection"];
  assertEquals(await check.execute({ globalArgs }), { pass: true });
  const bad = await check.execute({
    globalArgs: { ...globalArgs, apiUrl: "192.0.2.10:8006" },
  });
  assertFalse(bad.pass);
});

Deno.test("pure helpers", () => {
  assertEquals(storageInstanceName("node"), "storage-node");
  assertEquals(storageInstanceName("local-lvm"), "local-lvm");
  assertEquals(volidFilename("local:iso/a.iso"), "a.iso");
  assertEquals(volidFilename(undefined), "");
  assertEquals(
    parseNodeStatus({ memory: { total: 10, used: 4 }, cpuinfo: { cpus: 2 } })
      .memoryFree,
    6,
  );
});
