# @keeb/proxmox

[Swamp](https://github.com/systeminit/swamp) extension for Proxmox VE API authentication and VM fleet lifecycle management.

## Models

### `proxmox/node`

Authenticate with a Proxmox VE node and cache auth tickets.

| Method | Description |
|--------|-------------|
| `auth` | Authenticate and write ticket + CSRF token as a named resource |

### `proxmox/vm`

Fleet-style VM lifecycle management. Every method writes a named resource per VM, enabling CEL-based wiring to downstream models.

| Method | Description |
|--------|-------------|
| `lookup` | Look up a VM by name and write its current state |
| `create` | Create a new VM (PXE boot, default specs) |
| `start` | Start a VM and wait for IP via guest agent |
| `stop` | Stop a VM |
| `delete` | Delete a VM (stops first if running) |
| `setBootOrder` | Set VM boot order |
| `setConfig` | Set arbitrary VM config options |
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

## Dependencies

- [@keeb/ssh](https://github.com/keeb/swamp-ssh) — SSH helpers (`lib/ssh.ts`)

## Used by

- [swamp-alpine](https://github.com/keeb/swamp-alpine) — VM creation + Alpine disk install
- [swamp-minecraft](https://github.com/keeb/swamp-minecraft) — VM start/stop for game servers

## Install

```bash
swamp extension pull @keeb/proxmox
```

## License

MIT
