export type ShellCommandRisk = "read_only" | "trusted_dev" | "destructive" | "unknown";

/**
 * Classifies commands for the accept_edits mode. This is intentionally a
 * convenience policy, not a security boundary: trusted interpreters and build
 * tools can still perform arbitrary filesystem changes.
 */
export function classifyShellCommand(command: string): ShellCommandRisk {
  // cmd's `2>&1`/`1>&2` only merges output streams; it does not write a file.
  const normalized = command.trim().toLowerCase().replace(/\s*[12]>&[12]\b/g, "");
  if (!normalized) return "unknown";

  // Inspect command chains segment-by-segment. Pipes, file redirection and
  // shell substitution remain unknown because they change the meaning of the
  // individual commands in ways this lightweight classifier cannot validate.
  if (/[|<>;]/.test(normalized) || /\$\(|`/.test(normalized)) return "unknown";
  const segments = normalized.split(/\s*(?:&&|&)\s*/);
  if (segments.length > 1) {
    const risks = segments.map(classifySingleShellCommand);
    if (risks.includes("destructive")) return "destructive";
    if (risks.includes("unknown")) return "unknown";
    return risks.includes("trusted_dev") ? "trusted_dev" : "read_only";
  }
  return classifySingleShellCommand(normalized);
}

function classifySingleShellCommand(normalized: string): ShellCommandRisk {

  if (/(^|\s)(remove-item|del|erase|rd|rmdir|set-content|add-content|out-file|clear-content|move-item)(\s|$)/.test(normalized)) {
    return "destructive";
  }

  const gitMatch = /^(?:git)(?:\.exe)?\s+([^\s]+)/.exec(normalized);
  if (gitMatch) {
    const gitSubcommand = gitMatch[1] ?? "";
    if (gitSubcommand === "branch" && /\b(branch\s+)?(?:-d|-D|-m|-M|-c|-C)\b/.test(normalized)) return "destructive";
    if (gitSubcommand === "tag" && !/^git(?:\.exe)?\s+tag\s*$/.test(normalized)) return "destructive";
    if (gitSubcommand === "--version" || ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "remote"].includes(gitSubcommand)) {
      // `git remote set-url` and similar forms mutate repository configuration.
      if (/^git(?:\.exe)?\s+remote\s+(set-url|add|remove|rename)\b/.test(normalized)) return "destructive";
      return "read_only";
    }
    if (["add", "commit", "reset", "clean", "checkout", "restore", "rm", "mv", "push", "pull", "fetch", "merge", "rebase", "revert", "cherry-pick", "config", "stash", "tag"].includes(gitSubcommand)) {
      return "destructive";
    }
    return "unknown";
  }

  const executable = firstToken(normalized);
  if (["cd", "chdir", "pwd", "dir", "ls", "type", "cat", "where", "whoami", "echo"].includes(executable)) {
    return "read_only";
  }
  if ((executable === "node" || executable === "nodejs") && /^(?:node|nodejs)\s+(?:--version|-v)\s*$/.test(normalized)) {
    return "read_only";
  }

  // These are deliberately broad, matching the requested personal-workspace
  // workflow. They must not be described as sandboxing.
  if (["python", "python3", "py", "node", "nodejs"].includes(executable)) return "trusted_dev";
  if (["build", "test", "lint", "check", "typecheck"].includes(executable) ||
      (["npm", "pnpm", "yarn", "bun"].includes(executable) && /\b(build|test|lint|check|typecheck|dev)\b/.test(normalized))) {
    return "trusted_dev";
  }
  if (["cargo", "dotnet", "mvn", "gradle", "make", "cmake", "msbuild", "tsc", "vite", "vitest", "jest"].includes(executable) &&
      /\b(build|test|check|lint|typecheck|compile|run)\b/.test(normalized)) {
    return "trusted_dev";
  }

  return "unknown";
}

function firstToken(command: string): string {
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replace(/\.exe$/, "");
}
