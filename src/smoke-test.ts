/**
 * Hosted-protocol smoke check.
 *
 * Initializes a real MCP session against a deployed (or local) endpoint,
 * lists the available tools, calls investigate_payment_incident on a
 * known seed checkout_reference, and writes the raw results to
 * smoke-test-output.json — so the deployed protocol behavior can be
 * reproduced and inspected without needing to run the full test suite
 * or set up a local environment.
 *
 * Usage:
 *   MCP_URL=https://<your-app>.onrender.com/mcp npx tsx src/smoke-test.ts
 *
 * Defaults to http://localhost:3000/mcp if MCP_URL is not set.
 */

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const CHECKOUT_REFERENCE = process.env.SMOKE_CHECKOUT_REF ?? "chk_incident_001";

interface StepResult {
  step: string;
  request: unknown;
  rawResponseText: string;
  parsed: unknown;
}

const results: StepResult[] = [];

/**
 * The server responds using Streamable HTTP / SSE framing
 * ("event: message\ndata: {...}") when the client sends
 * Accept: text/event-stream, rather than a bare JSON body. This pulls the
 * JSON payload out of the "data:" line before parsing it.
 */
function parseSseOrJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const dataLine = trimmed
    .split("\n")
    .find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`Could not find a data: line in response:\n${rawText}`);
  }
  return JSON.parse(dataLine.replace(/^data:\s*/, ""));
}

async function postMcp(
  body: unknown,
  sessionId?: string
): Promise<{ res: Response; text: string; parsed: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text.trim() ? parseSseOrJson(text) : null;
  return { res, text, parsed };
}

async function main() {
  console.log(`Running hosted-protocol smoke check against: ${MCP_URL}\n`);

  // ---- Step 1: initialize ----
  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0" },
    },
  };
  const { res: initRes, text: initText, parsed: initParsed } = await postMcp(initBody);
  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(
      `No mcp-session-id header returned from initialize. Status: ${initRes.status}. Body: ${initText}`
    );
  }
  console.log(`✓ Session established: ${sessionId}`);
  results.push({ step: "initialize", request: initBody, rawResponseText: initText, parsed: initParsed });

  // ---- Step 2: notifications/initialized ----
  const notifyBody = { jsonrpc: "2.0", method: "notifications/initialized" };
  await postMcp(notifyBody, sessionId);
  console.log(`✓ Session initialized`);

  // ---- Step 3: tools/list ----
  const listBody = { jsonrpc: "2.0", id: 2, method: "tools/list" };
  const { text: listText, parsed: listParsed } = await postMcp(listBody, sessionId);
  const toolNames =
    (listParsed as any)?.result?.tools?.map((t: any) => t.name).join(", ") ?? "(unable to parse tool list)";
  console.log(`✓ tools/list returned: ${toolNames}`);
  results.push({ step: "tools/list", request: listBody, rawResponseText: listText, parsed: listParsed });

  // ---- Step 4: tools/call investigate_payment_incident ----
  const callBody = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "investigate_payment_incident",
      arguments: { checkout_reference: CHECKOUT_REFERENCE },
    },
  };
  const { text: callText, parsed: callParsed } = await postMcp(callBody, sessionId);
  console.log(`✓ tools/call investigate_payment_incident (${CHECKOUT_REFERENCE}) completed`);
  results.push({ step: "tools/call:investigate_payment_incident", request: callBody, rawResponseText: callText, parsed: callParsed });

  // ---- Write raw results ----
  const fs = await import("node:fs");
  fs.writeFileSync("smoke-test-output.json", JSON.stringify(results, null, 2));
  console.log(`\nRaw results written to smoke-test-output.json`);

  // Basic pass/fail signal for CI-style usage.
  const callResultText = (callParsed as any)?.result?.content?.[0]?.text;
  if (!callResultText) {
    console.error("\nFAIL: tools/call did not return expected content.");
    process.exit(1);
  }
  const investigationResult = JSON.parse(callResultText);
  console.log(`\nInvestigation status for ${CHECKOUT_REFERENCE}: ${investigationResult.status}`);
  console.log("\nSmoke check passed.");
}

main().catch((err) => {
  console.error("\nSmoke check failed:", err);
  process.exit(1);
});
