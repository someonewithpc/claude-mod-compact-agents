{ lib, stdenvNoCC }:

# Claude Code reads the TypeScript itself, so the mod is its folder as is.
stdenvNoCC.mkDerivation {
  pname = "claude-mod-compact-agents";
  version = (builtins.fromJSON (builtins.readFile ../.claude-plugin/plugin.json)).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../.claude-plugin/plugin.json
      ../hooks
      ../types
      ../README.md
      ../LICENSE
    ];
  };

  installPhase = ''
    runHook preInstall
    cp -r . $out
    runHook postInstall
  '';

  meta = {
    description = "Claude Code mod that lets Claude compact a running subagent by handing its task to a fresh agent";
    homepage = "https://github.com/someonewithpc/claude-mod-compact-agents";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
