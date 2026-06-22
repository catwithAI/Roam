package app

import (
	"fmt"
	"os"
	"strings"

	"ttmux-cli-go/internal/domain/envcmd"
	"ttmux-cli-go/internal/domain/groupcmd"
	"ttmux-cli-go/internal/domain/sessioncmd"
	"ttmux-cli-go/internal/domain/swarmcmd"
	"ttmux-cli-go/internal/runtime"
)

const version = "0.4.1-go"

type App struct {
	rt runtime.Runtime
}

func New() App {
	return App{rt: runtime.New()}
}

func (a App) Run(args []string) error {
	if len(args) == 0 {
		return a.rt.Shell(args...)
	}
	cmd := args[0]
	rest := args[1:]
	switch cmd {
	case "-h", "--help", "help", "-i", "--interactive", "new", "a", "attach", "d", "detach", "kill", "killall", "rename",
		"spawn", "wait", "nw", "lw", "kw", "sp", "split", "kp", "send", "source", "completion", "agent":
		return a.rt.Shell(args...)
	case "-v", "--version":
		fmt.Fprintf(os.Stdout, "ttmux v%s\n", version)
		return nil
	case "ls":
		if has(rest, "--json") {
			return sessioncmd.ListJSON(a.rt, os.Stdout)
		}
		return a.rt.Shell(args...)
	case "group":
		return a.runGroup(rest)
	case "status":
		if len(rest) >= 2 && rest[1] == "--json" {
			return groupcmd.StatusJSON(a.rt, rest[0], os.Stdout)
		}
		return a.rt.Shell(args...)
	case "capture":
		return sessioncmd.Capture(a.rt, rest, os.Stdout)
	case "collect":
		if len(rest) >= 2 && rest[1] == "--json" {
			return groupcmd.CollectJSON(a.rt, rest[0], os.Stdout)
		}
		return a.rt.Shell(args...)
	case "env":
		return envcmd.Run(a.rt, rest, os.Stdout)
	case "info":
		if has(rest, "--json") {
			return sessioncmd.InfoJSON(a.rt, version, os.Stdout)
		}
		return a.rt.Shell(args...)
	case "swarm":
		return swarmcmd.Run(a.rt, rest, os.Stdout)
	default:
		return a.rt.Tmux(append([]string{cmd}, rest...)...)
	}
}

func (a App) runGroup(args []string) error {
	subcmd := "ls"
	if len(args) > 0 {
		subcmd = args[0]
		args = args[1:]
	}
	switch subcmd {
	case "ls", "list":
		if has(args, "--json") {
			return groupcmd.ListJSON(a.rt, os.Stdout)
		}
		return a.rt.Shell(append([]string{"group", subcmd}, args...)...)
	case "status":
		if len(args) >= 2 && args[1] == "--json" {
			return groupcmd.StatusJSON(a.rt, args[0], os.Stdout)
		}
		return a.rt.Shell(append([]string{"group", subcmd}, args...)...)
	case "kill":
		return a.rt.Shell(append([]string{"group", subcmd}, args...)...)
	default:
		return fmt.Errorf("unknown subcommand: group %s", subcmd)
	}
}

func has(args []string, want string) bool {
	for _, arg := range args {
		if strings.EqualFold(arg, want) {
			return true
		}
	}
	return false
}
