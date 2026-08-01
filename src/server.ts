import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import "dotenv/config";
import { pool } from "./db.js";
import { investigatePaymentIncident, getEscalationStatus, listOpenEscalations } from "./investigate.js";

function buildServer() {
  const server = new McpServer({
    name: "commerce-incident-investigator",
    version: "1.0.0",
  });

  server.registerTool(
    "investigate_payment_incident",
    {
      title: "Investigate payment/order incident",
      description:
        "Investigates whether a captured payment is missing its corresponding order. " +
        "Read-only with respect to payment and order state. If the payment is captured, " +
        "the documented buffer window has elapsed, and no order exists for the checkout_reference, " +
        "this creates (or updates, if one is already open) a durable human-review escalation with " +
        "evidence, a confidence level, and a recommended manual action. It never automatically " +
        "recreates orders, retries, voids, captures, or refunds payments. Use this when a customer " +
        "reports 'I paid but never got an order confirmation.'",
      inputSchema: {
        checkout_reference: z
          .string()
          .describe("The checkout_reference shared by the payment and, if it exists, the order."),
      },
    },
    async ({ checkout_reference }) => {
      const result = await investigatePaymentIncident(pool, checkout_reference);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_escalation_status",
    {
      title: "Get escalation status",
      description:
        "Read-only lookup of the most recent incident escalation for a given checkout_reference, " +
        "if one exists. Use this to check whether an incident has already been investigated and " +
        "what its current review status is, before deciding whether to re-run an investigation.",
      inputSchema: {
        checkout_reference: z.string().describe("The checkout_reference to look up."),
      },
    },
    async ({ checkout_reference }) => {
      const escalation = await getEscalationStatus(pool, checkout_reference);
      return {
        content: [
          {
            type: "text",
            text: escalation
              ? JSON.stringify(escalation, null, 2)
              : `No escalation found for checkout_reference '${checkout_reference}'.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_open_escalations",
    {
      title: "List open escalations",
      description:
        "Lists incident escalations that are currently 'open' or 'acknowledged' (i.e. still " +
        "awaiting or undergoing human review), ordered oldest-first. Use this to give the " +
        "operations team a queue of unresolved payment/order mismatch incidents.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe("Max results (default 20)."),
      },
    },
    async ({ limit }) => {
      const rows = await listOpenEscalations(pool, limit ?? 20);
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});


const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

app.post("/mcp", async (req, res) => {
  const existingSessionId = req.header("mcp-session-id");

  try {
    if (existingSessionId && sessions.has(existingSessionId)) {
      const { transport } = sessions.get(existingSessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session yet — this must be an initialize request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).send("Unknown or missing mcp-session-id");
    return;
  }
  await session.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).send("Unknown or missing mcp-session-id");
    return;
  }
  await session.transport.handleRequest(req, res);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Commerce Incident Investigator MCP server listening on :${port}`);
  console.log(`MCP endpoint: POST /mcp`);
});
