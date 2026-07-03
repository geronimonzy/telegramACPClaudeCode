import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Builds the `fs/*` half of the ACP `Client` implementation: real
 * filesystem access on behalf of the agent subprocess.
 */
export function makeFsHandlers(): Pick<
  acp.Client,
  "readTextFile" | "writeTextFile"
> {
  return {
    async readTextFile(
      params: acp.ReadTextFileRequest,
    ): Promise<acp.ReadTextFileResponse> {
      let raw: string;
      try {
        raw = await readFile(params.path, "utf8");
      } catch (err) {
        if (isEnoent(err)) {
          throw acp.RequestError.resourceNotFound(params.path);
        }
        throw err;
      }

      if (params.line == null && params.limit == null) {
        return { content: raw };
      }

      // Split keeping the file's line terminators so slices round-trip
      // byte-for-byte; a trailing empty segment from a final "\n" is dropped.
      const lines = raw.split(/(?<=\n)/);
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }

      const startIdx = params.line != null ? Math.max(0, params.line - 1) : 0;
      const endIdx =
        params.limit != null ? startIdx + params.limit : lines.length;

      return { content: lines.slice(startIdx, endIdx).join("") };
    },

    async writeTextFile(
      params: acp.WriteTextFileRequest,
    ): Promise<acp.WriteTextFileResponse> {
      await mkdir(dirname(params.path), { recursive: true });
      await writeFile(params.path, params.content, "utf8");
      return {};
    },
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
