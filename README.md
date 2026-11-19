# Threads

A local dashboard of your Claude Code sessions: a live tree of every session with its state, helpers and tools, plus
your token use, installed tools and helper settings. It is built only from the files Claude Code already keeps on your machine.

## Privacy

- The server listens on `127.0.0.1` only and reads local files. It sends nothing anywhere.
- The page shows numbers and names only: tool, skill, helper, MCP server, hook and plugin names, model and effort
  words, project labels (the last folder name), and the short label a session sets for itself with `--task`.
- It never shows a prompt, a reply, a command, a file path or a tool result.

## Requirements

Node 20 or newer, and Claude Code used on this machine. No install step, no packages.

## Setup

The same on Windows (PowerShell), macOS and Linux:

```sh
git clone https://github.com/BuzzBFX/threads.git
cd threads
node server.mjs --open
```

Using a coding assistant (Claude Code, Codex, Cursor...)? Open the folder and ask it to set Threads up: it reads
`AGENTS.md`.

## Run

`node server.mjs` (or `npm start`) prints the address, `http://127.0.0.1:4848/` or the next free port up to 4858.

| Flag | What it does |
|---|---|
| `--port <n>` | Listen on this port only |
| `--open` | Open the page in your browser |
| `--claude <dir>` | Claude Code's folder (default: `CLAUDE_CONFIG_DIR`, else `~/.claude`) |
| `--data <dir>` | Where Got it, Park and the status files are kept (default: `./data`) |
| `--catalog <file>` | Your own tools list (default: `./tools-catalog.json`) |
| `--config <file>` | Local settings (default: `./config.json`): `projectNames`, `claudeDirs` |
| `--read-only` | Write nothing |
| `--help`, `--version` | |

## The five states

| Sign | Word | Colour | When |
|---|---|---|---|
| `●` | running | cyan | it wrote in the last 10 minutes, a background job it started is still out, or its hook says so |
| `!` | awaiting you | red | its hook saw a permission prompt or a question for you |
| `⧗` | waiting | grey-blue | the session said so itself (`hooks/status.mjs --state waiting`) |
| `…` | idle | yellow | it stopped and you have not looked yet (a job: it stopped before every helper finished) |
| `✓` | done | green | a job whose helpers have all finished: press it to check what it did, then Got it |

Got it takes a card off the tree and counts it in "done this week" (from Monday 00:00). A session has no finished
mark, so it is idle when it stops; without hooks it is running while it writes (or waits on a background job). With
hooks its own state wins.

## The tabs

- **Brain**: you, your projects, the sessions that lead them, and each session's **jobs** side by side as its
  branches. A job is the helpers whose description is `<Job>: <step>` (a helper with no colon is its own job); they
  sit inside its card as rows. Its state is the worst of theirs, with its tool tag and background work still out
  (`Blender · render_steps.py`, file names only). Press a job for **what it did**: its outcome line, calls by tool
  name, files written, failed calls, the scripts it ran, its helpers, Got it and Park. A **Tree | Timeline** switch shows them as a tree,
  or as today on one clock: a lane per session under its project, its jobs under it, a bar for each busy stretch and
  a line at now. The picked card stays picked across the switch; the page remembers your choice. Click a project's
  name to give it your own name.
- **Details**: tokens (or list dollars) per day by model, per project, and per session with its largest context.
- **Tools**: skills, helpers, MCP servers, hooks, plugins and commands, with how often each was used in 30 days.
- **Team**: each helper file's model and effort, changed with one press.

## Optional

- **Status hooks**: three hooks make "awaiting you" work and keep the state exact. See `hooks/README.md`.
  A session can also name itself: `node hooks/status.mjs --task "fix the login page"` (48 characters at most).
- **Outcome lines**: the lead says what a job came to, in its own words (80 characters at most):
  `node hooks/status.mjs --job "Gallery" --outcome "6 pages built, links checked"`.
- **Needs you**: the lead turns a job's card red with its reason, until you press "Done, I've handled it":
  `node hooks/status.mjs --job "Gallery" --needs "Pick one of 3 colourways"` (`--needs-clear` takes it away).
- **Outputs**: the lead registers a file or local page for a job and its card gets an "Open output" button:
  `node hooks/status.mjs --job "Gallery" --output "/abs/path/index.html" --output-label "6 pages"` (the path stays on the server).
- **Project names, job groups and more folders**: `config.json` (git-ignored), e.g.
  `{"projectNames": {"my-repo": "Website"}, "claudeDirs": ["/path/to/another/.claude"]}`. `"jobGroups":
  {"<a helper's exact description>": "<Job>"}` puts a helper that was not named `<Job>: <step>` under a job. Without `--claude`, both
  `~/.claude` and `CLAUDE_CONFIG_DIR` are read.
- **Your own tools**: copy `tools-catalog.example.json` to `tools-catalog.json` and list your scripts; a `match`
  string counts the calls that name it.

## Limits

- Reads Claude Code only; another agent can be added as a source module (`lib/sources/`).
- Without hooks there is no "awaiting you".
- "What it did" is names and counts, never text from a transcript; what a job came to is the lead's outcome line.
- A helper belongs to a job by its description only; one with no description is a job named after its role.
- "Waiting" shows only when a session sets it.
- Dollars are a list-price estimate (`lib/prices.json`), not your bill.
- A session leaves the tree after 2 hours of silence (12 hours with hooks).

## Tests

`npm test`. Pictures of the four tabs on made-up data, the Brain as Tree and Timeline, wide and at phone width: `npm run shot`
(needs Chrome or Edge; the phone pictures need Node 22 or newer).

## Licence

MIT
