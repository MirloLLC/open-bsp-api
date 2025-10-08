import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  type AgentRow,
  createClient,
  type LocalMCPToolConfig,
  type MessageInsert,
  type MessageRow,
  type MessageRowV1,
  type Part,
  type TextPart,
  type ToolInfo,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import { fromV1, toV1 } from "../_shared/messages-v0.ts";
import { ProtocolFactory } from "./protocols/index.ts";
import { callTool, initMCP, type MCPServer } from "./tools/mcp.ts";
import { Toolbox } from "./tools/index.ts";
import { z } from "zod";
import Ajv2020 from "ajv";
import type { Json } from "../_shared/db_types.ts";
import type { AgentRowWithExtra, ResponseContext } from "./protocols/base.ts";
import { TransferToHumanAgentTool } from "./tools/handoff.ts";

export type AgentTool = {
  provider: "local";
  type: "function" | "custom" | "mcp" | "http" | "sql";
  label?: string;
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.JSONSchema;
  outputSchema?: z.core.JSONSchema.JSONSchema;
  implementation?: any;
  config?: any;
};

const PAUSED_CONV_WINDOW = 12 * 60 * 60 * 1000; // 12 hours
const MESSAGES_TIME_LIMIT = 7 * 24 * 60 * 60 * 1000; // 7 days
const MESSAGES_QUANTITY_LIMIT = 50;
const RESPONSE_DELAY_SECS = 3; // 3 seconds
const ANNOTATION_TIMEOUT = 30 * 1000; // 30 seconds
const ANNOTATION_POLLING_INTERVAL = 5 * 1000; // 5 seconds

/**
 * timestamp vs created_at
 *
 *  - timestamp is given by the service (i.e. WhatsApp) servers.
 *  - created_at is the insertion timestamp in our database.
 *
 *  The contact might send several messages very close in time. The goal is to react
 *  once for the whole batch. Each message will trigger a function. Only one of them
 *  should go through. The selection criteria is the function corresponding to the
 *  newest message by created_at.
 *
 *  The newest message might not be the one with the latest timestamp. The order of
 *  arrival is not guaranteed. Anyway, messages are ordered by timestamp, hence the
 *  agent will get the conversation history in the correct order.
 */

