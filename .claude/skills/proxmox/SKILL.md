---
name: proxmox
description: Authenticate with Proxmox VE and manage VM fleet lifecycle (create, start, stop, delete, sync, lookup, setBootOrder, setConfig) via the @user/proxmox/node and @user/proxmox/vm extension models from @keeb/proxmox. Use when the user wants to provision or operate Proxmox VMs, sync a VM fleet, fetch a VM IP from the QEMU guest agent, set boot order for PXE installs, or wire Proxmox auth tickets into downstream models. Triggers on "proxmox", "PVE", "qemu vm", "create vm", "start vm", "stop vm", "delete vm", "sync fleet", "PXE boot", "guest agent ip", "proxmox ticket", "@keeb/proxmox", "@user/proxmox/node", "@user/proxmox/vm".
---

# @keeb/proxmox

Swamp extension for Proxmox VE: API auth and fleet-style VM lifecycle. The
node model's `auth` step writes a `node` resource (ticket + CSRF token, both
vaulted as sensitive) that VM models consume via CEL, so a single `auth` step
covers all VM operations for the ticket's 2-hour lifetime.

## Models

### `@user/proxmox/node`

Authenticate against a PVE node and (optionally) snapshot resource usage.

Global arguments: `apiUrl`, `username`, `password`, `realm` (default `pam`),
`node`, `skipTlsVerify` (default `true`).

| Method   | Arguments | Writes resource         | Description                                                                     |
| -------- | --------- | ----------------------- | ------------------------------------------------------------------------------- |
| `auth`   | none      | `node` named `node`     | Logs in, writes ticket + CSRF as a `node` resource (lifetime `2h`).            |
| `status` | none      | `status` named `status` | Fetches `/nodes/{node}/status` (memory, CPU, uptime).                           |

Also `storageList`, `isoList(storage)` and `downloadIso(storage, url, filename,
checksum?, checksumAlgorithm?)`. Non-`auth` methods reuse the stored `node`
resource while it is under 2h old, otherwise log in with username/password.

### `@user/proxmox/vm`

Fleet-style VM lifecycle. Every method writes a `vm` resource keyed by VM name,
so downstream models can read it via CEL.

