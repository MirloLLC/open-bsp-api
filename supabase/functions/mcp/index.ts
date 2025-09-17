import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "npm:@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "@hono/hono";
import { createApiClient } from "../_shared/supabase.ts";

const app = new Hono();

const server = new McpServer({
  name: "open-bsp-api",
  version: "1.0.0",
});

let token: string | undefined = undefined;
let config: string | undefined = undefined;

/*
# Exposing built-in tools through the MCP server

Each "tool" (toolkit, really) such as sql, http, etc. might require dedicated MCP server
in order to keep the tools organized. For example, mcp/sql, mcp/http, etc.

TODO: Because tools do not connect to the database, the token should be checked against the api_keys table.

For tools that need a config object, we can use the following approach (client-side):
1. Set config object.
   For mcp/http it would be `const config = { headers: { Authorization: "Bearer <token>" }`
2. Stringify the config object, then encode it to URL-safe.
3. Pass the encoded config object as a query parameter to the MCP server.
   For example, `http://localhost:3000/mcp/http?config=...`

```ts
server.registerTool(
  RequestTool.name,
  {
    title: RequestTool.name,
    description: RequestTool.description || "",
    inputSchema: {
      url: z.string(),
      method: z.string(),
    },
  },
  RequestTool.implementation
);
```

This kinda works but not quite. MCP SDK is stuck at Zod v3. We are using v4.
TODO: wait a month or so... https://github.com/modelcontextprotocol/typescript-sdk/pull/869
*/

server.tool(
  "send-message",
  "Sends a message to the user.",
  {},
  async (input): Promise<CallToolResult> => {
    if (config) {
      config = JSON.parse(config);
    }

    const client = createApiClient(token);

    const { data, error } = await client.from("messages").insert({
      direction: "outgoing",
      organization_address: "3a182d8d-d6d8-44bd-b021-029915476b8c",
      contact_address: "121e5fcd-e796-4455-9ac9-ee9b7cb185c8",
      service: "local",
      type: "outgoing",
      message: { type: "text", content: "Hello!" },
    });

    if (error) {
      return {
        content: [{ type: "text", text: error.message }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: "Message sent",
        },
      ],
    };
  }
);

app.all("/mcp", async (c) => {
  token = c.req.header("Authorization")?.replace("Bearer ", "");
  let config = c.req.query("config");

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  // @ts-ignore inocuous type error
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
