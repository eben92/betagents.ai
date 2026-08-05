import { defineTool } from "eve/tools";
import { z } from "zod";

import { errorMessage } from "../../../lib/logger";

/**
 * Adds a line to a notebook file, creating it if needed.
 *
 * `write_file` refuses to overwrite a file this session has not opened with
 * `read_file`, which is right — it stops a rewrite from silently discarding
 * work. But almost every note here is cumulative, so the model reaches for
 * `write_file` on a file that already exists and the call fails. Telling it to
 * append with `bash` works most of the time; "most of the time" is not a
 * property worth relying on when the alternative is one small tool.
 *
 * Appending is also the correct shape: a note rebuilt from memory would drop
 * what was written before it.
 */
export default defineTool({
  description:
    "Add lines to one of your notebook files, creating it if it does not exist. Use this for anything cumulative — your journal, a per-draft checklist — instead of write_file, which refuses to overwrite a file you have not read this session.",
  inputSchema: z.object({
    file: z
      .string()
      .describe("File name inside /workspace, e.g. covered.md. A bare name or an absolute path under /workspace."),
    text: z.string().describe("What to add. Written as its own paragraph, with a trailing newline."),
  }),

  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox();
    if (!sandbox) return { error: "No sandbox is available in this session." };

    // Keep every note inside /workspace: the notebook is the whole point, and a
    // path escaping it would be either a mistake or something worse.
    const name = input.file.replace(/^\/workspace\//, "").trim();
    if (!name || name.includes("..") || name.startsWith("/")) {
      return { error: `"${input.file}" is not a file name inside /workspace.` };
    }

    const path = `/workspace/${name}`;
    const heredoc = `EOF_${Math.random().toString(36).slice(2, 10)}`;

    try {
      const result = await sandbox.run({
        command: `mkdir -p /workspace && cat >> ${path} <<'${heredoc}'\n${input.text}\n${heredoc}\n`,
      });
      if (result.exitCode !== 0) {
        return { error: `Could not append to ${path}: ${result.stderr || result.stdout}` };
      }
      return { ok: true, file: path, appended: input.text.length };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  },
});
