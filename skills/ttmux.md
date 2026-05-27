---
name: ttmux
description: >
  Use ttmux to decompose complex tasks into parallel subtasks running in tmux sessions.
  Invoke when work can be split into independent parallel streams, when running
  long commands in background, or when monitoring multiple processes.
user-invocable: true
allowed-tools:
  - Bash(ttmux *)
  - Bash(cat ~/.local/share/ttmux/logs/*)
  - Read
---

# /ttmux — Parallel Task Orchestration

You have `ttmux` (at `~/.local/bin/ttmux`), an AI-native tmux wrapper for
parallel task execution with output capture.

Arguments: `$ARGUMENTS`

## When to use

- A task has 2+ independent subtasks that can run in parallel
- A command is long-running and should run in the background
- You need to monitor or collect output from multiple processes
- You're running CI-like workflows: lint + test + build simultaneously

## Workflow

### Step 1: Decompose

Break the task into independent subtasks. Each becomes a named tmux session.

### Step 2: Spawn

```bash
ttmux spawn <group> \
  "<task1>" "<command1>" \
  "<task2>" "<command2>" \
  "<task3>" "<command3>"
```

Naming rules: short, lowercase, hyphenated (e.g. `lint-check`, `run-tests`).
Max 8 parallel sessions.

### Step 3: Monitor

```bash
ttmux status <group>          # human-readable
ttmux status <group> --json   # machine-readable
```

### Step 4: Wait & Collect

```bash
ttmux wait <group> --timeout 120
ttmux collect <group> --json
```

Read the collected output to synthesize results for the user.

### Step 5: Clean up

```bash
ttmux group kill <group>
```

Always clean up after collecting.

## Single background task

```bash
ttmux new <name> -d            # create detached
ttmux send <name> "<command>"  # run command
# ... do other work ...
ttmux capture <name>           # read output
ttmux kill <name>              # clean up
```

## Argument dispatch

When invoked as `/ttmux`:

- No args → run `ttmux status` and report current state
- `run <description>` → decompose the described task, spawn it
- `check <group>` → show status of named group
- `collect <group>` → collect and summarize results
- `clean` → kill all ttmux-managed groups
- `<any other>` → forward to ttmux directly

## Rules

1. Always use descriptive group and task names
2. Always capture output BEFORE killing sessions
3. Check `ttmux ls` before creating to avoid name collisions
4. Max 8 parallel sessions per group
5. Prefer `--json` output when parsing results programmatically
6. For file-producing tasks, write to `/tmp/<group>/` so results persist
7. If a task fails, capture its output for debugging before retrying
8. Clean up groups when done — don't leave orphan sessions
