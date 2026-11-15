// The one sanitizer for every process rig starts for a client: typed exec shells, the rig kind of exec and the
// session launch. `ANTHROPIC_` names carry API keys, `TELEGRAM_HUB_` names the hub's bot token, and `CLAUDE` names
// (`CLAUDECODE`, `CLAUDE_CONFIG_DIR`) would make a started `claude` act as nested in the calling session or run under
// its account. No exception is kept: rig's own code reads no such variable (checked over src/ for process.env,
// Bun.env and the environment port: it reads only CODEX_HOME, DISPLAY, WAYLAND_DISPLAY, PATH, USERPROFILE, HOME).
const OWN_VARS = /^(CLAUDE|TELEGRAM_HUB_|ANTHROPIC_)/i;

export const cleanEnvironment = <V>(env: Record<string, V>): Record<string, V> =>
	Object.fromEntries(Object.entries(env).filter(([name]) => !OWN_VARS.test(name)));
