/**
 * @keeb/proxmox/node model — authenticate with Proxmox VE and read basic
 * node resource usage (memory, CPU, uptime). Auth ticket/CSRF are written
 * as a named resource for downstream models to consume.
 */
import { z } from "npm:zod@4";
import { fetchWithCurl, resolveAuth, waitForTask } from "./lib/proxmox.ts";

const GlobalArgs = z.object({
  apiUrl: z.string().describe(
    "Proxmox API base URL (e.g., https://10.0.0.4:8006)",
  ),
  username: z.string().optional().describe(
    "Proxmox username for authentication",
  ),
  password: z.string().optional().describe(
    "Proxmox password for authentication",
  ),
  realm: z.string().default("pam").describe(
    "Authentication realm (pam, pve, etc.)",
  ),
  node: z.string().describe("Proxmox node name"),
  skipTlsVerify: z.boolean().default(true).describe(
    "Skip TLS certificate verification",
  ),
});

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
  volid: z.string().describe("Proxmox volume id, e.g. nami:iso/foo.iso"),
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
  url: z.string().describe("HTTP(S) URL to download the ISO from"),
  filename: z.string().describe("Destination filename, must end in .iso"),
  checksum: z.string().optional().describe("Expected checksum of the image"),
  checksumAlgorithm: z.string().optional().describe(
    "Checksum algorithm (md5, sha1, sha224, sha256, sha384, sha512)",
  ),
  verifyCertificates: z.boolean().default(true).describe(
    "Verify TLS certificates of the download URL",
  ),
});

function authOpts() {
  return { modelType: "@keeb/proxmox/node" };
}

function authHeaders(auth) {
  return {
    "Cookie": `PVEAuthCookie=${auth.ticket}`,
    "CSRFPreventionToken": auth.csrfToken,
  };
}

