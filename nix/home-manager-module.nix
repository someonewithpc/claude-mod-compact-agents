self: { config, lib, pkgs, ... }:
let
  cfg = config.programs.claude-mod-compact-agents;
in
{
  options.programs.claude-mod-compact-agents = import ./options.nix self { inherit lib pkgs; };

  # Everything goes through the env block of ~/.claude/settings.json, which
  # every Claude Code session reads however it was started. Claude Code
  # rewrites that file, so it can't be a store symlink: the keys are merged in
  # at activation. Other folders in CLAUDE_CODE_PLUGIN_DIRS are kept; an older
  # compact-agents one is replaced.
  config = lib.mkIf cfg.enable {
    home.activation.claudeModCompactAgents = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      settings="$HOME/.claude/settings.json"
      mkdir -p "$HOME/.claude"
      [ -e "$settings" ] || echo '{}' > "$settings"

      merge='.env = ((.env // {}) + {
        CLAUDE_CODE_PLUGIN_DIRS:
          ([((.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":")[]
             | select(. != "" and (test("-claude-mod-compact-agents-") | not)))] + [$dir] | join(":"))
      })'

      merged=$(${pkgs.jq}/bin/jq --arg dir "${cfg.package}" "$merge" "$settings")
      if [ "$merged" != "$(${pkgs.jq}/bin/jq . "$settings")" ]; then
        $DRY_RUN_CMD install -m 644 /dev/null "$settings.hm-merge"
        printf '%s\n' "$merged" > "$settings.hm-merge"
        $DRY_RUN_CMD mv "$settings.hm-merge" "$settings"
      fi
    '';
  };
}
