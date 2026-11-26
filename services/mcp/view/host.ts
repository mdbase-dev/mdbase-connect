import type { App } from "@modelcontextprotocol/ext-apps";
import { isObject, shownResult, type Json, type Shown } from "./model";

/** What the view asks of the MCP host. Every collection request is a tool call the host makes. */
export interface Host {
  /** Calls one of the gateway's tools and says what its result shows. */
  show(tool: string, args: Json): Promise<Shown>;
  /** Calls a tool for data the view reads itself, such as describe_collection. */
  read(tool: string, args: Json): Promise<Json>;
  openLink(url: string): void;
  /** Tells the model what the person changed here, for its next turn. */
  tell(text: string): void;
  /** Asks the host to show the view inline or full screen; the host's context then says which it did. */
  display(mode: "inline" | "fullscreen"): void;
}

export function appHost(app: App): Host {
  const call = (name: string, args: Json) => app.callServerTool({ name, arguments: args });
  return {
    async show(tool, args) {
      try {
        return shownResult(await call(tool, args), args);
      } catch (error) {
        return { kind: "error", code: "host_refused", message: error instanceof Error ? error.message : "", link: undefined };
      }
    },
    async read(tool, args) {
      const result = await call(tool, args);
      if (result.isError || !isObject(result.structuredContent)) {
        const error = isObject(result.structuredContent) && isObject(result.structuredContent.error) ? result.structuredContent.error : {};
        throw new Error(typeof error.message === "string" ? error.message : `${tool} failed.`);
      }
      return result.structuredContent;
    },
    openLink(url) {
      void app.openLink({ url });
    },
    display(mode) {
      void app.requestDisplayMode({ mode });
    },
    tell(text) {
      // A host without model context updates still shows the change; the model reads it next time it looks.
      if (app.getHostCapabilities()?.updateModelContext) void app.updateModelContext({ content: [{ type: "text", text }] });
    },
  };
}
