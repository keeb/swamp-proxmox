// Proxmox API helpers shared by the proxmox/node and proxmox/vm extension
// models.
//
// HTTP goes through the `curl` binary rather than fetch(): Proxmox nodes
// almost always serve a self-signed certificate, and Deno's fetch has no
// per-request way to skip TLS verification (only the process-wide
// --unsafely-ignore-certificate-errors flag). curl's --insecure is scoped to
// the single request and only used when `skipTlsVerify` is true.
//
// Every argument handed to curl is validated (see validateRequest). Secrets
// (auth cookie, CSRF token, login password) never go on the command line:
// they are written to a 0600 temporary curl config file that is removed after
// the call, so they do not show up in the process list.

/** Minimal HTTP response shape returned by {@link fetchWithCurl}. */
export interface CurlResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => string;
  // deno-lint-ignore no-explicit-any
  json: () => any;
}

/** Options accepted by {@link fetchWithCurl}. */
export interface CurlRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  skipTlsVerify?: boolean;
}

/** A request that passed {@link validateRequest}. */
export interface ValidatedRequest {
  href: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  skipTlsVerify: boolean;
}

/** Proxmox auth material used on every API call. */
export interface PveAuth {
  ticket: string;
  csrfToken: string;
  username?: string;
  source: "explicit" | "cache" | "password";
  freshAuth: boolean;
}

/** Connection settings shared by both models' global arguments. */
export interface PveConnection {
  apiUrl: string;
  node: string;
  skipTlsVerify?: boolean;
}

/** The subset of the swamp method context these helpers use. */
export interface MethodContext<G> {
  globalArgs: G;
  repoDir?: string;
  logger?: {
    info(msg: string, ...args: unknown[]): void;
    warning?(msg: string, ...args: unknown[]): void;
    warn?(msg: string, ...args: unknown[]): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// deno-lint-ignore no-control-regex
const NUL = /\u0000/;

/** Sentinel curl appends (via --write-out) ahead of the HTTP status code. */
export const STATUS_MARKER = "__SWAMP_PVE_HTTP_STATUS__:";

/** Validate every piece of a request before it is handed to curl. */
export function validateRequest(
  url: string,
  options: CurlRequestOptions = {},
): ValidatedRequest {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Proxmox URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Unsupported URL protocol "${parsed.protocol}" — only http and https are allowed`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error("Credentials must not be embedded in the Proxmox URL");
  }

  const method = (options.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Unsupported HTTP method "${options.method}"`);
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (!HEADER_NAME.test(key)) {
      throw new Error(`Invalid HTTP header name ${JSON.stringify(key)}`);
    }
    const v = String(value ?? "");
    if (CONTROL_CHARS.test(v)) {
      throw new Error(`HTTP header "${key}" contains control characters`);
    }
    headers[key] = v;
  }

  const body = options.body;
  if (body !== undefined && typeof body !== "string") {
    throw new Error("Request body must be a string");
  }
  if (body !== undefined && NUL.test(body)) {
    throw new Error("Request body contains a NUL byte");
  }

  return {
    href: parsed.href,
    method,
    headers,
    body: body === "" ? undefined : body,
    skipTlsVerify: options.skipTlsVerify ?? true,
  };
}

/** Quote a value for a curl config file (double-quoted string syntax). */
export function quoteCurlConfig(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** Build the curl config file body (method, headers and request body). */
export function buildCurlConfig(req: ValidatedRequest): string {
  const lines = [`request = ${quoteCurlConfig(req.method)}`];
  for (const [key, value] of Object.entries(req.headers)) {
    lines.push(`header = ${quoteCurlConfig(`${key}: ${value}`)}`);
  }
  if (req.body !== undefined) {
    // data-raw: never treat a leading "@" as a file to read.
    lines.push(`data-raw = ${quoteCurlConfig(req.body)}`);
  }
  return lines.join("\n") + "\n";
}

/** Build curl's argv. Contains no secrets — those live in the config file. */
export function buildCurlArgs(
  req: ValidatedRequest,
  configPath: string,
): string[] {
  return [
    "--silent",
    "--show-error",
    "--proto",
    "=http,https",
    "--connect-timeout",
    "10",
    "--max-time",
    "300",
    ...(req.skipTlsVerify ? ["--insecure"] : []),
    "--config",
    configPath,
    "--write-out",
    `\n${STATUS_MARKER}%{http_code}`,
    "--url",
    req.href,
  ];
}

/** Split curl's stdout into the response body and HTTP status code. */
export function parseCurlOutput(
  stdout: string,
): { status: number; body: string } {
  const idx = stdout.lastIndexOf(`\n${STATUS_MARKER}`);
  if (idx === -1) {
    throw new Error("curl output did not include an HTTP status code");
  }
  const body = stdout.slice(0, idx);
  const status = parseInt(
    stdout.slice(idx + 1 + STATUS_MARKER.length).trim(),
    10,
  );
  return { status: Number.isNaN(status) ? 0 : status, body };
}

/** Wrap a status/body pair in the fetch-like {@link CurlResponse} shape. */
export function makeResponse(
  status: number,
  body: string,
  label: string,
): CurlResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: () => body,
    json: () => {
      try {
        return JSON.parse(body);
      } catch {
        throw new Error(
          `Proxmox returned a non-JSON response (HTTP ${status}) for ${label}: ${
            body.slice(0, 200)
          }`,
        );
      }
    },
  };
}

