/**
 * The working sandbox for the agents that never open a browser.
 *
 * Every eve agent gets a sandbox whether or not one is authored, so Research,
 * Planner, Reviewer, Watcher and the orchestrator already had `/workspace` and
 * the `bash`, `read_file`, `write_file`, `glob` and `grep` tools. What they did
 * not have was a *predictable* one: the framework default picks Docker, then
 * microsandbox, then just-bash depending on what the host happens to offer, so
 * the same agent would get a container on one machine and a simulated shell on
 * another — and on a host with Docker, five agents would mean five containers.
 *
 * These agents need somewhere to think, not somewhere to run binaries. They
 * write notes, re-read them, and check their own work before handing back.
 * `justbash` gives exactly that: a real persistent `/workspace` with no daemon,
 * no VM and no per-agent container. It is the same on every host, and it costs
 * a small VPS nothing.
 *
 * The Account & Execution agent is the exception and authors its own
 * microsandbox, because driving a real browser needs real binaries.
 */

import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

export default defineSandbox({
  backend: justbash(),
});
