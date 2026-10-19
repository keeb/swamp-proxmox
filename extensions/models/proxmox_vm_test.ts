import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import {
  buildCreateParams,
  buildSpiceFile,
  findVm,
  model,
  parseVmList,
  spiceInstanceName,
} from "./proxmox_vm.ts";
import {
  type FakeReply,
  type FakeRequest,
  ok,
  taskDone,
  withFakePve,
} from "./lib/fake_pve.ts";

const globalArgs = {
  apiUrl: "https://192.0.2.10:8006",
  ticket: "TICKET",
  csrfToken: "CSRF",
  node: "pve01",
  skipTlsVerify: true,
};

// deno-lint-ignore no-explicit-any
type Ctx = any;

const QEMU = "/api2/json/nodes/pve01/qemu";

const AGENT_IP = ok({
  result: [{
    name: "eth0",
    "ip-addresses": [{
      "ip-address-type": "ipv4",
      "ip-address": "198.51.100.20",
    }],
  }],
});

/** Fake PVE with a mutable VM table; tasks finish with `taskExit`. */
function fakeCluster(
  vms: Array<{ vmid: number; name: string; status: string }>,
  opts: { taskExit?: string; agent?: FakeReply } = {},
) {
  return (req: FakeRequest): FakeReply => {
    const p = req.url.pathname;
    if (p.includes("/tasks/")) return taskDone(opts.taskExit ?? "OK");
    if (p.endsWith("/agent/network-get-interfaces")) {
      return opts.agent ?? AGENT_IP;
    }
    if (req.method === "GET" && p === QEMU) return ok(vms);
    if (req.method === "GET" && p === "/api2/json/cluster/nextid") {
      return ok("105");
    }
    if (req.method === "POST" && p === QEMU) return ok("UPID:create");
    if (req.method === "POST" && /\/status\/(start|stop)$/.test(p)) {
      return ok("UPID:power");
    }
    if (req.method === "DELETE") return ok("UPID:delete");
    if (req.method === "PUT" && p.endsWith("/config")) return ok(null);
    if (req.method === "POST" && p.endsWith("/spiceproxy")) {
      return ok({
        type: "spice",
        host: "pvespiceproxy:abc",
        "tls-port": 61000,
        proxy: "http://pve01.example.local:3128",
        password: "spice-ticket",
      });
    }
    return { status: 404, json: { data: null } };
  };
}

const FLEET = [
  { vmid: 101, name: "web01", status: "running" },
  { vmid: 102, name: "db01", status: "stopped" },
];

Deno.test("lookup returns vmid and guest IP for a running VM", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () => model.methods.lookup.execute({ vmName: "web01" }, context as Ctx),
  );
  assertEquals(requests[0].headers["Cookie"], "PVEAuthCookie=TICKET");
  assertEquals(requests[0].headers["CSRFPreventionToken"], "CSRF");
  const [w] = getWrittenResources();
  assertEquals(w.name, "web01");
  assertEquals(w.data.vmid, 101);
  assertEquals(w.data.ip, "198.51.100.20");
});

Deno.test("lookup of an unknown VM lists available names", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withFakePve(
        fakeCluster(FLEET),
        () => model.methods.lookup.execute({ vmName: "nope" }, context as Ctx),
      ),
    Error,
    "Available: web01, db01",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("methods fail clearly without a ticket", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...globalArgs, ticket: undefined },
  });
  await assertRejects(
    () => model.methods.sync.execute({}, context as Ctx),
    Error,
    "No Proxmox auth available",
  );
});

Deno.test("start boots a stopped VM and records the IP", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () =>
      model.methods.start.execute({
        vmName: "db01",
        waitSeconds: 0,
        pollInterval: 1,
        requireIp: true,
      }, context as Ctx),
  );
  assert(
    requests.some((r) => r.url.pathname === `${QEMU}/102/status/start`),
  );
  const [w] = getWrittenResources();
  assertEquals(w.data.wasStarted, true);
  assertEquals(w.data.ip, "198.51.100.20");
});

Deno.test("start throws when no IP and requireIp, without writing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withFakePve(
        fakeCluster(FLEET, { agent: { status: 500, json: { data: null } } }),
        () =>
          model.methods.start.execute({
            vmName: "web01",
            waitSeconds: 0,
            pollInterval: 1,
            requireIp: true,
          }, context as Ctx),
      ),
    Error,
    "did not return an IP",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("start tolerates a missing IP when requireIp is false", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withFakePve(
    fakeCluster(FLEET, { agent: { curlExit: 28 } }),
    () =>
      model.methods.start.execute({
        vmName: "web01",
        waitSeconds: 0,
        pollInterval: 1,
        requireIp: false,
      }, context as Ctx),
  );
  const [w] = getWrittenResources();
  assertEquals(w.data.ip, null);
  assertEquals(w.data.wasStarted, false);
});

