# compact-agents

A Claude Code mod that lets Claude compact one of its running subagents.

A subagent that has read a dozen files and a few long logs carries all of it
into every request it makes after that. Claude Code compacts a subagent only
when the subagent reaches its own token threshold, and nothing from outside can
start one sooner: `/compact` and a mod's `$.session.compact` work on the main
conversation alone, and a mod can read a subagent's messages but not replace
them. This mod adds a `compact_agent` tool that gets the same result by handing
the task to a fresh agent.

## How it works

Claude calls `compact_agent` with a subagent's id or name, and optionally a
`focus` for what the summary should keep. Then:

1. The subagent finishes the tool call it is in. The mod appends a request to
   that tool's result: stop, and write a handoff note for whoever continues.
2. The subagent's next request is its own conversation plus that request at the
   end, so it goes out on the subagent's model and reads its whole prefix from
   the prompt cache. In testing, one such request read 50,583 tokens from the
   cache and 5,421 uncached.
3. The mod holds that answer back and starts a new agent of the same type and
   model family, with the original brief and the note as its prompt.
4. The old agent stops, and the new agent reports back to Claude when it
   finishes, like any background agent.

## What Claude hears

The tool answers right away, and the handoff then happens at the subagent's
pace. Each outcome reaches Claude as a message, the way a subagent's report
does, so an idle session wakes to read it. On success the message names the new
agent and says how much of the note request the prompt cache served. An agent
that finished before it could be handed off gets a message saying so. If the
handoff fails, the agent still runs as it was, and Claude can call
`compact_agent` on it again. If the note was written but the new agent couldn't
be started after two tries, the old agent has stopped with the note as its
report, and Claude can start an agent from it with the Agent tool.

If the subagent calls a tool instead of writing the note, the mod asks once
more. If it still won't, the mod summarizes the transcript on Haiku, with no
cache to read, since that is the cheapest model to read it all cold.

A second call while a handoff is under way says so and changes nothing. A call
that names an agent already handed off points to the one that took over.

The handoff changes the agent's id. SendMessage to the old one reaches a
finished agent, so follow-ups go to the new id.

## Install

Needs Claude Code 2.1.316 or later; tested on 2.1.316 and 2.1.323. At the Claude Code prompt:

```
/plugin install compact-agents --marketplace someonewithpc/claude-mod-compact-agents
```

Answer `y` to add the marketplace, then pick a scope.

To try a checkout for one session: `claude --plugin-dir ./claude-mod-compact-agents`.

With Nix, the flake has a NixOS and a Home Manager module:

```nix
# with claude-mod-compact-agents.nixosModules.default (or .homeManagerModules.default) imported:
programs.claude-mod-compact-agents.enable = true;
```

## Using it

The tool is `mcp__compact-agents__compact_agent`, and Claude Code lists it
behind ToolSearch. Ask for it in plain words ("compact the auditor agent, keep
the list of files it changed"), or put a rule in your CLAUDE.md about when
Claude should hand a subagent off.

## Development

`claude plugin test .` runs the tests, and `claude plugin validate .` checks the
manifest and the hooks module. Claude Code writes the API's types to
`.claude-plugin/types/` when it loads the mod. `nix develop` (or direnv) gives
`tsc`, so `tsc -p .` type-checks against them.

The test kit can't hand back a spawned agent's id, so the tests stop short of a
finished handoff. Live sessions on Haiku covered that part, with a second call
during a handoff, an agent that finished first, a subagent that called a tool
instead of writing its note, and a replacement refused by a PreToolUse hook.

Written with [Claude Code](https://claude.com/claude-code).

## License

MIT
