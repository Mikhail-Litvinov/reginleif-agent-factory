// Finds the file a launch will start: the first PATH directory that holds it. The caller launches the returned full
// path, so the file that was checked is the file that runs. Empty PATH entries are skipped: they would mean the
// current directory, and a session's directory is chosen by the client.
export const findOnPath = async (
  pathValue: string,
  separator: string,
  fileIn: (directory: string) => string,
  exists: (path: string) => Promise<boolean>,
  // Appended to the name in each directory, in order (Windows: the executable extensions); directory order wins.
  suffixes: readonly string[] = [""],
): Promise<string | null> => {
  for (const directory of pathValue.split(separator)) {
    if (directory.length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = `${fileIn(directory)}${suffix}`;
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
};
