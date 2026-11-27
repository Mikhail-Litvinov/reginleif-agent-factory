export type TelegramMessage = { chat: string; key: string; text: string; buttons: { id: string; draftId: string; text: string }[] };
export type TelegramTransport = { send(message: TelegramMessage): Promise<string> };

/** The transport must persist its idempotency keys across restarts. */
export function createTelegramClient(transport: TelegramTransport) {
  const sends = new Map<string, { payload: string; pending: Promise<string> }>();
  return {
    sendDrafts(chat: string, key: string, drafts: { id: string; pressId: string; text: string }[]): Promise<string> {
      const scope = JSON.stringify([chat, key]);
      const payload = JSON.stringify(drafts);
      const existing = sends.get(scope);
      if (existing) return existing.payload === payload ? existing.pending : Promise.reject(new Error('send key already used for a different message'));
      const pending = transport.send({ chat, key, text: drafts.map(draft => draft.text).join('\n'), buttons: drafts.map(draft => ({ id: draft.pressId, draftId: draft.id, text: draft.text })) });
      sends.set(scope, { payload, pending });
      pending.catch(() => { if (sends.get(scope)?.pending === pending) sends.delete(scope); });
      return pending;
    },
  };
}
