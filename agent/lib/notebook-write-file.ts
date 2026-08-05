/**
 * `write_file`, with a better answer when it refuses.
 *
 * The built-in refuses to overwrite a file this session has not opened with
 * `read_file`, which is right — it stops a rewrite from silently discarding
 * work. But almost every note in these workspaces is cumulative, so the model
 * reaches for `write_file` on a file that already exists, gets told to read it
 * first, and follows that advice: read the whole note, then rewrite it whole.
 * That works, costs a turn and a context window, and loses anything written
 * between the read and the write.
 *
 * The tool that is actually wanted is `append_note`, and the built-in error has
 * no way to know it exists. This wrapper does, so the refusal becomes a
 * redirect. It has been the same failure four times across four agents; the
 * instructions say to use `append_note`, and saying it again was not going to
 * be what finally worked.
 */

import { defineTool } from "eve/tools";
import { writeFile } from "eve/tools/defaults";

/** The built-in's refusal, which is what we want to improve on. */
const NEEDS_READ = /must read file .* before overwriting/i;

export default defineTool({
  ...writeFile,
  async execute(input, ctx) {
    try {
      return await writeFile.execute(input, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!NEEDS_READ.test(message)) throw error;

      const path = String((input as { path?: unknown }).path ?? "your note");
      throw new Error(
        `${path} already exists. If you are adding to it — which is almost always the case here — call append_note with the file name and just the new lines; it never overwrites and does not need a read first. Only use write_file after read_file when you genuinely mean to replace the whole file.`,
      );
    }
  },
});
