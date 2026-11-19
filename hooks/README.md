# Status hooks

Three Claude Code hooks keep each session's state exact and make "awaiting you" work. Each one runs
`hooks/status.mjs`, which writes one small file per session under `data/live/`.

| Hook | Runs | Writes |
|---|---|---|
| `UserPromptSubmit` | `status.mjs --hook running` | running |
| `Stop` | `status.mjs --hook idle` | idle (unless the session set awaiting or waiting itself) |
| `Notification` | `status.mjs --hook awaiting` | awaiting you, for a permission prompt or a question only |

Only the session id (and, for a notification, its type) is kept. The prompt is never read.

## Install

1. Print the block with this folder's path filled in:

   ```sh
   node hooks/status.mjs --print-install
   ```

2. Merge its `hooks` entries into your user settings, keeping any hooks you already have:
   - macOS and Linux: `~/.claude/settings.json`
   - Windows: `%USERPROFILE%\.claude\settings.json`

3. Restart your Claude Code sessions.

## Check

Send a prompt in any session: its node turns running within 20 seconds. Let a tool ask for permission: the node turns
red, awaiting you. The line "Status hooks are not installed" leaves the Brain tab once the first file is written.

## By hand

Inside a session (the session id comes from `CLAUDE_SESSION_ID`, else this folder's newest transcript):

```sh
node hooks/status.mjs --state waiting          # waiting on something outside the session
node hooks/status.mjs --state awaiting         # needs you; stays until the next prompt
node hooks/status.mjs --state running
node hooks/status.mjs --task "fix the login"   # a short label for the node (48 characters at most)
node hooks/status.mjs --job "Gallery" --outcome "6 pages built, links checked"
```

The last line is a job's **outcome line**: what the job came to, in the lead session's own words (80 characters at
most, control characters removed). `<Job>` is the job's name on its card: the text before the colon in its helpers'
descriptions (`Gallery: build pages`), or the whole description when there is no colon; capitals do not matter. It
shows on the job's card, in its "what it did" panel and in "done this week". Run it from the lead session, not from
a helper. The newest line for a job wins; `--outcome ""` takes it away. Lines are kept in `data/outcomes.jsonl`.

### Needs you

```sh
node hooks/status.mjs --job "Gallery" --needs "Pick one of 3 colourways for the hero"
node hooks/status.mjs --job "Gallery" --needs-clear
```

The job's card turns **`! NEEDS YOU`** (red) and shows the reason on the card. It outranks every other state of the
job, keeps it on the tree (Got it and Park wait), and makes its lead session and project red too, so the top counter
"awaiting you" counts it. The reason is the lead's own words, written on purpose: control characters removed, 80
characters at most. It clears with `--needs-clear` (or `--needs ""`), or when you press **Done, I've handled it** on
the card. Lines are kept in `data/needs.jsonl`; the newest for a job wins.

### Outputs to look at

```sh
node hooks/status.mjs --job "Gallery" --output "/absolute/path/out/index.html" --output-label "6 pages"
node hooks/status.mjs --job "Gallery" --output "http://127.0.0.1:5173/" --output-label "Preview"
node hooks/status.mjs --job "Gallery" --output-clear
```

The target is an absolute path that exists (a file or a folder) or an `http(s)` URL on `127.0.0.1` or `localhost`.
It is kept in `data/outputs.jsonl` and **never sent to the page**: the page gets only that the job has outputs,
each one's label (the lead's words, 48 characters at most) and a type word from the extension (`html`, `video`,
`image`, `pdf`, `folder`, `url`, else `file`). Each output gets an **Open output** button on the card (green once
the job is done, when the card says `✓ DONE · output ready` and the top bar counts it "to look at"). The button asks
the server to open that registered target on this computer (`open` on macOS, `start` on Windows, `xdg-open`
elsewhere); nothing in the request names a file, a target that is gone is refused, and `--read-only` opens nothing.
Register the same target again to change its label; up to 8 per job, the newest first.

`--session <id>`, `--claude <dir>` and `--data <dir>` pick another session or folder (`THREADS_DATA` works too).

## Remove

Delete the three entries from your settings file. The files in `data/live/` can be deleted; older ones are removed
after 14 days.
