import { disableTool } from "eve/tools";

/**
 * Removes the built-in `ask_question`.
 *
 * Every turn this system takes is unattended. A scheduled cycle fires from cron
 * at midnight; a subagent is answering its parent, not a person. A question here
 * parks the run until somebody answers it, and nobody will: no bets settled, no
 * wake-up booked, no report sent, and no error to notice either.
 *
 * eve already withholds the tool from sessions that cannot request input, so
 * this mostly matters for the paths that *can* — an operator's Telegram message
 * that turns into a cycle. Removing it outright means the agent decides, or
 * reports what it could not decide, in every case rather than most of them.
 */
export default disableTool();
