/**
 * @keeb/proxmox/node model — authenticate with Proxmox VE and read basic
 * node resource usage (memory, CPU, uptime), storage pools and ISO images.
 * Auth ticket/CSRF are written as the `node` resource for downstream models
 * to consume via CEL.
 */
import { z } from "npm:zod@4";
import {
  type CheckResult,
  createMethodLogger,
  type MethodContext,
  nodePath,
  pveCall,
  type PveConnection,
  resolveAuth,
  validateConnection,
  waitForTask,
} from "./lib/proxmox.ts";

const GlobalArgs = z.object({
  apiUrl: z.string().describe(
    "Proxmox API base URL (e.g., https://192.0.2.10:8006)",
  ),
  username: z.string().optional().describe(
    "Proxmox username for authentication",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Proxmox password for authentication (use a vault reference)",
  ),
  realm: z.string().default("pam").describe(
    "Authentication realm (pam, pve, etc.)",
  ),
  node: z.string().describe("Proxmox node name"),
  skipTlsVerify: z.boolean().default(true).describe(
    "Skip TLS certificate verification",
  ),
});

type NodeGlobalArgs = z.infer<typeof GlobalArgs>;
type Ctx = MethodContext<NodeGlobalArgs>;

const NodeDataSchema = z.object({
  ticket: z.string().meta({ sensitive: true }),
  csrfToken: z.string().meta({ sensitive: true }),
  username: z.string().meta({ sensitive: true }),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const NodeStatusSchema = z.object({
  memoryTotal: z.number().describe("Total memory in bytes"),
  memoryUsed: z.number().describe("Used memory in bytes"),
  memoryFree: z.number().describe("Free memory in bytes"),
  cpuUsage: z.number().describe("CPU usage (0-1)"),
  cpuCount: z.number().describe("Number of logical CPUs"),
  uptime: z.number().describe("Node uptime in seconds"),
  timestamp: z.string(),
});

const StorageSchema = z.object({
  storage: z.string().describe("Storage identifier"),
  type: z.string().describe("Storage backend type (dir, lvmthin, cifs, nfs…)"),
  content: z.string().describe("Comma-separated allowed content types"),
  active: z.boolean(),
  enabled: z.boolean(),
  total: z.number().optional().describe("Total bytes"),
  used: z.number().optional().describe("Used bytes"),
  avail: z.number().optional().describe("Available bytes"),
  timestamp: z.string(),
});

const IsoSchema = z.object({
  storage: z.string().describe("Storage the ISO lives on"),
  volid: z.string().describe("Proxmox volume id, e.g. local:iso/foo.iso"),
  filename: z.string().describe("ISO filename"),
  size: z.number().optional().describe("Size in bytes"),
  url: z.string().optional().describe("Source URL when downloaded"),
  logs: z.string().optional(),
  timestamp: z.string(),
});

const StorageListArgs = z.object({});

const IsoListArgs = z.object({
  storage: z.string().describe("Storage to list ISO content from"),
});

const DownloadIsoArgs = z.object({
  storage: z.string().describe("Target storage (must allow 'iso' content)"),
  url: z.string().regex(/^https?:\/\/\S+$/i, "url must be an http(s) URL")
    .describe("HTTP(S) URL to download the ISO from"),
  filename: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._+-]*\.iso$/,
    "filename must be a plain file name ending in .iso",
  ).describe("Destination filename, must end in .iso"),
  checksum: z.string().optional().describe("Expected checksum of the image"),
  checksumAlgorithm: z.enum([
    "md5",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
  ])
    .optional().describe(
      "Checksum algorithm (md5, sha1, sha224, sha256, sha384, sha512)",
    ),
  verifyCertificates: z.boolean().default(true).describe(
    "Verify TLS certificates of the download URL",
  ),
});

/** Instance names used by this model's own singleton resources. */
const RESERVED_INSTANCE_NAMES = new Set(["node", "status"]);

/**
 * Data instance name for a storage pool. Storage ids that would collide with
 * the model's `node`/`status` singletons get a `storage-` prefix.
 */
export function storageInstanceName(storageId: string): string {
  return RESERVED_INSTANCE_NAMES.has(storageId)
    ? `storage-${storageId}`
    : storageId;
}

/** Filename part of a Proxmox volume id (`store:iso/name.iso` → `name.iso`). */
export function volidFilename(volid: unknown): string {
  if (typeof volid !== "string") return "";
  return volid.split("/").pop() ?? "";
}

interface PveContentItem {
  volid: string;
  size?: number;
}

/** Normalise a storage content listing, dropping malformed entries. */
export function parseContentList(data: unknown): PveContentItem[] {
  if (!Array.isArray(data)) return [];
  return data.filter((i) => i && typeof i.volid === "string");
}