Global arguments: `apiUrl`, `ticket` and `csrfToken` (sensitive — wire them
from the node model's `node` resource with `data.latest`), `node`,
`skipTlsVerify` (default `true`).

| Method         | Arguments                                                                                           | Description                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookup`       | `vmName`                                                                                            | Resolve VM by name. Fetches IP via guest agent if running.                                                                                                     |
| `create`       | `vmName`, `memory?`, `cores?`, `sockets?`, `diskSize?`, `diskStorage?`, `networkBridge?`, `osType?` | Auto-allocates next vmid. Defaults: 2048MB, 2 cores, 32GB on `local-lvm`, `vmbr0`, `l26`, `agent=1`, PXE-first boot. Pass `diskSize: 0` for diskless PXE-only. |
| `start`        | `vmName`, `waitSeconds?` (120), `pollInterval?` (5)                                                 | Idempotent start. Throws if guest agent does not return an IPv4 within `waitSeconds`.                                                                          |
| `stop`         | `vmName`                                                                                            | Idempotent stop (no-ops if already stopped).                                                                                                                   |
| `delete`       | `vmName`                                                                                            | Stops first if running, then deletes. Best-effort stop — won't fail if already stopped.                                                                        |
| `setBootOrder` | `vmName`, `boot` (e.g. `order=scsi0;net0`)                                                          | Sets the `boot` config string via PUT `/qemu/{vmid}/config`.                                                                                                   |
| `setConfig`    | `vmName`, `config` (record of string→string)                                                        | Arbitrary VM config update. Empty `config` throws.                                                                                                             |
| `sync`         | none                                                                                                | Lists every VM on the node and writes one `vm` resource per VM (named after the VM). Resolves IPs only for running VMs (5s/2s retry budget).                   |

## Patterns

### Auth flow

`resolveAuth` checks three sources in order:

1. Explicit `ticket` + `csrfToken` in global args
2. (node model only) the model's own `node` resource, read with
   `readResource`, if written less than 2 hours ago
3. Username/password → `POST /access/ticket`

Always prepend an `auth` step in workflows. The `vm` model has no
username/password, so its definition must wire the tokens:

```yaml
globalArguments:
  ticket: '${{ data.latest("pve01", "node").attributes.ticket }}'
  csrfToken: '${{ data.latest("pve01", "node").attributes.csrfToken }}'
```

### Vault credentials

Pull `username`/`password` from a vault rather than hard-coding them. In the
model definition YAML for a `@user/proxmox/node` instance:

```yaml
modelType: "@user/proxmox/node"
name: pve01
globalArguments:
  apiUrl: https://192.0.2.10:8006
  node: pve01
  username: ${{ vault.get('proxmox', 'username') }}
  password: ${{ vault.get('proxmox', 'password') }}
```

### Wiring with CEL

Read fleet data downstream with the canonical CEL form (never use the deprecated
`model.<name>.resource.…` pattern):

```yaml
inputs:
  ip: '${{ data.latest("fleet", vmName).attributes.ip }}'
  vmid: '${{ data.latest("fleet", vmName).attributes.vmid }}'
```

Where `fleet` is the model instance name of a `@user/proxmox/vm` definition, and
`vmName` is the resource key written by `sync`/`create`/`start`/`lookup`.

### Workflow shape

Every shipped workflow follows the same two-step pattern: `auth` → action. Steps
reference instances by name (`keebDev02` for the node, `fleet` for the VM model
in this repo) — replace these with whatever the local definition YAMLs declare.

Minimal "start a VM" workflow:

```yaml
name: start-vm
inputs:
  vmName: { type: string, required: true }
jobs:
  - name: start
    steps:
      - name: auth
        task:
          type: model_method
          modelIdOrName: pve01 # @user/proxmox/node instance
          methodName: auth
        dependsOn: []
      - name: start-vm
        task:
          type: model_method
          modelIdOrName: fleet # @user/proxmox/vm instance
          methodName: start
          inputs:
            vmName: "${{ inputs.vmName }}"
        dependsOn:
          - { step: auth, condition: { type: succeeded } }
```

### Diskless PXE create

For PXE-only provisioning (e.g. swamp-alpine installer), pass `diskSize: 0` —
the model omits `scsi0` entirely and sets `boot=order=net0`. Add a disk later
via `setConfig` and flip the boot order with `setBootOrder`.

## Dependencies

- Declares `@keeb/ssh` in `manifest.yaml` (ships `lib/ssh.ts` for downstream
  extensions). The proxmox models themselves don't import it — it's bundled for
  siblings like `@keeb/alpine` that combine VM creation with SSH-driven
  configuration.

## Used by

- `@keeb/alpine` — builds on `create` + `setBootOrder` + `setConfig` to install
  Alpine over PXE.
- `@keeb/minecraft` — uses `start`/`stop` to manage game server VMs.

## Gotchas

- **HTTP via curl, not fetch.** All API calls go through `fetchWithCurl` (a
  validated `Deno.Command` shell-out) so `--insecure` handles self-signed PVE
  certs per request. Secrets go in a 0600 temp curl config file, never argv.
  Don't swap in `globalThis.fetch` — TLS verification will break against typical
  homelab nodes. `curl` must be installed.
- **Idempotency.** `create` returns the existing VM if the name is taken;
  `delete` succeeds if the VM is already gone; `stop`/`delete`/`create` throw
  if the Proxmox task does not finish `OK`. Tasks time out after 1 hour.
- **`spiceConnect` writes `spice-<vmName>`**, not `<vmName>`, so it never
  shadows the VM's own data.
- **`start` is strict about the guest agent.** It throws if no IPv4 comes back
  within `waitSeconds`. The VM must have `qemu-guest-agent` installed and
  `agent=1` set in config. New `create` calls already set `agent: "1"`, but the
  agent package still needs to be present in the image.
- **`lookup` failure message lists every VM name.** Cheap discovery — when a
  workflow errors with `VM "x" not found. Available: …`, that list is the source
  of truth for the fleet.
- **`setConfig` rejects empty input** with an explicit "No config params
  provided" error. Always pass at least one key.
- **`smbios1` carries the VM name** as a base64-encoded serial on `create` —
  downstream tooling can read it back from `dmidecode` without round-tripping to
  the API.
- **Auth reuse has a hard-coded 2h TTL.** The `node` model's `auth` method
  always logs in fresh; its other methods reuse the stored `node` resource.
- **`username` in returned auth metadata is `${user}@${realm}`**, not the bare
  username — important when comparing identities downstream.
- **`sync` uses a tight retry budget for IPs** (5s total, 2s interval) to keep
  fleet refreshes fast. Use `lookup` for an authoritative IP fetch on a single
  VM (15s budget).