Deno.test("stop is a no-op for a stopped VM", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () => model.methods.stop.execute({ vmName: "db01" }, context as Ctx),
  );
  assertFalse(requests.some((r) => r.method === "POST"));
  assertEquals(getWrittenResources()[0].data.status, "stopped");
});

Deno.test("stop throws when the stop task fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withFakePve(
        fakeCluster(FLEET, { taskExit: "VM quit/powerdown failed" }),
        () => model.methods.stop.execute({ vmName: "web01" }, context as Ctx),
      ),
    Error,
    "stop failed",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("create allocates a vmid and posts the VM spec", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () =>
      model.methods.create.execute(
        { vmName: "pxe01", diskSize: 0, memory: 4096 },
        context as Ctx,
      ),
  );
  const post = requests.find((r) =>
    r.method === "POST" && r.url.pathname === QEMU
  )!;
  const form = new URLSearchParams(post.body);
  assertEquals(form.get("vmid"), "105");
  assertEquals(form.get("memory"), "4096");
  assertEquals(form.get("boot"), "order=net0");
  assertEquals(form.get("scsi0"), null);
  assertEquals(
    post.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const [w] = getWrittenResources();
  assertEquals(w.data.vmid, 105);
  assertEquals(w.data.status, "stopped");
});

Deno.test("create is idempotent when the name already exists", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () => model.methods.create.execute({ vmName: "web01" }, context as Ctx),
  );
  assertFalse(requests.some((r) => r.method === "POST"));
  assertEquals(getWrittenResources()[0].data.vmid, 101);
});

Deno.test("create throws when the create task fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withFakePve(
        fakeCluster(FLEET, { taskExit: "storage full" }),
        () => model.methods.create.execute({ vmName: "new01" }, context as Ctx),
      ),
    Error,
    "creation failed: storage full",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("delete stops a running VM, then deletes it", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () => model.methods.delete.execute({ vmName: "web01" }, context as Ctx),
  );
  const mutating = requests
    .filter((r) => r.method !== "GET")
    .map((r) => `${r.method} ${r.url.pathname}`);
  assertEquals(mutating, [
    `POST ${QEMU}/101/status/stop`,
    `DELETE ${QEMU}/101`,
  ]);
  assertEquals(getWrittenResources()[0].data.status, "deleted");
});

Deno.test("delete succeeds when the VM is already gone", async () => {
  const fresh = createModelTestContext({ globalArgs });
  await withFakePve(
    fakeCluster(FLEET),
    () =>
      model.methods.delete.execute({ vmName: "gone" }, fresh.context as Ctx),
  );
  assertEquals(fresh.getWrittenResources().length, 0);

  const seeded = createModelTestContext({
    globalArgs,
    storedResources: { gone: { vmid: 999, vmName: "gone", status: "stopped" } },
  });
  await withFakePve(
    fakeCluster(FLEET),
    () =>
      model.methods.delete.execute({ vmName: "gone" }, seeded.context as Ctx),
  );
  const [w] = seeded.getWrittenResources();
  assertEquals(w.data.vmid, 999);
  assertEquals(w.data.status, "deleted");
});

Deno.test("delete throws when the delete task fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await assertRejects(
    () =>
      withFakePve(
        fakeCluster(FLEET, { taskExit: "locked" }),
        () => model.methods.delete.execute({ vmName: "db01" }, context as Ctx),
      ),
    Error,
    "deletion failed: locked",
  );
  assertEquals(getWrittenResources().length, 0);
});

Deno.test("setBootOrder PUTs the boot string", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () =>
      model.methods.setBootOrder.execute(
        { vmName: "db01", boot: "order=scsi0;net0" },
        context as Ctx,
      ),
  );
  const put = requests.find((r) => r.method === "PUT")!;
  assertEquals(put.url.pathname, `${QEMU}/102/config`);
  assertEquals(new URLSearchParams(put.body).get("boot"), "order=scsi0;net0");
  assertEquals(getWrittenResources()[0].data.boot, "order=scsi0;net0");
});

