import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  AUTH_TTL_MS,
  buildCurlArgs,
  buildCurlConfig,
  fetchWithCurl,
  isFreshAuth,
  parseCurlOutput,
  pickGuestIpv4,
  quoteCurlConfig,
  renderTemplate,
  resolveAuth,
  STATUS_MARKER,
  validateConnection,
  validateRequest,
  waitForTask,
} from "./proxmox.ts";
import {
  ok,
  parseCurlConfig,
  unquoteCurlConfig,
  withFakePve,
} from "./fake_pve.ts";

const API = "https://192.0.2.10:8006";

Deno.test("validateRequest accepts a normal API call", () => {
  const req = validateRequest(`${API}/api2/json/version`, {
    method: "post",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "a=1",
  });
  assertEquals(req.method, "POST");
  assertEquals(req.skipTlsVerify, true);
  assertEquals(req.body, "a=1");
});

Deno.test("validateRequest rejects unsafe input", () => {
  assertThrows(
    () => validateRequest("not a url"),
    Error,
    "Invalid Proxmox URL",
  );
  assertThrows(() => validateRequest("file:///etc/passwd"), Error, "protocol");
  assertThrows(
    () => validateRequest("https://user:pw@192.0.2.10/"),
    Error,
    "Credentials",
  );
  assertThrows(
    () => validateRequest(API, { method: "PATCH --upload-file" }),
    Error,
    "method",
  );
  assertThrows(
    () => validateRequest(API, { headers: { "X-Bad\r\nHeader": "x" } }),
    Error,
    "header name",
  );
  assertThrows(
    () => validateRequest(API, { headers: { "Cookie": "a\r\nInjected: 1" } }),
    Error,
    "control characters",
  );
  assertThrows(
    () => validateRequest(API, { body: "a\u0000b" }),
    Error,
    "NUL",
  );
});

Deno.test("curl config quoting round-trips special characters", () => {
  const raw = 'pa"ss\\word\nwith\ttabs\r';
  assertEquals(unquoteCurlConfig(quoteCurlConfig(raw)), raw);
});

Deno.test("secrets go to the config file, never argv", () => {
  const req = validateRequest(`${API}/api2/json/access/ticket`, {
    method: "POST",
    headers: { "Cookie": "PVEAuthCookie=SECRET-TICKET" },
    body: "username=root%40pam&password=hunter2",
    skipTlsVerify: false,
  });
  const args = buildCurlArgs(req, "/tmp/x.conf");
  assertFalse(args.join(" ").includes("SECRET-TICKET"));
  assertFalse(args.join(" ").includes("hunter2"));
  assertFalse(args.includes("--insecure"));
  assertEquals(args[args.indexOf("--url") + 1], req.href);

  const cfg = parseCurlConfig(buildCurlConfig(req));
  assertEquals(cfg.method, "POST");
  assertEquals(cfg.headers["Cookie"], "PVEAuthCookie=SECRET-TICKET");
  assertEquals(cfg.body, "username=root%40pam&password=hunter2");
});

Deno.test("parseCurlOutput splits body and status", () => {
  assertEquals(
    parseCurlOutput(`{"data":1}\n${STATUS_MARKER}201`),
    { status: 201, body: '{"data":1}' },
  );
  assertEquals(parseCurlOutput(`\n${STATUS_MARKER}000`).status, 0);
  assertThrows(() => parseCurlOutput("no marker"), Error, "status code");
});

Deno.test("fetchWithCurl returns a response and cleans up its config file", async () => {
  let configPath = "";
  const { result, requests } = await withFakePve((req) => {
    configPath = req.args[req.args.indexOf("--config") + 1];
    return ok({ version: "8.2" });
  }, () => fetchWithCurl(`${API}/api2/json/version`));
  assert(result.ok);
  assertEquals(result.json().data.version, "8.2");
  assertEquals(requests[0].method, "GET");
  assert(requests[0].args.includes("--insecure"));
  await assertRejects(() => Deno.stat(configPath), Deno.errors.NotFound);
});

Deno.test("fetchWithCurl surfaces curl failures and non-JSON bodies", async () => {
  await assertRejects(
    () =>
      withFakePve(
        () => ({ curlExit: 7 }),
        () => fetchWithCurl(`${API}/api2/json/version`),
      ),
    Error,
    "failed (exit 7)",
  );
  const { result } = await withFakePve(
    () => ({ status: 502, text: "<html>bad gateway</html>" }),
    () => fetchWithCurl(`${API}/api2/json/version`),
  );
  assertFalse(result.ok);
  assertEquals(result.status, 502);
  assertThrows(() => result.json(), Error, "non-JSON");
});

