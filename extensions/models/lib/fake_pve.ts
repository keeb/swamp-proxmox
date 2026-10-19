// Test-only helper: a fake Proxmox API served through a mocked `curl`.
// Not imported by any model, so it is never bundled or published.
import { withMockedCommand } from "jsr:@systeminit/swamp-testing@0.20260604.20";
import { STATUS_MARKER } from "./proxmox.ts";

/** A request as curl would have sent it. */
export interface FakeRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  args: string[];
}

/** What the fake server answers with. */
export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  /** Simulate curl itself failing (non-zero exit). */
  curlExit?: number;
}

/** Parse a double-quoted curl config value back to its raw string. */
export function unquoteCurlConfig(quoted: string): string {
  const inner = quoted.slice(1, -1);
  return inner.replace(/\\(.)/g, (_m, c) => {
    switch (c) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c;
    }
  });
}

/** Parse the config file fetchWithCurl writes. */
export function parseCurlConfig(text: string) {
  let method = "GET";
  const headers: Record<string, string> = {};
  let body: string | undefined;
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z-]+) = (".*")$/);
    if (!m) continue;
    const value = unquoteCurlConfig(m[2]);
    if (m[1] === "request") method = value;
    else if (m[1] === "header") {
      const i = value.indexOf(": ");
      headers[value.slice(0, i)] = value.slice(i + 2);
    } else if (m[1] === "data-raw") body = value;
  }
  return { method, headers, body };
}

/**
 * Run `fn` with Deno.Command mocked so every curl call is answered by
 * `handler`. Returns `fn`'s result plus every request seen.
 */
export async function withFakePve<T>(
  handler: (req: FakeRequest) => FakeReply | Promise<FakeReply>,
  fn: () => Promise<T>,
): Promise<{ result: T; requests: FakeRequest[] }> {
  const requests: FakeRequest[] = [];
  const { result } = await withMockedCommand(
    async (command: string, args: string[]) => {
      if (command !== "curl") {
        return {
          code: 127,
          stdout: "",
          stderr: `unexpected command ${command}`,
        };
      }
      const configPath = args[args.indexOf("--config") + 1];
      const cfg = parseCurlConfig(await Deno.readTextFile(configPath));
      const req: FakeRequest = {
        ...cfg,
        url: new URL(args[args.indexOf("--url") + 1]),
        args,
      };
      requests.push(req);
      const reply = await handler(req);
      if (reply.curlExit) {
        return {
          code: reply.curlExit,
          stdout: "",
          stderr: "curl: (7) Failed to connect",
        };
      }
      const body = reply.text ?? JSON.stringify(reply.json ?? null);
      return {
        code: 0,
        stdout: `${body}\n${STATUS_MARKER}${reply.status ?? 200}`,
        stderr: "",
      };
    },
    fn,
  );
  return { result, requests };
}

/** Shorthand for a successful `{ data }` envelope. */
export function ok(data: unknown): FakeReply {
  return { status: 200, json: { data } };
}

/** Task-status route answering "stopped" with the given exit status. */
export function taskDone(exitstatus = "OK"): FakeReply {
  return ok({ status: "stopped", exitstatus });
}
