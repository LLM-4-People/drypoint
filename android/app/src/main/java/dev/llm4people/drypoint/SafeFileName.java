package dev.llm4people.drypoint;

/**
 * One owner for "a filename the native bridge may write": one plain path
 * segment.
 *
 * The web app supplies the name, so separators, the empty name and the "."/".."
 * segments are rejected here, before the filesystem ever sees them. Keeping the
 * rule in its own class lets the build verify it by compiling and running the
 * real Java instead of grepping for a string.
 */
final class SafeFileName {
  private SafeFileName() {}

  static boolean isSafe(String name) {
    if (name == null || name.isEmpty()) return false;
    if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0) return false;
    // Separators are already rejected, so the whole name is the only segment.
    return !".".equals(name) && !"..".equals(name);
  }
}