/** Perform one HTTP request against the Proxmox API via curl. */
export async function fetchWithCurl(
  url: string,
  options: CurlRequestOptions = {},
): Promise<CurlResponse> {
  const req = validateRequest(url, options);
  const label = `${req.method} ${new URL(req.href).pathname}`;
  const configPath = await Deno.makeTempFile({
    prefix: "swamp-pve-curl-",
    suffix: ".conf",
  });
  try {
    if (Deno.build.os !== "windows") await Deno.chmod(configPath, 0o600);
    await Deno.writeTextFile(configPath, buildCurlConfig(req));

    // swamp-quality-ignore deno-command: curl is required for per-request TLS skip against self-signed Proxmox certs; all args are validated
    const command = new Deno.Command("curl", {
      args: buildCurlArgs(req, configPath),
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr).trim();
      throw new Error(`curl ${label} failed (exit ${code}): ${errorText}`);
    }
    const { status, body } = parseCurlOutput(
      new TextDecoder().decode(stdout),
    );
    return makeResponse(status, body, label);
  } finally {
    await Deno.remove(configPath).catch(() => {});
  }
}

/** Standard Proxmox auth headers, optionally with a form content type. */
export function authHeaders(
  auth: { ticket: string; csrfToken: string },
  form = false,
): Record<string, string> {
  return {
    "Cookie": `PVEAuthCookie=${auth.ticket}`,
    "CSRFPreventionToken": auth.csrfToken,
    ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
  };
}

/** Base URL for a node-scoped API path. */
export function nodePath(conn: PveConnection, suffix: string): string {
  return `${conn.apiUrl}/api2/json/nodes/${
    encodeURIComponent(conn.node)
  }${suffix}`;
}

/**
 * Call the Proxmox API and return `data` from the JSON envelope. Throws a
 * descriptive error (operation, HTTP status, response body) when the call
 * does not return 2xx.
 */
export async function pveCall(
  conn: PveConnection,
  auth: { ticket: string; csrfToken: string },
  method: string,
  url: string,
  what: string,
  body?: string,
): Promise<unknown> {
  const response = await fetchWithCurl(url, {
    method,
    headers: authHeaders(auth, body !== undefined || method !== "GET"),
    body,
    skipTlsVerify: conn.skipTlsVerify ?? true,
  });
  if (!response.ok) {
    throw new Error(
      `${what} failed: HTTP ${response.status} ${
        response.text().slice(0, 500)
      }`,
    );
  }
  const parsed = response.json();
  return parsed?.data;
}

/** Options for {@link waitForTask}. */
export interface WaitForTaskOptions {
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}

/**
 * Poll a Proxmox task (UPID) until it stops. Throws if the status call fails
 * or the task is still running after `timeoutSeconds`.
 */
export async function waitForTask(
  apiUrl: string,
  node: string,
  upid: unknown,
  ticket: string,
  csrfToken: string,
  skipTlsVerify: boolean | undefined,
  opts: WaitForTaskOptions = {},
): Promise<
  { success: boolean; exitstatus: string | undefined; pollCount: number }
