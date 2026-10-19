# @keeb/proxmox

[Swamp](https://github.com/systeminit/swamp) extension for Proxmox VE API authentication and VM fleet lifecycle management.

## Models

### `@keeb/proxmox/node`

Authenticate with a Proxmox VE node and inspect it. `password` is a sensitive
argument — supply it from a vault.

| Method | Description |
|--------|-------------|
| `auth` | Log in and write ticket + CSRF token as the `node` resource (sensitive fields, vaulted) |
| `status` | Write node memory / CPU / uptime as the `status` resource |
| `storageList` | Write one `storage` resource per storage pool |
| `isoList` | Write one `iso` resource per ISO on a storage |
| `downloadIso` | Download an ISO server-side onto a storage (skips if already present) |

Methods other than `auth` reuse the `node` resource's ticket while it is less
than 2 hours old, and log in again otherwise.

### `@keeb/proxmox/vm`

Fleet-style VM lifecycle management. Every method writes a named resource per VM, enabling CEL-based wiring to downstream models. `ticket` and `csrfToken` are sensitive arguments — wire them from the node model's `node` resource (see the example).

| Method | Description |
|--------|-------------|
| `lookup` | Look up a VM by name and write its current state |
| `create` | Create a new VM (PXE boot, default specs); no-op if the name already exists |
| `start` | Start a VM and wait for IP via guest agent |
| `stop` | Stop a VM (no-op if already stopped) |
| `delete` | Delete a VM (stops first if running; succeeds if already gone) |
| `setBootOrder` | Set VM boot order |
| `setConfig` | Set arbitrary VM config options |
| `spiceConnect` | Write a virt-viewer `.vv` file (mode 0600) and a `spice-<vmName>` resource |
| `sync` | Sync all VMs from the Proxmox node into fleet named resources |

## Workflows

| Workflow | Description |
|----------|-------------|
| `sync-fleet` | Authenticate + sync all VMs into fleet |
| `start-vm` | Start any VM by name |
| `stop-vm` | Stop any VM by name |
| `create-vm` | Create a new VM by name |
| `delete-vm` | Delete a VM by name |
| `vm-lifecycle-test` | Full create/start/stop/delete test cycle |
| `guest-agent-test` | Create, start, validate IP via guest agent, cleanup |

## Subprocess use (`curl`)

All Proxmox API calls are made by spawning the `curl` binary (`Deno.Command`)
instead of using `fetch`. Proxmox nodes usually serve a self-signed
certificate, and Deno's `fetch` cannot skip TLS verification per request; curl's
`--insecure` is applied only to that request, and only when `skipTlsVerify` is
`true` (the default — set it to `false` once the node has a trusted cert).

- `curl` must be on the `PATH` of the machine running swamp.
- Every request is validated before curl runs: the URL must parse as `http`/`https`
  without embedded credentials, the method must be one of `GET`, `POST`, `PUT`,
  `DELETE`, header names must be `[A-Za-z0-9-]+`, header values may not contain
  control characters, and the body may not contain NUL bytes. Protocols are
  restricted with `--proto =http,https`, with a 10s connect and 300s total timeout.
- Secrets never appear on curl's command line: the auth cookie, CSRF token and
  login form are written to a temporary curl config file (mode `0600`) that is
  deleted after the call.

## Dependencies

- [@keeb/ssh](https://github.com/keeb/swamp-ssh) — SSH helpers (`lib/ssh.ts`)

## Used by

- [swamp-alpine](https://github.com/keeb/swamp-alpine) — VM creation + Alpine disk install
- [swamp-minecraft](https://github.com/keeb/swamp-minecraft) — VM start/stop for game servers

## Install

```bash
swamp extension pull @keeb/proxmox
```

## Example

Authenticate against a Proxmox node, then start a VM and read its guest-agent IP from downstream steps:

```yaml
models:
  - name: pve
    type: "@keeb/proxmox/node"
    globalArguments:
      apiUrl: "https://192.0.2.10:8006"
      username: "${{ vault.get('proxmox', 'username') }}"
      password: "${{ vault.get('proxmox', 'password') }}"
      realm: "pam"
      node: "pve01"
  - name: vm
    type: "@keeb/proxmox/vm"
    globalArguments:
      apiUrl: "https://192.0.2.10:8006"
      ticket: '${{ data.latest("pve", "node").attributes.ticket }}'
      csrfToken: '${{ data.latest("pve", "node").attributes.csrfToken }}'
      node: "pve01"

jobs:
  - name: boot-vm
    steps:
      - model: pve
        method: auth
      - model: vm
        method: start
        inputs: { vmName: "web01", waitSeconds: 120 }
```

## License

MIT
