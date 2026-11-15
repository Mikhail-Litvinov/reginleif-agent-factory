// A detached child of jobbed-parent that fails at once; its exit code and stderr must reach the caller.
const FAILING_EXIT_CODE = 7;

process.stderr.write("child-failed-marker");
process.exit(FAILING_EXIT_CODE);