> {
  if (typeof upid !== "string" || upid.length === 0) {
    throw new Error(
      `Proxmox did not return a task id (UPID), got ${JSON.stringify(upid)}`,
    );
  }
  const { timeoutSeconds = 3600, pollIntervalMs = 1000 } = opts;
  const url = nodePath(
    { apiUrl, node },
    `/tasks/${encodeURIComponent(upid)}/status`,
  );
  const deadline = Date.now() + timeoutSeconds * 1000;
  let pollCount = 0;

  while (true) {
    pollCount++;
    const response = await fetchWithCurl(url, {
      method: "GET",
      headers: authHeaders({ ticket, csrfToken }),
      skipTlsVerify,
    });
    if (!response.ok) {
      throw new Error(
        `Task status check for ${upid} failed: HTTP ${response.status} ${
          response.text().slice(0, 200)
        }`,
      );
    }
    const result = response.json();
    if (result?.data?.status === "stopped") {
      const exitstatus = result.data.exitstatus;
      return { success: exitstatus === "OK", exitstatus, pollCount };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Task ${upid} still running after ${timeoutSeconds}s — check the Proxmox task log`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** Auth tokens older than this are not reused from the node resource. */
export const AUTH_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** True when `value` is an unresolved `${{ ... }}` vault/CEL reference. */
function isUnresolvedRef(value: unknown): boolean {
  return typeof value === "string" && value.trimStart().startsWith("${{");
}

/**
 * Decide whether a stored `node` resource still holds usable auth: both
 * tokens present and resolved, and written less than {@link AUTH_TTL_MS} ago.
 */
export function isFreshAuth(
  cached: Record<string, unknown> | null | undefined,
  now = Date.now(),
): boolean {
  if (!cached) return false;
  const { ticket, csrfToken, timestamp } = cached;
  if (typeof ticket !== "string" || ticket.length === 0) return false;
  if (typeof csrfToken !== "string" || csrfToken.length === 0) return false;
  if (isUnresolvedRef(ticket) || isUnresolvedRef(csrfToken)) return false;
  if (typeof timestamp !== "string") return false;
  const created = Date.parse(timestamp);
  if (Number.isNaN(created)) return false;
  const age = now - created;
  return age >= -60_000 && age < AUTH_TTL_MS;
}

/** Options for {@link resolveAuth}. */
export interface ResolveAuthOptions {
  /** Reuse the auth stored in this model's `node` resource when fresh. */
  readCache?: boolean;
}

/** Global arguments {@link resolveAuth} looks at. */
export interface AuthGlobalArgs {
  apiUrl: string;
  skipTlsVerify?: boolean;
  ticket?: string;
  csrfToken?: string;
  username?: string;
  password?: string;
  realm?: string;
}

/**
 * Resolve Proxmox auth, in order:
 * 1. explicit `ticket` + `csrfToken` global arguments,
 * 2. (node model only) the model's own fresh `node` resource,
 * 3. username/password login via POST /access/ticket.
 */
export async function resolveAuth(
  globalArgs: AuthGlobalArgs,
  context: { readResource?: MethodContext<unknown>["readResource"] },
  opts: ResolveAuthOptions = {},
): Promise<PveAuth> {
  const { apiUrl, skipTlsVerify } = globalArgs;

  if (globalArgs.ticket && globalArgs.csrfToken) {
    return {
      ticket: globalArgs.ticket,
      csrfToken: globalArgs.csrfToken,
      source: "explicit",
      freshAuth: false,
    };
  }

  if (opts.readCache && typeof context.readResource === "function") {
    let cached: Record<string, unknown> | null = null;
    try {
      cached = await context.readResource("node");
    } catch {
      cached = null; // no stored auth yet — fall through to password login
    }
    if (isFreshAuth(cached)) {
      return {
        ticket: cached!.ticket as string,
        csrfToken: cached!.csrfToken as string,
        source: "cache",
        freshAuth: false,
      };
    }
  }

  const { username, password, realm } = globalArgs;
  if (!username || !password) {
    throw new Error(
      "No Proxmox auth available: set the ticket and csrfToken global arguments " +
        '(e.g. ${{ data.latest("<node-model>", "node").attributes.ticket }}) ' +
        "after running the node model's auth method, or provide username/password.",
    );
  }

  const principal = `${username}@${realm || "pam"}`;
  const formData = new URLSearchParams();
  formData.append("username", principal);
  formData.append("password", password);

  const response = await fetchWithCurl(`${apiUrl}/api2/json/access/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formData.toString(),
    skipTlsVerify: skipTlsVerify ?? true,
  });

  if (!response.ok) {
    throw new Error(
      `Proxmox authentication failed for ${principal}: HTTP ${response.status} ${
        response.text().slice(0, 200)
      }`,
    );
  }

  const data = response.json()?.data;
  if (!data?.ticket || !data?.CSRFPreventionToken) {
    throw new Error(
      `Proxmox authentication for ${principal} returned no ticket/CSRF token`,
    );
  }

  return {
    ticket: data.ticket,
    csrfToken: data.CSRFPreventionToken,
    username: principal,
    source: "password",
    freshAuth: true,
  };
}

