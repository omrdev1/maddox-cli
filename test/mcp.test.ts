import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMaddoxMcpServer } from "../src/mcp.js";

function makeTempProject() {
  const root = mkdtempSync(join(tmpdir(), "maddox-mcp-"));
  mkdirSync(join(root, "src", "components"), { recursive: true });
  writeFileSync(
    join(root, "theme.css"),
    `@theme {
  --color-bg-surface: #0a0a0b;
  --color-text-primary: #f0f0f2;
  --color-brand-mint: #2ee6b8;
  --text-sm: 14px;
  --spacing-4: 16px;
  --spacing-5: 20px;
}
`
  );
  writeFileSync(
    join(root, "motion.json"),
    JSON.stringify({ fast: { duration: 0.15 }, normal: { duration: 0.25 } })
  );
  writeFileSync(
    join(root, "maddox.config.json"),
    JSON.stringify({
      project: "sample-app",
      theme: "theme.css",
      source: "src",
      motion: "motion.json",
    })
  );
  writeFileSync(
    join(root, "src", "components", "Button.tsx"),
    `export function Button() {
  return <button className="bg-[#2ee5b7] p-[19px] text-[15px]">Save</button>;
}
`
  );
  writeFileSync(
    join(root, "src", "components", "Clean.tsx"),
    `export function Clean() {
  return <div style={{ color: "var(--color-text-primary)" }}>OK</div>;
}
`
  );
  writeFileSync(
    join(root, "src", "components", "Button.test.tsx"),
    `export const fixture = "#123456";\n`
  );
  return root;
}