function isNewestMessage(incoming: MessageRow, messages: MessageRowV1[]) {
  const incomingCreatedAt = new Date(incoming.created_at);

  const sortedMessages = messages
    .filter((m) => new Date(m.created_at) >= incomingCreatedAt)
    .sort((a, b) => {
      const dateA = +new Date(a.created_at);
      const dateB = +new Date(b.created_at);

      if (dateA !== dateB) {
        return dateB - dateA; // descending by created_at
      }

      // If created_at is the same, order by id descending
      if (a.id < b.id) return 1;
      if (a.id > b.id) return -1;
      return 0;
    });

  const newestMessage = sortedMessages[0];

  return newestMessage.id === incoming.id;
}

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    // TODO: SERVICE_ROLE_KEY might be the new secret key
    // but we are sending the legacy one because the new one does not work
    // with PostgREST yet
    // This check is needed to not to respond to the anon / public key
    //return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const client = createClient(req);

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  // RETRIEVE CONVERSATION + ORGANIZATION + CONTACT + AGENTS (via organization, one-hop join)

  const { data: conv, error: convError } = await client
    .from("conversations")
    .select(`*, organizations (*, agents (*)), contacts (*)`)
    .eq("organization_address", incoming.organization_address)
    .eq("contact_address", incoming.contact_address)
    .single();

  if (convError) {
    throw convError;
  }

  if (!conv.extra) {
    conv.extra = {};
  }

  const { organizations: org, contacts: contact, ...conversation } = conv;

  if (!org.extra) {
    org.extra = {};
  }

  const { agents, ...organization } = org;

  // CHECK IF CONTACT IS ALLOWED

  /**
   * Default behavior: Respond to all contacts.
   *
   * When org.extra.authorized_contacts_only is true, only respond to allowed contacts.
   *
   * An allowed contact has the contact.extra.allowed field set to true.
   */

  if (
    conv.service !== "local" &&
    org.extra.authorized_contacts_only &&
    !contact?.extra?.allowed
  ) {
    log.info(
      `Conversation ${conv.name} does not correspond to an authorized contact. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF CONVERSATION IS PAUSED

  if (
    conv.extra.paused &&
    +new Date(conv.extra.paused) > +new Date() - PAUSED_CONV_WINDOW
  ) {
    log.info(`Conversation with ${conv.name} is paused. Skipping response.`);

    return new Response("ok", { headers: corsHeaders });
  }

  // WAIT FOR A NEWER MESSAGE

  const delay =
    (org.extra.response_delay_seconds ?? RESPONSE_DELAY_SECS) * 1000;

  if (delay > 0) {
    log.info(`Waiting ${delay}ms before processing the message...`);

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  // RETRIEVE MESSAGES

  const { data: messages_v0, error: messagesError } = await client
    .from("messages")
    .select()
    .eq("organization_address", conv.organization_address)
    .gt("timestamp", new Date(+new Date() - MESSAGES_TIME_LIMIT).toISOString()) // Time constraint for the conversation.
    .lte("timestamp", new Date().toISOString()) // Scheduled messages have a future timestamp.
    .eq("contact_address", conv.contact_address)
    .order("timestamp", { ascending: false })
    .limit(MESSAGES_QUANTITY_LIMIT); // Size constraint for the conversation.

  if (messagesError) {
    throw messagesError;
  }

  const messages = messages_v0.map(toV1).filter(Boolean) as MessageRowV1[];

  // Query was done in descending order to apply the limit.
  // We need the messages in chronological order, though.
  messages.reverse();

  // CHECK IF THERE IS A NEWER MESSAGE

  if (!isNewestMessage(incoming, messages)) {
    // Then the newest message is not the incoming one that triggered this edge function.
    log.info(
      `Newer message for conversation ${conv.name} found. Skipping response.`,
    );

    return new Response("ok", { headers: corsHeaders });
  }

  // SESSION RESTART if /new is found — USEFUL FOR WHATSAPP TESTING

  const firstMessageIndex = messages.findLastIndex(
    ({ direction, message }) =>
      direction === "incoming" &&
      message.type === "text" &&
      message.text.startsWith("/new"),
  );

  if (firstMessageIndex > -1) {
    const firstMessage = messages[firstMessageIndex].message as TextPart;

    firstMessage.text = firstMessage.text.replace("/new", "");

    messages.splice(0, firstMessageIndex);

    // Also, reset the conversation memory
    if (conv.extra.memory && Object.keys(conv.extra.memory).length) {
      conv.extra.memory = {};

      const { error } = await client
        .from("conversations")
        .update({ extra: conv.extra })
        .eq("organization_address", conv.organization_address)
        .eq("contact_address", conv.contact_address);

      if (error) {
        throw error;
      }
    }
  }

  log.info("Contact request", messages.at(-1)?.message);

  // WELCOME MESSAGE
  // Note: The welcome message is affected by allowed contacts. This behavior
  // differs from WhatsApp, which sends the welcome message to all contacts.

  if (
    org.extra.welcome_message &&
    messages.every((m) => m.direction !== "outgoing")
  ) {
    const outgoing: MessageInsert = {
      service: conv.service,
      organization_address: conv.organization_address,
      contact_address: conv.contact_address,
      direction: "outgoing",
      type: "outgoing", // TODO: Deprecate
      message: {
        type: "text",
        content: org.extra.welcome_message.replaceAll("**", "*"), // TODO: Deprecate
      },
    };

    log.info("Welcome message", outgoing.message.content);

    const { error: insertError } = await client
      .from("messages")
      .insert(outgoing);

    if (insertError) throw { insertError };

    return new Response("ok", { headers: corsHeaders });
  }

  // CHECK IF THERE ARE ACTIVE AI AGENTS

  const aiAgents = agents.filter(
    (agent) => agent.ai && agent.extra && agent.extra.mode !== "inactive",
  );

  if (!aiAgents.length) {
    log.info(
      `No active AI agents found for conversation ${conv.name}. Skipping response.`,
    );
    return new Response("ok", { headers: corsHeaders });
  }

  // AGENT SELECTION

  let agent: AgentRow | null | undefined;

  /* Not featuring multiple agents per conversation by the time being.

  // 1. Find the agent_id of the last message from an AI agent

  const lastAgentId = messages.findLast((m) => m.agent_id)?.agent_id;

  agent = aiAgents.find((a) => a.id === lastAgentId);

  // 2. Fallback to the contact's group default agent

  const groupAgentMap = org.extra.default_agent_id_by_contact_group;

  if (!agent && groupAgentMap) {
    const defaultAgentId =
      groupAgentMap[conv.contacts?.extra?.group || "undefined"];

    agent = aiAgents.find((a) => a.id === defaultAgentId);
  }
  */

  // 3. Fallback to any agent

  if (!agent) {
    agent = aiAgents[0];
  }

  //---------------------------------------------------------------------------
  // Up to this point all checks passed. We can proceed with the response.
  //---------------------------------------------------------------------------

  // TYPING INDICATOR

  const indicateTyping = async (unread?: boolean) => {
    const { error: typingIndicatorError } = await client
      .from("messages")
      .update({
        status: {
          ...(unread && { read: new Date().toISOString() }),
          typing: new Date().toISOString(),
        },
      })
      .eq("id", incoming.id);

    if (typingIndicatorError) {
      log.warn(
        "Failed to update incoming message typing indicator status.",
        typingIndicatorError,
      );
    }
  };

  indicateTyping(true);

  // The typing indicator will be dismissed once an agent respond,
  // or after 25 seconds. Hence, keep it alive. Some extra delay
  // is added to avoid race conditions with the response.
  const typingInterval = setInterval(indicateTyping, 30000);

  // CONTEXT

  if (!agent.extra) {
    agent.extra = {};
  }

  const context = {
    organization,
    conversation,
    messages,
    contact,
    agent: agent as AgentRowWithExtra,
  };

  // REQUEST LOOP

  /**
   * agent.extra.tools
   *   - function
   *   - mcp
   *   - gemini: google_search, code_execution, url_context
   *   - openai: mcp, web_search_preview, file_search, image_generation, code_interpreter, computer_use_preview
   *   - anthropic: mcp*, bash, code_execution, computer, str_replace_based_edit_tool, web_search
   *
   * context.tools -> tools + expanded mcp tools
   */

  const mcpServers: Map<string, MCPServer> = new Map();

  let iteration = 0;
  const max_iterations = 5;
  let shouldContinue = true;

  // Basic ReAct algorithm: stop if no tool uses are found.
  while (shouldContinue) {
    iteration++;

    let response: ResponseContext = {};

    try {
      if (iteration > max_iterations) {
        throw new Error("Max LLM iterations reached!");
      }

      // CHECK FOR PENDING ANNOTATIONS

      while (org.extra.annotations?.mode === "active") {
        const pendingAnnotations = messages.filter(
          (m) =>
            m.message.type === "file" &&
            m.status.pending && // Note: not using status.annotating to avoid race conditions with the annotator Edge Function.
            !m.status.annotated &&
            +new Date(m.status.pending) > +new Date() - ANNOTATION_TIMEOUT,
        );

        if (!pendingAnnotations.length) {
          break;
        }

        // WAIT FOR THE ANNOTATIONS TO COMPLETE

        log.info(
          `Waiting ${ANNOTATION_POLLING_INTERVAL}ms for pending annotations to complete...`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, ANNOTATION_POLLING_INTERVAL),
        );

        // Note: we could check for newer messages here too, but it would bloat the code.

        // RETRIEVE ANNOTATIONS

        const { data: pending_messages_v0, error: messagesError } = await client
          .from("messages")
          .select()
          .in(
            "id",
            pendingAnnotations.map((m) => m.id),
          );

        if (messagesError) {
          throw messagesError;
        }

        const pending_messages = pending_messages_v0
          .map(toV1)
          .filter(Boolean) as MessageRowV1[];

        // Update the messages with the pending annotations.
        for (const pm of pending_messages) {
          const index = messages.findIndex((m) => m.id === pm.id);

          if (index > -1) {
            messages[index] = pm;
          }
        }
      }

      // CHECK IF THERE IS A NEWER MESSAGE (posterior to the incoming one)

      const { data: new_messages_v0, error: newMessagesError } = await client
        .from("messages")
        .select()
        .eq("organization_address", conv.organization_address)
        .gt("created_at", incoming.created_at) // Time constraint for the conversation.
        .eq("contact_address", conv.contact_address)
        .lte("timestamp", new Date().toISOString()) // Scheduled messages have a future timestamp.
        .neq("agent_id", agent.id) // Messages from the same agent are not considered.
        .limit(1);

      if (newMessagesError) {
        throw newMessagesError;
      }

      if (new_messages_v0.length) {
        log.info(
          `Newer message for conversation ${conv.name} found while waiting for pending annotations. Skipping response.`,
        );

        return new Response("ok", { headers: corsHeaders });
      }

      // MCP SERVERS INITIALIZATION
      // It is here because of multi-agents, which we are not using by the time being.

      const mcpServersToInit =
        agent.extra.tools?.filter(
          (tool) =>
            tool.provider === "local" &&
            tool.type === "mcp" &&
            !mcpServers.has(tool.label),
        ) || [];

      const mcpServersAux = await Promise.all(
        mcpServersToInit.map((tool) => initMCP(tool as LocalMCPToolConfig)),
      );

      mcpServersAux.forEach((mcp) => {
        mcpServers.set(mcp.label, mcp);
      });

      // CURRENT ITERATION TOOLS

      /**
       * Tools to be passed the agent are gruped in two main categories:
       * 1. Local tools
       * 2. External tools
       *
       * Local tools need to be passed to the agent with their input schema.
       * External tools do not require more than their tool config as it comes.
       *
       * We have the following tool types:
       * - `ToolInfo` to tag tool use/result messages with basic tool info (specially `label` and `name`).
       * - `ToolConfig` for agents to declare their tools (`label`, `name` might be unknown for MCP tools and others).
       * - `ToolDefinition`, which as its name suggests, defines the tool (`label` is unknown at definition, only `name`).
       * - `AgentTool`, the combination of config and definition, to be passed to the agent.
       */
      const tools: AgentTool[] = [];

      for (const toolConfig of agent.extra.tools || []) {
        if (toolConfig.provider !== "local") {
          continue;
        }

        // TODO: allowed tools

        switch (toolConfig.type) {
          case "function": {
            const unlabeledTool = Toolbox.function.find(
              (t) => t.name === toolConfig.name,
            );

            if (!unlabeledTool) {
              throw new Error(`Tool ${toolConfig.name} not found.`);
            }

            tools.push(unlabeledTool);

            break;
          }
          case "mcp": {
            const unlabeledTools = mcpServers.get(toolConfig.label)!.tools;

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                provider: toolConfig.provider,
                type: toolConfig.type,
                label: toolConfig.label,
                name: unlabeledTool.name,
                description: unlabeledTool.description,
                inputSchema:
                  unlabeledTool.inputSchema as z.core.JSONSchema.JSONSchema,
                outputSchema: unlabeledTool.outputSchema as
                  | z.core.JSONSchema.JSONSchema
                  | undefined,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
          case "http":
          case "sql": {
            const unlabeledTools = Toolbox[toolConfig.type];

            for (const unlabeledTool of unlabeledTools) {
              const labeledTool = {
                ...unlabeledTool,
                label: toolConfig.label,
                config: toolConfig.config,
              };

              tools.push(labeledTool);
            }

            break;
          }
        }
      }

      // AGENT CLIENT REQUEST AND RESPONSE

      const handler = ProtocolFactory.getHandler(tools, context, client);

      const agentRequest = await handler.prepareRequest();

      const agentResponse = await handler.sendRequest(agentRequest);

      response = await handler.processResponse(agentResponse);

      if (!response.messages?.length) {
        response.messages = [];
      }

      // TOOL USES AND RESULTS

      const toolUses =
        response.messages.filter(
          (m) =>
            m.direction === "internal" &&
            m.message.type === "text" &&
            m.message.tool &&
            m.message.tool.provider === "local",
        ) || [];

      for (const row of toolUses) {
        // Only needed to please the TypeScript compiler
        if (
          row.direction !== "internal" ||
          row.message.type !== "text" ||
          !row.message.tool ||
          row.message.tool.provider !== "local"
        ) {
          continue;
        }

        /**
         * # Tool uses and results within parallel tool use
         *
         * Chat Completions API produces a single message with several tool choices.
         * It expects tool results as single messages.
         *
         * On the other hand, Responses API and Messages API also produce a single with several tool uses.
         * But on the contrary, they expect tool results as a single message.
         *
         * Here, the adopted policy is to adhere to the WhatsApp API, this is one message per part.
         * A tool use/result is considered a part.
         */

        let parts: (Part & ToolInfo)[] = [];

        const toolInfo = row.message.tool;

        const agentTool = tools.find(
          (t) =>
            t.provider === toolInfo.provider &&
            t.type === toolInfo.type &&
            ("label" in toolInfo ? t.label === toolInfo.label : true) &&
            t.name === toolInfo.name,
        );

        try {
          if (!agentTool) {
            throw new Error(
              `Tool ${toolInfo.name} not found between available tools.`,
            );
          }

          let input: string | Json = row.message.text;

          const ajv = new Ajv2020();
          const schema = agentTool.inputSchema;

          input = JSON.parse(input);

          // When JSON parsing is done, the message is converted to a data part.
          row.message = {
            version: "1",
            task: row.message.task,
            tool: toolInfo,
            type: "data",
            kind: "data",
            data: input,
          };

          const valid = ajv.validate(schema, input);

          if (!valid) {
            throw new Error(`Tool input validation failed: ${ajv.errors}`);
          }

          switch (toolInfo.type) {
            case "custom":
            case "function": {
              const result = await agentTool.implementation(input);

              parts = [
                {
                  tool: {
                    ...toolInfo,
                    event: "result" as const,
                  },
                  type: "data",
                  kind: "data",
                  data: result,
                },
              ];

              if (toolInfo.name === TransferToHumanAgentTool.name) {
                shouldContinue = false;
              }

              break;
            }
            case "mcp": {
              const mcp = mcpServers.get(agentTool.label!);

              if (!mcp) {
                throw new Error(`MCP server ${agentTool.label} not found.`);
              }

              parts = await callTool(mcp, row.message, context, client);

              break;
            }
            case "http":
            case "sql": {
              const result = await agentTool.implementation(
                input,
                agentTool.config,
                context,
                client,
              );

              parts = [
                {
                  tool: {
                    ...toolInfo,
                    event: "result" as const,
                  },
                  type: "data",
                  kind: "data",
                  data: result,
                },
              ];

              if (result.file) {
                parts.push({
                  tool: {
                    ...toolInfo,
                    event: "result" as const,
                  },
                  type: "file",
                  kind: "document",
                  file: result.file,
                });
              }

              break;
            }
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";

          log.warn("Tool error", { tool: toolInfo, error: errorMessage });

          parts = [
            {
              tool: {
                ...toolInfo,
                is_error: true,
                event: "result" as const,
              },
              type: "text",
              kind: "text",
              text: errorMessage,
            },
          ];
        }

        // TODO: Mutating the response object is not the most recommended way to do this
        // but it will be improved soon.
        const taskId = row.message.task?.id || crypto.randomUUID();

        response.messages.push(
          // @ts-expect-error TODO: file messages are outgoing
          ...parts.map((part) => ({
            service: conv.service,
            organization_address: conv.organization_address,
            contact_address: conv.contact_address,
            direction: part.type === "file" ? "outgoing" : "internal",
            type: part.type === "file" ? "outgoing" : "function_response",
            agent_id: agent.id,
            message: {
              version: "1" as const,
              task: { id: taskId },
              ...part,
            },
          })),
        );
      }

      if (!toolUses.length) {
        shouldContinue = false;
      }
    } catch (error) {
      shouldContinue = false;

      log.error("Error in agent client", error as Error);

      response.messages = [
        // @ts-expect-error
        {
          service: conv.service,
          organization_address: conv.organization_address,
          contact_address: conv.contact_address,
          direction: org.extra.error_messages_direction || "internal",
          type: org.extra.error_messages_direction || "internal",
          agent_id: agent.id,
          message: {
            version: "1" as const,
            type: "text",
            kind: "text",
            text: (error as Error).toString(),
          },
        },
      ];
    }

    // STORE CURRENT ITERATION MESSAGES

    if (response.messages?.length) {
      log.info("Agent response", response.messages.at(-1)?.message);

      const output_messages = response.messages.map((message, index) => ({
        ...message,
        // Make sure the messages have the correct organization_address and contact_address
        organization_address: conv.organization_address,
        contact_address: conv.contact_address,
        // Disambiguate by milliseconds to ensure the insertion order.
        timestamp: new Date(+new Date() + index).toISOString(),
      }));

      const output_messages_v0 = output_messages
        .map(fromV1)
        .filter(Boolean) as MessageRow[];

      // Insert and select the inserted messages
      const { data: messages_v0, error: messagesError } = await client
        .from("messages")
        .insert(output_messages_v0)
        .select()
        .order("timestamp");

      if (messagesError) {
        throw messagesError;
      }

      // Append generated messages to the context
      messages.push(
        ...(messages_v0.map(toV1).filter(Boolean) as MessageRowV1[]),
      );
    }
  }

  // TODO: take care of the typing interval corner cases
  clearInterval(typingInterval);

  // STORE RESPONSE

  /*
  if (response?.conversation) {
    const { error } = await client
      .from("conversations")
      .update({
        extra: response.conversation.extra,
      })
      .eq("organization_address", conv.organization_address)
      .eq("contact_address", conv.contact_address);

    if (error) {
      log.error("Failed to update conversation extra field.", error);
    }
  }

  if (contact && response?.contact) {
    const { error } = await client
      .from("contacts")
      .update({
        extra: response.contact.extra,
      })
      .eq("id", contact.id);

    if (error) {
      log.error("Failed to update contact extra field.", error);
    }
  }
  */

  return new Response(JSON.stringify(messages), {
    headers: { "Content-Type": "application/json" },
  });
});

/**
 * TODO
 * - Store integration API keys (openai, anthropic, google, etc.) in api_keys table
 * - An awesome README
 * - Revisit RLS
 * - Improved error handling
 *   https://modelcontextprotocol.io/specification/2025-03-26/server/tools#error-handling
 * - Timestamp precision (JS milliseconds vs PostgreSQL microseconds)
 */
