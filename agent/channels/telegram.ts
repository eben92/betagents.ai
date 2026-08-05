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

import { telegramChannel } from "eve/channels/telegram";

import { getConfig } from "../lib/config";
import { createLogger } from "../lib/logger";

const log = createLogger("channel:telegram");

/**
 * Allowed user ids. An empty list denies everyone: failing closed is the only
 * safe default for a channel that can move money.
 */
function allowedUserIds(): Set<string> {
  return new Set(getConfig().telegram?.allowedUserIds ?? []);
}

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME?.trim() || undefined,

  onMessage(_ctx, message) {
    const userId = message.from?.id;
    const allowed = allowedUserIds();

    if (allowed.size === 0) {
      log.warn("rejecting a Telegram message: TELEGRAM_ALLOWED_USER_IDS is empty", { userId });
      return null;
    }

    if (!userId || !allowed.has(userId)) {
      log.warn("rejecting a Telegram message from an unauthorised user", { userId });
      return null;
    }

    // Only the configured chat may drive the system, even for an allowed user.
    const chatId = getConfig().telegram?.chatId;
    if (chatId && message.chat.id !== chatId) {
      log.warn("rejecting a Telegram message from an unexpected chat", {
        chatId: message.chat.id,
      });
      return null;
    }

    return {
      auth: {
        authenticator: "telegram",
        principalType: "user",
        principalId: userId,
        attributes: { chatId: message.chat.id, operator: "true" },
      },
    };
  },
});
