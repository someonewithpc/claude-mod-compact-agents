self: { lib, pkgs }:
{
  enable = lib.mkEnableOption "compact-agents, the Claude Code mod that compacts running subagents";

  package = lib.mkOption {
    type = lib.types.package;
    default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    defaultText = lib.literalExpression "claude-mod-compact-agents.packages.\${system}.default";
    description = "The mod's folder, loaded through CLAUDE_CODE_PLUGIN_DIRS.";
  };
}
