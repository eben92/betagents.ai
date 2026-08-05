import { disableTool } from "eve/tools";

/**
 * Removes the built-in `bash` from a notebook agent.
 *
 * This sandbox is a place to keep notes, not a machine. Everything the agent
 * legitimately does to it — create a file, add to one, read it back, search it —
 * is covered by `append_note`, `write_file`, `read_file`, `glob` and `grep`.
 *
 * What `bash` added was the ability to go looking. Told repeatedly that there
 * are no fixtures on disk and no configuration to discover, agents still ran
 * `grep -ril "<team name>" /` to check — and a recursive search from the root of
 * the just-bash filesystem does not come back. One cycle sat on those commands
 * for thirty-six minutes with nothing to show and no error: no bets, no report,
 * no wake-up, nothing to notice.
 *
 * An instruction cannot make that impossible; removing the tool can. The
 * Account & Execution agent keeps its `bash`, because its sandbox really is a
 * machine and it really does need to run binaries in it.
 */
export default disableTool();
