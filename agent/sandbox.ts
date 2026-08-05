/**
 * The orchestrator's workspace. It keeps cycle notes here — what it has already
 * done this cycle, what it is waiting on — so a long cycle can be resumed
 * rather than restarted. See `lib/notebook-sandbox.ts`.
 */
export { default } from "./lib/notebook-sandbox";
