/**
 * What `kodel init` writes for each coding agent: where its MCP server list and its skills live,
 * and how the server is added to its project config.
 */
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import {
  addToList,
  type Context,
  editFile,
  editJson,
  managedBlock,
  objectAt,
  SkipEdit,
} from "./files";

export type AgentId = "claude-code" | "codex" | "opencode";

export interface ServerCommand {
  command: string;
  args: string[];
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** Checked on a real agent. The others are written to the agent's documented format only. */
  verified: boolean;
  /** The binary a person types to start it. */
  binary: string;
  /** Files or directories in a project that show the project already uses the agent. */
  markers: string[];
  /** Where skills go: `<dir>/<name>/SKILL.md`. */
  skillsDir: string;
  /** Add the server to the agent's project config. */
  connect(ctx: Context, server: ServerCommand): Promise<void>;
}

const MCP_NAME = "kodel";

/** Put our server entry in; one the person set up differently stays unless `--force`. */
function setServer(
  ctx: Context,
  servers: Record<string, unknown>,
  entry: Record<string, unknown>,
): void {
  const existing = servers[MCP_NAME];
  if (existing !== undefined && !ctx.force && JSON.stringify(existing) !== JSON.stringify(entry)) {
    throw new SkipEdit(
      `a different "${MCP_NAME}" server is set up; left as it was (--force replaces it)`,
    );
  }
  servers[MCP_NAME] = entry;
}

const claudeCode: AgentAdapter = {
  id: "claude-code",
  label: "Claude Code",
  verified: true,
  binary: "claude",
  markers: [".claude", "CLAUDE.md", ".mcp.json"],
  skillsDir: ".claude/skills",
  async connect(ctx, server) {
    await editFile(ctx, ".mcp.json", (previous) =>
      editJson(previous, (config) =>
        setServer(ctx, objectAt(config, "mcpServers"), {
          command: server.command,
          args: server.args,
        }),
      ),
    );
    // Without our server in .mcp.json the permission would apply to whatever `kodel` points to.
    const connected = ctx.changes.at(-1);
    if (connected?.status === "skipped") {
      connected.note = `${connected.note}; .claude/settings.json was not changed either`;
      return;
    }
    await editFile(ctx, ".claude/settings.json", (previous) =>
      editJson(previous, (settings) => {
        addToList(settings, "enabledMcpjsonServers", [MCP_NAME]);
        addToList(objectAt(settings, "permissions"), "allow", [`mcp__${MCP_NAME}`]);
      }),
    );
  },
};

const CODEX_BEGIN = "# kodel:begin";
const CODEX_END = "# kodel:end";

const codex: AgentAdapter = {
  id: "codex",
  label: "Codex",
  verified: false,
  binary: "codex",
  markers: [".codex"],
  skillsDir: ".agents/skills",
  async connect(ctx, server) {
    // JSON strings are valid TOML basic strings.
    const body = [
      `[mcp_servers.${MCP_NAME}]`,
      `command = ${JSON.stringify(server.command)}`,
      `args = ${JSON.stringify(server.args)}`,
    ].join("\n");
    await editFile(ctx, ".codex/config.toml", (previous) => {
      const outside = (previous ?? "").replace(
        new RegExp(`${CODEX_BEGIN}[\\s\\S]*?${CODEX_END}`),
        "",
      );
      // `[mcp_servers.kodel]`, `[mcp_servers."kodel"]`, `[mcp_servers.kodel.env]`, with or without spaces.
      if (/^\s*\[\s*mcp_servers\s*\.\s*["']?kodel["']?\s*[\].]/m.test(outside)) {
        return { skip: `[mcp_servers.${MCP_NAME}] is already defined by hand; left as it was` };
      }
      return managedBlock(previous, CODEX_BEGIN, CODEX_END, body);
    });
  },
};

const opencode: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  verified: false,
  binary: "opencode",
  markers: ["opencode.json", "opencode.jsonc", ".opencode"],
  skillsDir: ".opencode/skills",
  async connect(ctx, server) {
    // `opencode.jsonc` may carry comments that a rewrite would lose: the person edits that one.
    if (
      await access(join(ctx.root, "opencode.jsonc"), constants.F_OK).then(
        () => true,
        () => false,
      )
    ) {
      ctx.changes.push({
        path: "opencode.jsonc",
        status: "skipped",
        note: `add the "${MCP_NAME}" server to "mcp" yourself: { "type": "local", "command": ${JSON.stringify([server.command, ...server.args])}, "enabled": true }`,
      });
      return;
    }
    await editFile(ctx, "opencode.json", (previous) =>
      editJson(previous, (config) => {
        if (config.$schema === undefined) config.$schema = "https://opencode.ai/config.json";
        return setServer(ctx, objectAt(config, "mcp"), {
          type: "local",
          command: [server.command, ...server.args],
          enabled: true,
        });
      }),
    );
  },
};

export const AGENTS: readonly AgentAdapter[] = [claudeCode, codex, opencode];

export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id);

async function exists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

async function onPath(binary: string, path: string | undefined): Promise<boolean> {
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of [binary, `${binary}.exe`, `${binary}.cmd`]) {
      if (
        await access(join(dir, name), constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
  }
  return false;
}

/** The agents this machine or this project already uses. */
export async function detectAgents(
  root: string,
  environment: Record<string, string | undefined>,
): Promise<AgentAdapter[]> {
  const found: AgentAdapter[] = [];
  for (const agent of AGENTS) {
    const inProject = await Promise.all(agent.markers.map((m) => exists(join(root, m))));
    if (inProject.some(Boolean) || (await onPath(agent.binary, environment.PATH))) {
      found.push(agent);
    }
  }
  return found;
}
