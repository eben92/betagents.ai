/**
 * Telegram control interface.
 *
 * Inbound messages reach the agent only from explicitly allowed user ids. That
 * check is the authorisation boundary for the whole system: the control tools
 * can stop trading and trigger cycles, so an unlisted user must never get a
 * turn at all.
 *
 * Outbound reports do not go through this channel — they are sent directly by
 * `lib/telegram/notify`, so a report can be raised from anywhere in a cycle
 * without an agent session.
 */

import { telegramChannel, type TelegramMessage } from "eve/channels/telegram";

import { getConfig } from "../lib/config";
import { createLogger } from "../lib/logger";

const log = createLogger("channel:telegram");

/** Why a message was turned away. `null` means it is allowed through. */
export type TelegramRejection = "no-allow-list" | "unauthorised-user" | "unexpected-chat";

/**
 * The authorisation decision for one inbound message, separated from the
 * channel so it can be tested directly. This is the gate that decides who can
 * move money; it should not be reachable only through a webhook.
 */
export function rejectionFor(
  message: Pick<TelegramMessage, "chat" | "from">,
): TelegramRejection | null {
  const telegram = getConfig().telegram;

  // An empty list denies everyone: failing closed is the only safe default for
  // a channel that can move money.
  if (!telegram?.allowedUserIds.length) return "no-allow-list";

  const userId = message.from?.id;
  if (!userId || !telegram.allowedUserIds.includes(userId)) return "unauthorised-user";

  // A shared chat must be the configured one, so an allowed user cannot be
  // talked into driving the system from a group full of strangers.
  //
  // A private chat with an allowed user is always accepted, and has to be:
  // reports go wherever `TELEGRAM_CHAT_ID` points, and that is often a channel,
  // which eve parses but deliberately never dispatches to the agent. Requiring
  // commands to originate from the report destination would leave such a setup
  // with no control interface at all.
  if (message.chat.type !== "private" && telegram.chatId && message.chat.id !== telegram.chatId) {
    return "unexpected-chat";
  }

  return null;
}

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME?.trim() || undefined,

  onMessage(_ctx, message) {
    const rejection = rejectionFor(message);
    if (rejection) {
      log.warn("rejecting an inbound Telegram message", {
        reason: rejection,
        userId: message.from?.id,
        chatId: message.chat.id,
      });
      return null;
    }

    return {
      auth: {
        authenticator: "telegram",
        principalType: "user",
        principalId: message.from?.id ?? "",
        attributes: { chatId: message.chat.id, operator: "true" },
      },
    };
  },
});