async function connectPair(
  rootDir: string,
  options: { clientRoots?: string[] } = {}
) {
  const server = createMaddoxMcpServer({ rootDir, version: "0.12.0" });
  const client = new Client(
    { name: "maddox-test-client", version: "1.0.0" },
    options.clientRoots ? { capabilities: { roots: {} } } : undefined
  );

  if (options.clientRoots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: options.clientRoots!.map((p) => ({
        uri: pathToFileURL(p).href,
        name: "workspace",
      })),
    }));
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("lists all four read-only, closed-world tools", async () => {
  const root = makeTempProject();
  const pair = await connectPair(root);
  try {
    const { tools } = await pair.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["check_code", "find_token", "get_design_tokens", "scan_project"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not be destructive`);
      assert.equal(tool.annotations?.openWorldHint, false, `${tool.name} must be closed-world`);
    }
  } finally {
    await pair.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_design_tokens returns tokens, filters by kind, and respects limit cap", async () => {
  const root = makeTempProject();
  const pair = await connectPair(root);
  try {
    const all = await pair.client.callTool({ name: "get_design_tokens", arguments: {} });
    const allData = all.structuredContent as { total: number; tokens: { name: string; kind: string }[] };
    assert.equal(all.isError, undefined);
    assert.ok(allData.total >= 7);
    assert.ok(allData.tokens.some((t) => t.name === "--color-brand-mint" && t.kind === "color"));
    assert.ok(allData.tokens.some((t) => t.name === "fast.duration" && t.kind === "motion"));

    const colors = await pair.client.callTool({ name: "get_design_tokens", arguments: { kind: "color", limit: 2 } });
    const colorData = colors.structuredContent as { total: number; truncated: number; tokens: { kind: string }[] };
    assert.equal(colorData.tokens.length, 2);
    assert.equal(colorData.truncated, colorData.total - 2);
    assert.ok(colorData.tokens.every((t) => t.kind === "color"));
  } finally {
    await pair.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("find_token resolves exact matches, near-misses, and unrecognized values", async () => {
  const root = makeTempProject();
  const pair = await connectPair(root);
  try {
    const exact = await pair.client.callTool({ name: "find_token", arguments: { value: "#2ee6b8" } });
    const exactData = exact.structuredContent as { matched: boolean; nearestToken: string };
    assert.equal(exactData.matched, true);
    assert.equal(exactData.nearestToken, "--color-brand-mint");

    const near = await pair.client.callTool({
      name: "find_token",
      arguments: { value: "#2ee5b7", kind: "color", role: "bg" },
    });
    const nearData = near.structuredContent as { severity: string; nearestToken: string; suggestion?: string };
    assert.equal(nearData.severity, "near-miss");
    assert.equal(nearData.nearestToken, "--color-brand-mint");
    assert.ok(nearData.suggestion);

    const far = await pair.client.callTool({ name: "find_token", arguments: { value: "#ff00ff", kind: "color" } });
    const farData = far.structuredContent as { severity: string };
    assert.equal(farData.severity, "unrecognized");
  } finally {
    await pair.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("check_code checks disk files, proposed content, skips tests, and confines paths", async () => {
  const root = makeTempProject();
  const pair = await connectPair(root);
  try {
    const disk = await pair.client.callTool({
      name: "check_code",
      arguments: { file: "src/components/Button.tsx" },
    });
    const diskData = disk.structuredContent as { status: string; totalDrift: number; findings: { kind: string }[] };
    assert.equal(diskData.status, "checked");
    assert.ok(diskData.totalDrift >= 2);

    const proposedClean = await pair.client.callTool({
      name: "check_code",
      arguments: {
        file: "src/components/Button.tsx",
        content: `export const Button = () => <button style={{ color: "var(--color-brand-mint)" }}>Save</button>;`,
      },
    });
    const cleanData = proposedClean.structuredContent as { status: string; totalDrift: number };
    assert.equal(cleanData.status, "checked");
    assert.equal(cleanData.totalDrift, 0);

    const skipped = await pair.client.callTool({
      name: "check_code",
      arguments: { file: "src/components/Button.test.tsx" },
    });
    const skippedData = skipped.structuredContent as { status: string };
    assert.equal(skippedData.status, "skipped");

    const escaped = await pair.client.callTool({
      name: "check_code",
      arguments: { file: "../../etc/passwd" },
    });
    assert.equal(escaped.isError, true);

    const oversized = await pair.client.callTool({
      name: "check_code",
      arguments: { file: "src/components/Button.tsx", content: "a".repeat(1_000_050) },
    });
    assert.equal(oversized.isError, true);
  } finally {
    await pair.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan_project returns local score, counts, scoped paths, and blocks root escape", async () => {
  const root = makeTempProject();
  const pair = await connectPair(root);
  try {
    const full = await pair.client.callTool({ name: "scan_project", arguments: {} });
    const fullData = full.structuredContent as {
      label: string;
      project: string;
      score: number;
      filesScanned: number;
      totalDrift: number;
      counts: { match: number; nearMiss: number; unrecognized: number; missing: number };
    };
    assert.equal(fullData.label, "local");
    assert.equal(fullData.project, "sample-app");
    assert.equal(fullData.filesScanned, 2); // Button.tsx + Clean.tsx (Button.test.tsx skipped)
    assert.ok(fullData.score >= 0 && fullData.score < 100);
    assert.ok(fullData.totalDrift >= 2);

    const scoped = await pair.client.callTool({
      name: "scan_project",
      arguments: { paths: ["src/components/Clean.tsx"] },
    });
    const scopedData = scoped.structuredContent as { filesScanned: number; totalDrift: number; score: number };
    assert.equal(scopedData.filesScanned, 1);
    assert.equal(scopedData.totalDrift, 0);
    assert.equal(scopedData.score, 100);

    const escape = await pair.client.callTool({
      name: "scan_project",
      arguments: { paths: ["../"] },
    });
    assert.equal(escape.isError, true);
  } finally {
    await pair.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshes cached ground truth when theme.css changes on disk", async () => {
  const root = makeTempProject();
  const pair = await connectPair(root);
  try {
    const before = await pair.client.callTool({ name: "find_token", arguments: { value: "#3366ff", kind: "color" } });
    assert.equal((before.structuredContent as { matched: boolean }).matched, false);

    const themePath = join(root, "theme.css");
    writeFileSync(
      themePath,
      `@theme {\n  --color-brand-blue: #3366ff;\n}\n`
    );
    const future = new Date(Date.now() + 5000);
    utimesSync(themePath, future, future);

    const after = await pair.client.callTool({ name: "find_token", arguments: { value: "#3366ff", kind: "color" } });
    const afterData = after.structuredContent as { matched: boolean; nearestToken: string };
    assert.equal(afterData.matched, true);
    assert.equal(afterData.nearestToken, "--color-brand-blue");
  } finally {
    await pair.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers MCP client roots over fallback rootDir and handles missing config gracefully", async () => {
  const projectRoot = makeTempProject();
  const emptyRoot = mkdtempSync(join(tmpdir(), "maddox-empty-"));
  mkdirSync(join(emptyRoot, ".git")); // stop findConfig walk at emptyRoot

  const pairWithRoots = await connectPair(emptyRoot, { clientRoots: [projectRoot] });
  const pairNoConfig = await connectPair(emptyRoot);
  try {
    const res = await pairWithRoots.client.callTool({ name: "get_design_tokens", arguments: {} });
    assert.equal(res.isError, undefined);
    assert.equal((res.structuredContent as { project: string }).project, "sample-app");

    const missing = await pairNoConfig.client.callTool({ name: "get_design_tokens", arguments: {} });
    assert.equal(missing.isError, true);
  } finally {
    await pairWithRoots.close();
    await pairNoConfig.close();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});