/** One interface entry from the QEMU guest agent's network-get-interfaces. */
interface GuestInterface {
  name?: string;
  "ip-addresses"?: Array<
    { "ip-address-type"?: string; "ip-address"?: string }
  >;
}

/**
 * Pick the first routable IPv4 address from guest-agent interfaces, skipping
 * loopback and link-local addresses.
 */
export function pickGuestIpv4(interfaces: unknown): string | null {
  if (!Array.isArray(interfaces)) return null;
  for (const iface of interfaces as GuestInterface[]) {
    if (!iface || iface.name === "lo") continue;
    for (const ip of iface["ip-addresses"] ?? []) {
      const addr = ip?.["ip-address"];
      if (ip?.["ip-address-type"] !== "ipv4" || typeof addr !== "string") {
        continue;
      }
      if (addr.startsWith("127.") || addr.startsWith("169.254.")) continue;
      return addr;
    }
  }
  return null;
}

/**
 * Ask the QEMU guest agent for the VM's IPv4, retrying until `waitSeconds`
 * elapse. Always makes at least one attempt. Returns null if none is found.
 */
export async function getVmIpWithRetry(
  apiUrl: string,
  node: string,
  vmid: number,
  ticket: string,
  csrfToken: string,
  skipTlsVerify: boolean | undefined,
  waitSeconds = 120,
  pollInterval = 5,
): Promise<string | null> {
  const deadline = Date.now() + waitSeconds * 1000;
  const pollMs = pollInterval * 1000;
  const url = nodePath(
    { apiUrl, node },
    `/qemu/${vmid}/agent/network-get-interfaces`,
  );

  while (true) {
    let response: CurlResponse | null = null;
    try {
      response = await fetchWithCurl(url, {
        method: "GET",
        headers: authHeaders({ ticket, csrfToken }),
        skipTlsVerify: skipTlsVerify ?? true,
      });
    } catch {
      response = null; // transport error — guest agent not reachable yet
    }
    if (response?.ok) {
      let interfaces: unknown = null;
      try {
        interfaces = response.json()?.data?.result;
      } catch {
        interfaces = null;
      }
      const ip = pickGuestIpv4(interfaces);
      if (ip) return ip;
    }
    if (Date.now() + pollMs >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Result of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** Pre-flight validation of the connection global arguments. */
export function validateConnection(
  globalArgs: { apiUrl?: unknown; node?: unknown },
): CheckResult {
  const errors: string[] = [];
  const { apiUrl, node } = globalArgs;
  if (typeof apiUrl !== "string" || apiUrl.length === 0) {
    errors.push("apiUrl is required");
  } else {
    try {
      const u = new URL(apiUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        errors.push(`apiUrl must be http(s), got "${u.protocol}"`);
      }
      if (u.username || u.password) {
        errors.push("apiUrl must not embed credentials");
      }
    } catch {
      errors.push(`apiUrl is not a valid URL: ${JSON.stringify(apiUrl)}`);
    }
  }
  if (typeof node !== "string" || node.trim().length === 0) {
    errors.push("node is required");
  }
  return errors.length ? { pass: false, errors } : { pass: true };
}

/** Render `{key}` placeholders for the human-readable `logs` field. */
export function renderTemplate(
  template: string,
  props: Record<string, unknown> = {},
): string {
  return template.replace(
    /\{(\w+)\}/g,
    (m, k) => (k in props ? String(props[k]) : m),
  );
}

/**
 * Method logger: forwards structured messages to `context.logger` and keeps
 * a rendered copy for the resource `logs` field.
 */
export function createMethodLogger(
  context: { logger?: MethodContext<unknown>["logger"] },
) {
  const lines: string[] = [];
  return {
    lines,
    info(template: string, props: Record<string, unknown> = {}) {
      lines.push(renderTemplate(template, props));
      context.logger?.info(template, props);
    },
    warn(template: string, props: Record<string, unknown> = {}) {
      lines.push(renderTemplate(template, props));
      const l = context.logger;
      const warnFn = l?.warning ?? l?.warn;
      if (warnFn) warnFn.call(l, template, props);
      else l?.info(template, props);
    },
    text() {
      return lines.join("\n");
    },
  };
}