/** Swamp model definition for `@keeb/proxmox/node`. */
export const model: {
  type: string;
  version: string;
  resources: Record<string, unknown>;
  globalArguments: typeof GlobalArgs;
  methods: Record<string, unknown>;
} = {
  type: "@keeb/proxmox/node",
  version: "2026.05.26.1",
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
  methods: {
    auth: {
      description: "Authenticate with Proxmox and return ticket/csrfToken",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const logs = [];
        const log = (msg) => logs.push(msg);

        log(`Authenticating with Proxmox at ${context.globalArgs.apiUrl}`);
        const auth = await resolveAuth(context.globalArgs, context, {
          ...authOpts(),
          skipCache: true,
        });
        log(`Authentication successful (source: ${auth.source})`);

        const handle = await context.writeResource("node", "node", {
          ticket: auth.ticket,
          csrfToken: auth.csrfToken,
          username: auth.username,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        }, { lifetime: "2h" });
        return { dataHandles: [handle] };
      },
    },
    status: {
      description: "Fetch current node resource usage (memory, CPU, uptime)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const auth = await resolveAuth(context.globalArgs, context, authOpts());

        const response = await fetchWithCurl(
          `${apiUrl}/api2/json/nodes/${node}/status`,
          {
            method: "GET",
            headers: {
              "Cookie": `PVEAuthCookie=${auth.ticket}`,
              "CSRFPreventionToken": auth.csrfToken,
            },
            skipTlsVerify,
          },
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch node status: ${response.status}`);
        }

        const result = await response.json();
        const d = result.data;

        const handle = await context.writeResource("status", "status", {
          memoryTotal: d.memory.total,
          memoryUsed: d.memory.used,
          memoryFree: d.memory.total - d.memory.used,
          cpuUsage: d.cpu,
          cpuCount: d.cpuinfo.cpus,
          uptime: d.uptime,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    storageList: {
      description:
        "List storage pools on the node — writes a named resource per storage",
      arguments: StorageListArgs,
      execute: async (_args, context) => {
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const auth = await resolveAuth(context.globalArgs, context, authOpts());

        const response = await fetchWithCurl(
          `${apiUrl}/api2/json/nodes/${node}/storage`,
          { method: "GET", headers: authHeaders(auth), skipTlsVerify },
        );

        if (!response.ok) {
          throw new Error(
            `Failed to list storage: ${response.status} ${await response
              .text()}`,
          );
        }

        const stores = (await response.json()).data || [];
        const timestamp = new Date().toISOString();
        const handles = [];
        for (const s of stores) {
          console.log(
            `  ${s.storage} [${s.type}] content=${s.content} active=${s.active}`,
          );
          const handle = await context.writeResource("storage", s.storage, {
            storage: s.storage,
            type: s.type,
            content: s.content ?? "",
            active: s.active === 1,
            enabled: s.enabled === 1,
            total: s.total,
            used: s.used,
            avail: s.avail,
            timestamp,
          });
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },
    isoList: {
      description:
        "List ISO images on a storage — writes a named resource per ISO",
      arguments: IsoListArgs,
      execute: async (args, context) => {
        const { storage } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const auth = await resolveAuth(context.globalArgs, context, authOpts());

        const response = await fetchWithCurl(
          `${apiUrl}/api2/json/nodes/${node}/storage/${storage}/content?content=iso`,
          { method: "GET", headers: authHeaders(auth), skipTlsVerify },
        );

        if (!response.ok) {
          throw new Error(
            `Failed to list ISOs on "${storage}": ${response.status} ${await response
              .text()}`,
          );
        }

        const items = (await response.json()).data || [];
        const timestamp = new Date().toISOString();
        const handles = [];
        for (const item of items) {
          const filename = item.volid.split("/").pop();
          console.log(`  ${item.volid} (${item.size} bytes)`);
          const handle = await context.writeResource("iso", filename, {
            storage,
            volid: item.volid,
            filename,
            size: item.size,
            timestamp,
          });
          handles.push(handle);
        }
        console.log(`${handles.length} ISO(s) on storage "${storage}"`);
        return { dataHandles: handles };
      },
    },
    downloadIso: {
      description:
        "Download an ISO from a URL directly onto a Proxmox storage (server-side)",
      arguments: DownloadIsoArgs,
      execute: async (args, context) => {
        const {
          storage,
          url,
          filename,
          checksum,
          checksumAlgorithm,
          verifyCertificates = true,
        } = args;
        const { apiUrl, node, skipTlsVerify } = context.globalArgs;
        const logs = [];
        const log = (msg) => {
          logs.push(msg);
          console.log(msg);
        };

        const auth = await resolveAuth(context.globalArgs, context, authOpts());

        // Idempotent: skip the download if the volume already exists.
        const existingResponse = await fetchWithCurl(
          `${apiUrl}/api2/json/nodes/${node}/storage/${storage}/content?content=iso`,
          { method: "GET", headers: authHeaders(auth), skipTlsVerify },
        );
        if (existingResponse.ok) {
          const existing = ((await existingResponse.json()).data || []).find(
            (i) => i.volid.split("/").pop() === filename,
          );
          if (existing) {
            log(
              `ISO "${filename}" already present on "${storage}" (${existing.size} bytes) — skipping download`,
            );
            const handle = await context.writeResource("iso", filename, {
              storage,
              volid: existing.volid,
              filename,
              size: existing.size,
              url,
              logs: logs.join("\n"),
              timestamp: new Date().toISOString(),
            });
            return { dataHandles: [handle] };
          }
        }

        log(`Downloading ${url} → ${storage}:iso/${filename}`);
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

        const response = await fetchWithCurl(
          `${apiUrl}/api2/json/nodes/${node}/storage/${storage}/download-url`,
          {
            method: "POST",
            headers: {
              ...authHeaders(auth),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params.toString(),
            skipTlsVerify,
          },
        );

        if (!response.ok) {
          throw new Error(
            `Failed to start ISO download: ${response.status} ${await response
              .text()}`,
          );
        }

        const upid = (await response.json()).data;
        log(`Download task started (${upid}), waiting for completion`);
        const taskResult = await waitForTask(
          apiUrl,
          node,
          upid,
          auth.ticket,
          auth.csrfToken,
          skipTlsVerify ?? true,
        );
        if (!taskResult.success) {
          throw new Error(
            `ISO download failed: ${taskResult.exitstatus}. Check the task log in the Proxmox UI (${upid}).`,
          );
        }
        log(`Download complete after ${taskResult.pollCount}s`);

        // Confirm the volume landed and pick up its real size.
        const verifyResponse = await fetchWithCurl(
          `${apiUrl}/api2/json/nodes/${node}/storage/${storage}/content?content=iso`,
          { method: "GET", headers: authHeaders(auth), skipTlsVerify },
        );
        if (!verifyResponse.ok) {
          throw new Error(
            `Download reported OK but content listing failed: ${verifyResponse.status}`,
          );
        }
        const landed = ((await verifyResponse.json()).data || []).find((i) =>
          i.volid.split("/").pop() === filename
        );
        if (!landed) {
          throw new Error(
            `Download reported OK but "${filename}" is not present on "${storage}"`,
          );
        }
        log(`Verified ${landed.volid} (${landed.size} bytes)`);

        const handle = await context.writeResource("iso", filename, {
          storage,
          volid: landed.volid,
          filename,
          size: landed.size,
          url,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