/** Map the /nodes/{node}/status payload onto the `status` resource shape. */
export function parseNodeStatus(d: unknown) {
  // deno-lint-ignore no-explicit-any
  const s = d as any;
  if (
    typeof s?.memory?.total !== "number" ||
    typeof s?.memory?.used !== "number" ||
    typeof s?.cpuinfo?.cpus !== "number"
  ) {
    throw new Error(
      "Unexpected /status response from Proxmox: missing memory or cpuinfo",
    );
  }
  return {
    memoryTotal: s.memory.total,
    memoryUsed: s.memory.used,
    memoryFree: s.memory.total - s.memory.used,
    cpuUsage: typeof s.cpu === "number" ? s.cpu : 0,
    cpuCount: s.cpuinfo.cpus,
    uptime: typeof s.uptime === "number" ? s.uptime : 0,
  };
}

function conn(g: NodeGlobalArgs): PveConnection {
  return { apiUrl: g.apiUrl, node: g.node, skipTlsVerify: g.skipTlsVerify };
}

function isoContentUrl(g: NodeGlobalArgs, storage: string): string {
  return nodePath(
    conn(g),
    `/storage/${encodeURIComponent(storage)}/content?content=iso`,
  );
}

/** Swamp model definition for `@keeb/proxmox/node`. */
export const model = {
  type: "@keeb/proxmox/node",
  version: "2026.05.26.1",
  upgrades: [
    {
      toVersion: "2026.05.26.1",
      description: "Version bump, no globalArguments schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "node": {
      description: "Auth tokens for Proxmox node",
      schema: NodeDataSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "status": {
      description: "Node resource usage (memory, CPU, uptime)",
      schema: NodeStatusSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "storage": {
      description: "Storage pool available on the node",
      schema: StorageSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "iso": {
      description: "ISO image present on a storage",
      schema: IsoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: GlobalArgs,
  checks: {
    "valid-connection": {
      description:
        "apiUrl is an http(s) URL without credentials and node is set",
      labels: ["policy"],
      execute: (
        context: { globalArgs: NodeGlobalArgs },
      ): Promise<CheckResult> =>
        Promise.resolve(validateConnection(context.globalArgs)),
    },
  },
  methods: {
    auth: {
      description: "Authenticate with Proxmox and return ticket/csrfToken",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const log = createMethodLogger(context);
        log.info("Authenticating with Proxmox at {apiUrl}", {
          apiUrl: context.globalArgs.apiUrl,
        });
        const auth = await resolveAuth(context.globalArgs, context);
        log.info("Authentication successful (source: {source})", {
          source: auth.source,
        });

        const handle = await context.writeResource("node", "node", {
          ticket: auth.ticket,
          csrfToken: auth.csrfToken,
          username: auth.username ?? "",
          logs: log.text(),
          timestamp: new Date().toISOString(),
        }, { lifetime: "2h" });
        return { dataHandles: [handle] };
      },
    },
    status: {
      description: "Fetch current node resource usage (memory, CPU, uptime)",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const g = context.globalArgs;
        const log = createMethodLogger(context);
        log.info("Fetching status of node {node}", { node: g.node });
        const auth = await resolveAuth(g, context, { readCache: true });

        const data = await pveCall(
          conn(g),
          auth,
          "GET",
          nodePath(conn(g), "/status"),
          `Fetching status of node ${g.node}`,
        );
        const status = parseNodeStatus(data);

        const handle = await context.writeResource("status", "status", {
          ...status,
          timestamp: new Date().toISOString(),
        });
        log.info("Node {node}: {cpus} CPUs, {used}/{total} bytes memory used", {
          node: g.node,
          cpus: status.cpuCount,
          used: status.memoryUsed,
          total: status.memoryTotal,
        });
        return { dataHandles: [handle] };
      },
    },
    storageList: {
      description:
        "List storage pools on the node — writes a named resource per storage",
      arguments: StorageListArgs,
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const g = context.globalArgs;
        const log = createMethodLogger(context);
        log.info("Listing storage on node {node}", { node: g.node });
        const auth = await resolveAuth(g, context, { readCache: true });

        const data = await pveCall(
          conn(g),
          auth,
          "GET",
          nodePath(conn(g), "/storage"),
          `Listing storage on node ${g.node}`,
        );
        // deno-lint-ignore no-explicit-any
        const stores = (Array.isArray(data) ? data : []) as any[];
        const timestamp = new Date().toISOString();
        const handles = [];
        for (const s of stores) {
          if (typeof s?.storage !== "string") continue;
          log.info("{storage} [{type}] content={content} active={active}", {
            storage: s.storage,
            type: s.type,
            content: s.content,
            active: s.active,
          });
          const handle = await context.writeResource(
            "storage",
            storageInstanceName(s.storage),
            {
              storage: s.storage,
              type: String(s.type ?? ""),
              content: s.content ?? "",
              active: s.active === 1,
              enabled: s.enabled === 1,
              total: s.total,
              used: s.used,
              avail: s.avail,
              timestamp,
            },
          );
          handles.push(handle);
        }
        log.info("{count} storage pool(s) on node {node}", {
          count: handles.length,
          node: g.node,
        });
        return { dataHandles: handles };
      },
    },
    isoList: {
      description:
        "List ISO images on a storage — writes a named resource per ISO",
      arguments: IsoListArgs,
      execute: async (args: z.infer<typeof IsoListArgs>, context: Ctx) => {
        const { storage } = args;
        const g = context.globalArgs;
        const log = createMethodLogger(context);
        log.info("Listing ISOs on storage {storage}", { storage });
        const auth = await resolveAuth(g, context, { readCache: true });

        const items = parseContentList(
          await pveCall(
            conn(g),
            auth,
            "GET",
            isoContentUrl(g, storage),
            `Listing ISOs on "${storage}"`,
          ),
        );
        const timestamp = new Date().toISOString();
        const handles = [];
        for (const item of items) {
          const filename = volidFilename(item.volid);
          if (!filename) continue;
          log.info("{volid} ({size} bytes)", {
            volid: item.volid,
            size: item.size,
          });
          const handle = await context.writeResource("iso", filename, {
            storage,
            volid: item.volid,
            filename,
            size: item.size,
            timestamp,
          });
          handles.push(handle);
        }
        log.info("{count} ISO(s) on storage {storage}", {
          count: handles.length,
          storage,
        });
        return { dataHandles: handles };
      },
    },
    downloadIso: {
      description:
        "Download an ISO from a URL directly onto a Proxmox storage (server-side)",
      arguments: DownloadIsoArgs,
      execute: async (args: z.infer<typeof DownloadIsoArgs>, context: Ctx) => {
        const {
          storage,
          url,
          filename,
          checksum,
          checksumAlgorithm,
          verifyCertificates = true,
        } = args;
        if (checksum && !checksumAlgorithm) {
          throw new Error("checksumAlgorithm is required when checksum is set");
        }
        const g = context.globalArgs;
        const log = createMethodLogger(context);
        const auth = await resolveAuth(g, context, { readCache: true });

        const findOnStorage = async (what: string) =>
          parseContentList(
            await pveCall(
              conn(g),
              auth,
              "GET",
              isoContentUrl(g, storage),
              what,
            ),
          ).find((i) => volidFilename(i.volid) === filename);

        // Idempotent: skip the download if the volume already exists.
        const existing = await findOnStorage(`Listing ISOs on "${storage}"`);
        if (existing) {
          log.info(
            "ISO {filename} already present on {storage} ({size} bytes), skipping download",
            { filename, storage, size: existing.size },
          );
          const handle = await context.writeResource("iso", filename, {
            storage,
            volid: existing.volid,
            filename,
            size: existing.size,
            url,
            logs: log.text(),
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        }

        log.info("Downloading {url} to {storage}:iso/{filename}", {
          url,
          storage,
          filename,
        });
        const params = new URLSearchParams({
          content: "iso",
          filename,
          url,
          "verify-certificates": verifyCertificates ? "1" : "0",
        });
        if (checksum) params.set("checksum", checksum);
        if (checksumAlgorithm) {
          params.set("checksum-algorithm", checksumAlgorithm);
        }

        const upid = await pveCall(
          conn(g),
          auth,
          "POST",
          nodePath(
            conn(g),
            `/storage/${encodeURIComponent(storage)}/download-url`,
          ),
          `Starting ISO download to "${storage}"`,
          params.toString(),
        );
        log.info("Download task {upid} started, waiting for completion", {
          upid,
        });
        const taskResult = await waitForTask(
          g.apiUrl,
          g.node,
          upid,
          auth.ticket,
          auth.csrfToken,
          g.skipTlsVerify ?? true,
        );
        if (!taskResult.success) {
          throw new Error(
            `ISO download failed: ${taskResult.exitstatus}. Check the task log in the Proxmox UI (${upid}).`,
          );
        }
        log.info("Download complete after {polls} polls", {
          polls: taskResult.pollCount,
        });

        // Confirm the volume landed and pick up its real size.
        const landed = await findOnStorage(
          `Verifying ISO on "${storage}" after download`,
        );
        if (!landed) {
          throw new Error(
            `Download reported OK but "${filename}" is not present on "${storage}"`,
          );
        }
        log.info("Verified {volid} ({size} bytes)", {
          volid: landed.volid,
          size: landed.size,
        });

        const handle = await context.writeResource("iso", filename, {
          storage,
          volid: landed.volid,
          filename,
          size: landed.size,
          url,
          logs: log.text(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
