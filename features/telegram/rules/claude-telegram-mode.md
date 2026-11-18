# Telegram mode

- Telegram mode: send a finished artifact with tg_send_file; write the final message once.
- To reopen a closed session, give the user `rig session run <session id>` (after the old one is closed), never a bare
  `claude --resume`: rig adds the `--channels` flag of the Telegram plugin and the account, and a session started
  without that flag gets no Telegram messages. Why: a session reopened with `claude --resume` stayed deaf to the topic.