Deno.test("setConfig rejects empty config before any API call", async () => {
  const { context } = createModelTestContext({ globalArgs });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () =>
      assertRejects(
        () =>
          model.methods.setConfig.execute(
            { vmName: "db01", config: {} },
            context as Ctx,
          ),
        Error,
        "No config params provided",
      ),
  );
  assertEquals(requests.length, 0);
});

Deno.test("setConfig sends every key and surfaces API errors", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  const { requests } = await withFakePve(
    fakeCluster(FLEET),
    () =>
      model.methods.setConfig.execute(
        { vmName: "db01", config: { agent: "1", cores: "4" } },
        context as Ctx,
      ),
  );
  const put = requests.find((r) => r.method === "PUT")!;
  assertEquals(put.body, "agent=1&cores=4");
  assertEquals(getWrittenResources()[0].data.config, {
    agent: "1",
    cores: "4",
  });

  await assertRejects(
    () =>
      withFakePve(
        (req) =>
          req.method === "PUT"
            ? { status: 400, json: { errors: { cores: "invalid" } } }
            : fakeCluster(FLEET)(req),
        () =>
          model.methods.setConfig.execute(
            { vmName: "db01", config: { cores: "x" } },
            context as Ctx,
          ),
      ),
    Error,
    "HTTP 400",
  );
});

Deno.test("sync writes one resource per VM", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs,
  });
  await withFakePve(
    fakeCluster([...FLEET, { vmid: 103, name: "", status: "stopped" }]),
    () => model.methods.sync.execute({}, context as Ctx),
  );
  const written = getWrittenResources();
  assertEquals(written.map((w) => w.name), ["web01", "db01", "vm-103"]);
  assertEquals(written[0].data.ip, "198.51.100.20");
  assertEquals(written[1].data.ip, null);
});

Deno.test("sync fails on a non-array VM list", async () => {
  const { context } = createModelTestContext({ globalArgs });
  await assertRejects(
    () =>
      withFakePve(
        () => ok({ unexpected: true }),
        () => model.methods.sync.execute({}, context as Ctx),
      ),
    Error,
    "not an array",
  );
});

Deno.test("spiceConnect writes a private .vv file under its own instance name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // A stale, world-readable file from an earlier run must be tightened.
    await Deno.mkdir(`${dir}/spice`);
    await Deno.writeTextFile(`${dir}/spice/web01.vv`, "old", { mode: 0o644 });
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs,
      repoDir: dir,
    });
    await withFakePve(
      fakeCluster(FLEET),
      () =>
        model.methods.spiceConnect.execute(
          { vmName: "web01" },
          context as Ctx,
        ),
    );
    const [w] = getWrittenResources();
    assertEquals(w.specName, "spice");
    assertEquals(w.name, spiceInstanceName("web01"));
    const path = `${dir}/spice/web01.vv`;
    assertEquals(w.data.configPath, path);
    const contents = await Deno.readTextFile(path);
    assertStringIncludes(contents, "proxy=http://192.0.2.10:3128");
    assertStringIncludes(contents, "tls-port=61000");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ticket and csrfToken global arguments are sensitive", () => {
  const shape = model.globalArguments.shape;
  assertEquals(shape.ticket.meta()?.sensitive, true);
  assertEquals(shape.csrfToken.meta()?.sensitive, true);
});

Deno.test("create argument schema rejects nonsense sizes", () => {
  const schema = model.methods.create.arguments;
  assert(schema.safeParse({ vmName: "a", diskSize: 0 }).success);
  assertFalse(schema.safeParse({ vmName: "a", memory: -1 }).success);
  assertFalse(schema.safeParse({ vmName: "a", cores: 0 }).success);
  assertFalse(schema.safeParse({ vmName: "a", diskSize: -5 }).success);
});

Deno.test("pure helpers", () => {
  assertThrows(() => parseVmList(null), Error, "not an array");
  assertEquals(parseVmList([{ vmid: "7", name: "x" }, { name: "novmid" }]), [
    { vmid: 7, name: "x" },
  ]);
  assertThrows(() => findVm([], "x"), Error, 'VM "x" not found');

  const params = buildCreateParams(200, { vmName: "web01" });
  assertEquals(params.get("scsi0"), "local-lvm:32,format=raw");
  assertEquals(params.get("boot"), "order=net0;scsi0");
  assertEquals(params.get("smbios1"), `base64=1,serial=${btoa("web01")}`);

  const spice = buildSpiceFile(
    { proxy: "http://203.0.113.5:3128", host: "h", note: "a\nb" },
    "203.0.113.5",
  );
  assertEquals(spice.rewrittenFrom, null);
  assertStringIncludes(spice.contents, "note=ab");
});