Deno.test("waitForTask returns exit status and times out", async () => {
  const done = await withFakePve(
    () => ok({ status: "stopped", exitstatus: "OK" }),
    () => waitForTask(API, "pve01", "UPID:1", "t", "c", true),
  );
  assertEquals(done.result, { success: true, exitstatus: "OK", pollCount: 1 });

  const failed = await withFakePve(
    () => ok({ status: "stopped", exitstatus: "command failed" }),
    () => waitForTask(API, "pve01", "UPID:1", "t", "c", true),
  );
  assertFalse(failed.result.success);

  await assertRejects(
    () =>
      withFakePve(
        () => ok({ status: "running" }),
        () =>
          waitForTask(API, "pve01", "UPID:1", "t", "c", true, {
            timeoutSeconds: 0,
            pollIntervalMs: 0,
          }),
      ),
    Error,
    "still running",
  );
  await assertRejects(
    () => waitForTask(API, "pve01", null, "t", "c", true),
    Error,
    "UPID",
  );
});

Deno.test("isFreshAuth honours TTL and rejects unresolved references", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const base = {
    ticket: "PVE:root@pam:ABC",
    csrfToken: "CSRF",
    timestamp: "2026-10-15T11:30:00Z",
  };
  assert(isFreshAuth(base, now));
  assertFalse(isFreshAuth(null, now));
  assertFalse(
    isFreshAuth({
      ...base,
      timestamp: new Date(now - AUTH_TTL_MS - 1).toISOString(),
    }, now),
  );
  assertFalse(
    isFreshAuth({ ...base, ticket: "${{ vault.get('v', 'k') }}" }, now),
  );
  assertFalse(isFreshAuth({ ...base, timestamp: "garbage" }, now));
});

Deno.test("resolveAuth prefers explicit tokens, then cache, then password", async () => {
  const explicit = await resolveAuth(
    { apiUrl: API, ticket: "T", csrfToken: "C" },
    {},
  );
  assertEquals(explicit.source, "explicit");

  const cached = await resolveAuth({ apiUrl: API }, {
    readResource: () =>
      Promise.resolve({
        ticket: "CT",
        csrfToken: "CC",
        timestamp: new Date().toISOString(),
      }),
  }, { readCache: true });
  assertEquals(cached.source, "cache");
  assertEquals(cached.ticket, "CT");

  const { result, requests } = await withFakePve(
    () => ok({ ticket: "NEW", CSRFPreventionToken: "NEWC" }),
    () =>
      resolveAuth(
        { apiUrl: API, username: "root", password: "hunter2", realm: "pve" },
        { readResource: () => Promise.resolve(null) },
        { readCache: true },
      ),
  );
  assertEquals(result.source, "password");
  assertEquals(result.username, "root@pve");
  assertStringIncludes(requests[0].body ?? "", "password=hunter2");
  assertFalse(requests[0].args.join(" ").includes("hunter2"));
});

Deno.test("resolveAuth fails clearly without credentials or on 401", async () => {
  await assertRejects(
    () => resolveAuth({ apiUrl: API }, {}),
    Error,
    "No Proxmox auth available",
  );
  await assertRejects(
    () =>
      withFakePve(
        () => ({ status: 401, json: { data: null } }),
        () => resolveAuth({ apiUrl: API, username: "root", password: "x" }, {}),
      ),
    Error,
    "authentication failed",
  );
  await assertRejects(
    () =>
      withFakePve(
        () => ok({}),
        () => resolveAuth({ apiUrl: API, username: "root", password: "x" }, {}),
      ),
    Error,
    "no ticket",
  );
});

Deno.test("pickGuestIpv4 skips loopback, link-local and IPv6", () => {
  assertEquals(
    pickGuestIpv4([
      {
        name: "lo",
        "ip-addresses": [{
          "ip-address-type": "ipv4",
          "ip-address": "127.0.0.1",
        }],
      },
      {
        name: "eth0",
        "ip-addresses": [
          { "ip-address-type": "ipv6", "ip-address": "fe80::1" },
          { "ip-address-type": "ipv4", "ip-address": "169.254.1.1" },
          { "ip-address-type": "ipv4", "ip-address": "198.51.100.7" },
        ],
      },
    ]),
    "198.51.100.7",
  );
  assertEquals(pickGuestIpv4(undefined), null);
  assertEquals(pickGuestIpv4([{ name: "eth0" }]), null);
});

Deno.test("validateConnection flags bad apiUrl and missing node", () => {
  assertEquals(validateConnection({ apiUrl: API, node: "pve01" }), {
    pass: true,
  });
  const bad = validateConnection({ apiUrl: "ftp://x", node: "" });
  assertFalse(bad.pass);
  assertEquals(bad.errors?.length, 2);
});

Deno.test("renderTemplate fills known placeholders only", () => {
  assertEquals(
    renderTemplate("VM {vmName} id {vmid} {missing}", {
      vmName: "web01",
      vmid: 101,
    }),
    "VM web01 id 101 {missing}",
  );
});
