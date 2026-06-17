# ══════════════════════════════════════════
# ── spawn: 批量创建任务 ──
# ══════════════════════════════════════════

# 交互式 claude/codex 首次进新目录会弹两个对话框(信任此文件夹 / Bypass 权限警告)，
# 否则成员卡住不干活。这里后台轮询画面文字、逐个点掉。$1 会话名 $2 tmux 二进制。
# 由 _spawn_one 用 setsid 脱离调用，使其在 ttmux 命令返回后仍存活。
_spawn_autoconfirm() {
    local sess="$1" tb="$2" t=0 b=0 scr i
    for i in $(seq 1 30); do
        sleep 1
        scr="$("$tb" capture-pane -t "$sess" -p 2>/dev/null)" || continue
        if [[ $t == 0 && "$scr" == *"trust this folder"* ]]; then "$tb" send-keys -t "$sess" Enter; t=1; continue; fi
        if [[ $b == 0 && "$scr" == *"Bypass Permissions mode"* ]]; then "$tb" send-keys -t "$sess" Down Enter; b=1; fi
        [[ $t == 1 && $b == 1 ]] && break
    done
}

# 创建单个任务 session（cmd 与 agent 的统一底层）
# $1 group  $2 name  $3 type(cmd|agent)  $4 payload(命令或任务)  $5 workdir
# 成功返回 0，已存在跳过返回 1
_spawn_one() {
    local group="$1" name="$2" type="$3" payload="$4" workdir="${5:-$(pwd)}"
    local sess_name="${group}-${name}"
    if _session_exists "$sess_name"; then
        msg_warn "会话 ${bold}${sess_name}${reset} 已存在，跳过"
        return 1
    fi
    local width=200
    [[ "$type" == "agent" ]] && width=220
    # 创建 detached session，注入 env，开启日志
    "$TMUX_BIN" new-session -d -s "$sess_name" -x "$width" -y 50
    _inject_env "$sess_name"
    "$TMUX_BIN" pipe-pane -t "$sess_name" -o "cat >> '${TTMUX_LOGS}/${sess_name}.log'"
    : > "${TTMUX_LOGS}/${sess_name}.log"
    _task_write_meta "$sess_name" "$type" "$payload" "$workdir"

    local run_cmd
    if [[ "$type" == "agent" ]]; then
        run_cmd=$(_agent_cmd "$payload")   # 按 AGENT_KIND 选 claude / codex
    else
        run_cmd="$payload"
    fi
    "$TMUX_BIN" send-keys -t "$sess_name" "$run_cmd" C-m
    # 交互式成员：后台自动确认 claude 首启对话框（setsid 脱离，本命令返回后仍存活）
    if [[ -n "${AGENT_INTERACTIVE:-}" && "$type" == "agent" ]]; then
        setsid bash -c "$(declare -f _spawn_autoconfirm); _spawn_autoconfirm $(printf %q "$sess_name") $(printf %q "$TMUX_BIN")" </dev/null >/dev/null 2>&1 &
    fi
    _group_add_session "$group" "$sess_name"
    return 0
}

_do_spawn() {
    local group="$1"
    shift

    if _group_exists "$group"; then
        msg_warn "任务组 ${bold}${group}${reset} 已存在，追加任务"
    fi

    local count=0
    while [[ $# -ge 2 ]]; do
        local name="$1" cmd="$2"
        shift 2
        if _spawn_one "$group" "$name" "cmd" "$cmd" "$(pwd)"; then
            ((count++)) || true
            msg_ok "启动 ${bold}${group}-${name}${reset}: ${dim}${cmd}${reset}"
        fi
    done

    if [[ $# -eq 1 ]]; then
        msg_warn "忽略落单参数: $1 ${dim}(spawn 需要成对的 name+cmd)${reset}"
    fi

    echo ""
    msg_info "任务组 ${bold}${group}${reset} 已启动 ${count} 个任务"
}

_do_spawn_file() {
    local group="$1" file="$2"
    if [[ ! -f "$file" ]]; then
        msg_err "文件不存在: ${file}"
        return 1
    fi
    local args=()
    while IFS= read -r line; do
        [[ -n "$line" && ! "$line" =~ ^# ]] || continue
        local name cmd
        name=$(echo "$line" | awk '{print $1}')
        cmd=$(echo "$line" | cut -d' ' -f2-)
        args+=("$name" "$cmd")
    done < "$file"
    _do_spawn "$group" "${args[@]}"
}

