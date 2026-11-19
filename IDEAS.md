# Ideas for the Brain tab

For a team that tracks many jobs given to Claude. Ranked by what saves the most time or stops the most missed work.
Size: S is under an hour, M is a day, L is more. None of these is built; pick the ones you want.

Built already with the job cards: a "done · to check" count in the strip, and the outcome line next to each job in
"done this week".

| # | Idea | Why | Size |
|---|---|---|---|
| 1 | **A result word with the outcome line**: `--outcome "..." --result pass\|fail\|open`. A done job with `fail` or `open` shows `! done · open` and cannot be cleared with one press. | "Done" only means the helpers stopped. This stops a failed check from being cleared as finished work. | S |
| 2 | **Quiet-job mark**: a running job with no write and no background command for 20 minutes shows `quiet 25m`. | A hung helper looks the same as a busy one today; someone finds out an hour later. | S |
| 3 | **Count in the tab title**: `(3) Threads` = awaiting you + done to check, with an optional browser notification when a job turns done. | Nobody has to keep the page in view to know a job came back. | S |
| 4 | **"No outcome" nudge**: a done job without an outcome line says so on its card, and `hooks/status.mjs --missing` lists them for the lead to fill in. | The outcome line is the only place that says what a job came to; this keeps it from being skipped. | S |
| 5 | **Keyboard triage**: `j`/`k` step through the done jobs, `Enter` opens one, `g` is Got it. | Ten finished jobs are checked in twenty seconds, without the mouse. | S |
| 6 | **File kinds written**: `.py 4 · .md 2` next to the files count (extensions and counts only, never a name or a path). | Tells a code job from a notes job at a glance, inside the privacy rules. | S |
| 7 | **Attempt count**: a step that ran more than once shows `2nd run`. | Repeated runs of one step are the first sign a job is going wrong or costing too much. | S |
| 8 | **"Ran tests" chip**: a script name that matches `test`, `check` or `lint` adds a chip, with the failed-call count beside it. | Answers "did it check its own work?" without opening anything. | S |
| 9 | **Week page**: every job done this week with its outcome line, time and cost; one button copies it as text. | The weekly update writes itself from what the team already cleared. | M |
| 10 | **A budget per job** in `config.json` (tokens or dollars); the card turns amber at 80% and red over it. | Catches a runaway job while it runs, not on the bill. | M |
| 11 | **Group in the page**: drag a helper row onto another job, or rename a job; it writes `jobGroups`. | Fixes a mis-named helper without editing a file. | M |
| 12 | **Planned jobs**: `--job "<Job>" --plan "<step>, <step>"` shows the steps not started yet as grey rows. | The team sees what is coming and what is left, not only what ran. | M |
| 13 | **Check list per job**: the lead posts named checks (`tests 80/80`, `pictures taken`) and the card shows each as passed, failed or not run. | The reviewer reads the checks, not the whole report. | M |
| 14 | **One page for the team**: each machine posts its payload (already names and counts only) to a shared Threads. | One place shows who is running what, and what waits for whom. | L |
| 15 | **Hand-over**: assign a done job to a person; it sits under their name until they clear it. | A finished job is not lost when the one who started it is away. | L |
