# ══════════════════════════════════════════
# ── swarm: 蜂群编排 ──
# ══════════════════════════════════════════
#
# 蜂群 = 一个有目标的任务组 + 元数据边车(goal/status/supervisor/deps)。
# 成员就是底层任务组 <swarm> 的会话(<swarm>-<member>)，
# 因此复用 _spawn_one / _status / _collect / _kill_group / _group_* 全套机制。
#
#   ${TTMUX_SWARMS}/<swarm>/
#   ├── goal.txt        目标(可空)
#   ├── status.txt      planning|running|integrating|done|archived
#   ├── supervisor.txt  指挥的 cc 会话名(可空)
#   ├── created.txt
#   └── deps/<member>.txt  依赖的成员名(逗号分隔, 仅有依赖时存在)

_swarm_dir()    { echo "${TTMUX_SWARMS}/${1}"; }
_swarm_exists() { [[ -d "$(_swarm_dir "$1")" ]]; }

# _swarm_meta_get <swarm> <key>   -> 输出值(无则空)
_swarm_meta_get() {
    local f="$(_swarm_dir "$1")/${2}.txt"
    [[ -f "$f" ]] && cat "$f" || true
}
# _swarm_meta_set <swarm> <key> <value>
_swarm_meta_set() {
    local dir; dir=$(_swarm_dir "$1")
    mkdir -p "$dir"
    printf '%s\n' "$3" > "${dir}/${2}.txt"
}

# 成员显示名: 去掉 "<swarm>-" 前缀
_swarm_member_name() {
    local swarm="$1" sess="$2"
    echo "${sess#"${swarm}"-}"
}

# 依赖读写
_swarm_dep_get() { local f="$(_swarm_dir "$1")/deps/${2}.txt"; [[ -f "$f" ]] && cat "$f" || true; }
_swarm_dep_set() {
    local dir="$(_swarm_dir "$1")/deps"
    mkdir -p "$dir"
    printf '%s\n' "$3" > "${dir}/${2}.txt"
}

# ── 完成标记：指挥(cc)判定成员已完成后显式打标，供依赖解锁 ──
#
# agent 成员是长驻会话(claude 不退出)，pane_dead 永不触发，靠脚本判不出「完成」。
# 因此由指挥读输出做 AI 判断，再 `ttmux swarm done <群> <成员>` 打标记：
#   ${TTMUX_SWARMS}/<群>/done/<成员>   (空文件即标记)
# _swarm_member_done 优先认这个标记，于是下游依赖随之解锁。
_swarm_done_dir() { echo "$(_swarm_dir "$1")/done"; }
_swarm_member_marked_done() { [[ -f "$(_swarm_done_dir "$1")/${2}" ]]; }
_swarm_member_mark_done() {
    local d; d=$(_swarm_done_dir "$1"); mkdir -p "$d"; : > "${d}/${2}"
}
# 列出已显式标记完成的成员名(每行一个)
_swarm_done_list() {
    local root; root=$(_swarm_done_dir "$1")
    [[ -d "$root" ]] || return 0
    shopt -s nullglob
    local f
    for f in "$root"/*; do basename "$f"; done
}

# ── 依赖门控：pending 成员存储 + 解锁 ──
#
# 有依赖且依赖未满足的成员不立即 spawn，而是挂起为 pending：
#   ${TTMUX_SWARMS}/<群>/pending/<成员>/{type,payload,workdir,model,perm}.txt
# 依赖满足后由 _swarm_activate 取出 spec 真正 spawn 并清除 pending。

_swarm_pending_root() { echo "$(_swarm_dir "$1")/pending"; }
_swarm_pending_dir()  { echo "$(_swarm_dir "$1")/pending/${2}"; }

# _swarm_pending_set <群> <成员> <type> <payload> <workdir> <model> <perm>
_swarm_pending_set() {
    local d; d=$(_swarm_pending_dir "$1" "$2")
    mkdir -p "$d"
    printf '%s\n' "$3" > "${d}/type.txt"
    printf '%s\n' "$4" > "${d}/payload.txt"
    printf '%s\n' "$5" > "${d}/workdir.txt"
    printf '%s\n' "$6" > "${d}/model.txt"
    printf '%s\n' "$7" > "${d}/perm.txt"
}
_swarm_pending_clear() { rm -rf "$(_swarm_pending_dir "$1" "$2")"; }

# 列出 pending 成员名（每行一个）
_swarm_pending_list() {
    local root; root=$(_swarm_pending_root "$1")
    [[ -d "$root" ]] || return 0
    shopt -s nullglob
    local d
    for d in "$root"/*/; do basename "$d"; done
}

# 成员是否已完成（用于依赖解锁）：
#   1) 指挥显式标记完成(done 标记) —— agent 成员主要靠这条；
#   2) 会话已退出(pane_dead)；
#   3) 会话已消失但跑过(有日志)。
# 仍 pending（从未 spawn、无日志）的成员 -> 未完成。
_swarm_member_done() {
    _swarm_member_marked_done "$1" "$2" && return 0
    local sess="${1}-${2}"
    if _session_exists "$sess"; then
        local dead
        dead=$("$TMUX_BIN" display-message -t "$sess" -p '#{pane_dead}' 2>/dev/null || echo 0)
        [[ "$dead" == "1" ]]
    else
        [[ -f "${TTMUX_LOGS}/${sess}.log" ]]
    fi
}

# 某成员的依赖是否全部满足（空依赖视为满足）
_swarm_deps_satisfied() {
    local swarm="$1" member="$2" deps d
    deps=$(_swarm_dep_get "$swarm" "$member")
    [[ -n "$deps" ]] || return 0
    local IFS=','
    for d in $deps; do
        d="${d#"${d%%[![:space:]]*}"}"; d="${d%"${d##*[![:space:]]}"}"   # trim
        [[ -n "$d" ]] || continue
        _swarm_member_done "$swarm" "$d" || return 1
    done
    return 0
}

# 取出 pending spec 并真正 spawn 一个成员
_swarm_spawn_pending() {
    local swarm="$1" member="$2"
    local d; d=$(_swarm_pending_dir "$swarm" "$member")
    local type payload workdir model perm
    type=$(cat "${d}/type.txt" 2>/dev/null)
    payload=$(cat "${d}/payload.txt" 2>/dev/null)
    workdir=$(cat "${d}/workdir.txt" 2>/dev/null)
    model=$(cat "${d}/model.txt" 2>/dev/null)
    perm=$(cat "${d}/perm.txt" 2>/dev/null)
    if [[ "$type" == "agent" ]]; then
        _agent_defaults
        AGENT_WORKDIR="$workdir"
        [[ -n "$model" ]] && AGENT_MODEL="$model"
        [[ -n "$perm" ]]  && AGENT_PERMISSION="$perm"
    fi
    _spawn_one "$swarm" "$member" "$type" "$payload" "$workdir"
}

# ttmux swarm activate <群> [成员] [--quiet] [--force]
# 扫描 pending 成员，依赖已满足的真正启动；级联解锁直到无新增。
# --force: 无视依赖强制解锁(配合指定成员用，逃生口；如依赖成员失败但仍要继续)。
_swarm_activate() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local only="" quiet="" force=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --quiet) quiet=1; shift ;;
            --force) force=1; shift ;;
            *) only="$1"; shift ;;
        esac
    done
    local total_launched=0 changed=1
    while (( changed )); do
        changed=0
        local m
        while IFS= read -r m; do
            [[ -n "$m" ]] || continue
            [[ -n "$only" && "$m" != "$only" ]] && continue
            if [[ -n "$force" ]] || _swarm_deps_satisfied "$swarm" "$m"; then
                if _swarm_spawn_pending "$swarm" "$m"; then
                    _swarm_pending_clear "$swarm" "$m"
                    ((total_launched++)) || true
                    changed=1
                    local why="(依赖已满足)"; [[ -n "$force" ]] && why="(强制解锁, 无视依赖)"
                    [[ -z "$quiet" ]] && msg_ok "解锁成员 ${bold}${m}${reset} ${dim}${why}${reset}"
                fi
            fi
        done < <(_swarm_pending_list "$swarm")
        [[ -n "$only" ]] && break   # 指定单成员时不级联
    done
    if [[ -z "$quiet" ]]; then
        if (( total_launched > 0 )); then
            _swarm_meta_set "$swarm" status "running"
        else
            local rest; rest=$(_swarm_pending_list "$swarm" | grep -c . || true)
            if (( rest > 0 )); then
                msg_info "无可解锁成员 ${dim}(还有 ${rest} 个在等依赖)${reset}"
            else
                msg_info "没有挂起的成员"
            fi
        fi
    fi
    return 0
}

# ── 命令 ──

# ttmux swarm new <名> [--goal "..."]
_swarm_new() {
    local name="$1"; shift || true
    [[ -n "$name" ]] || { msg_err "用法: ttmux swarm new <名> [--goal \"...\"]"; return 1; }
    if _swarm_exists "$name"; then
        msg_warn "蜂群 ${bold}${name}${reset} 已存在"
        return 1
    fi
    local goal=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --goal) goal="$2"; shift 2 ;;
            *) shift ;;
        esac
    done
    mkdir -p "$(_swarm_dir "$name")"
    _swarm_meta_set "$name" goal "$goal"
    _swarm_meta_set "$name" status "planning"
    _swarm_meta_set "$name" supervisor ""
    _swarm_meta_set "$name" created "$(date '+%Y-%m-%d %H:%M:%S')"
    msg_ok "蜂群 ${bold}${name}${reset} 已创建"
    [[ -n "$goal" ]] && echo -e "   ${dim}目标: ${goal}${reset}"
    echo -e "   ${dim}加成员: ttmux swarm add ${name} <名> --type agent \"<任务>\"${reset}"
}

# ttmux swarm add <群> <成员> [--type task|agent] [--dir/--perm/--model] [--depends-on a,b] <payload...>
_swarm_add() {
    local swarm="$1" member="$2"
    shift 2 2>/dev/null || { msg_err "用法: ttmux swarm add <群> <成员> [--type task|agent] <命令或任务>"; return 1; }
    if ! _swarm_exists "$swarm"; then
        msg_err "蜂群不存在: ${swarm}  ${dim}(先 ttmux swarm new ${swarm})${reset}"
        return 1
    fi
    [[ -n "$member" ]] || { msg_err "成员名不能为空"; return 1; }

    local type="agent" workdir model="" perm="" deps="" payload_parts=()
    _agent_defaults
    workdir="$AGENT_WORKDIR"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --type)       type="$2"; shift 2 ;;
            --dir)        workdir="$2"; shift 2 ;;
            --model)      model="$2"; shift 2 ;;
            --perm)       perm="$2"; shift 2 ;;
            --depends-on) deps="$2"; shift 2 ;;
            *)            payload_parts+=("$1"); shift ;;
        esac
    done
    local payload="${payload_parts[*]}"
    if [[ -z "$payload" ]]; then
        msg_err "缺少${type}内容: ${dim}命令(task) 或 任务描述(agent)${reset}"
        return 1
    fi
    if [[ "$type" != "task" && "$type" != "agent" ]]; then
        msg_err "--type 只能是 task 或 agent"
        return 1
    fi

    # 记录依赖（供 status 展示 + 门控判断）
    [[ -n "$deps" ]] && _swarm_dep_set "$swarm" "$member" "$deps"

    # 依赖门控：有依赖且未满足 -> 挂起为 pending，不立即 spawn
    if [[ -n "$deps" ]] && ! _swarm_deps_satisfied "$swarm" "$member"; then
        _swarm_pending_set "$swarm" "$member" "$type" "$payload" "$workdir" "$model" "$perm"
        _swarm_meta_set "$swarm" status "running"
        local suffix=""; (( ${#payload} > 60 )) && suffix="..."
        msg_info "成员 ${bold}${member}${reset} (${type}) ${yellow}已挂起${reset}: ${dim}${payload:0:60}${suffix}${reset}"
        echo -e "   ${dim}等待依赖完成: ${deps}  (依赖满足后自动解锁，或 ttmux swarm activate ${swarm})${reset}"
        return 0
    fi

    # agent 成员: 设置 AGENT_* 供 _agent_claude_cmd 使用
    if [[ "$type" == "agent" ]]; then
        AGENT_WORKDIR="$workdir"
        [[ -n "$model" ]] && AGENT_MODEL="$model"
        [[ -n "$perm" ]]  && AGENT_PERMISSION="$perm"
    fi

    # 成员 = 任务组 <swarm> 的会话；底层类型 agent 走 claude，task 走 shell
    if _spawn_one "$swarm" "$member" "$type" "$payload" "$workdir"; then
        _swarm_meta_set "$swarm" status "running"
        local suffix=""; (( ${#payload} > 60 )) && suffix="..."
        msg_ok "成员 ${bold}${member}${reset} (${type}): ${dim}${payload:0:60}${suffix}${reset}"
        [[ -n "$deps" ]] && echo -e "   ${dim}依赖: ${deps} (已满足)${reset}"
        return 0
    fi
    return 1
}

# ttmux swarm ls
_swarm_ls() {
    shopt -s nullglob
    local dirs=("${TTMUX_SWARMS}"/*/)
    if [[ ${#dirs[@]} -eq 0 ]]; then
        msg_info "没有蜂群  ${dim}(ttmux swarm new <名> 创建)${reset}"
        return
    fi
    echo ""
    for d in "${dirs[@]}"; do
        local name; name=$(basename "$d")
        local goal status sup total=0 alive=0
        goal=$(_swarm_meta_get "$name" goal)
        status=$(_swarm_meta_get "$name" status)
        sup=$(_swarm_meta_get "$name" supervisor)
        while IFS= read -r sess; do
            [[ -n "$sess" ]] || continue
            ((total++)) || true
            _session_exists "$sess" && ((alive++)) || true
        done < <(_group_sessions "$name")
        # 状态着色
        local st_str
        case "$status" in
            running)     st_str="${yellow}running${reset}" ;;
            done)        st_str="${green}done${reset}" ;;
            integrating) st_str="${cyan}integrating${reset}" ;;
            archived)    st_str="${dim}archived${reset}" ;;
            *)           st_str="${dim}${status:-planning}${reset}" ;;
        esac
        local pend; pend=$(_swarm_pending_list "$name" | grep -c . || true)
        local pend_str=""; (( pend > 0 )) && pend_str="  ${yellow}+${pend}待解锁${reset}"
        echo -e "   ${icon_group} ${bold}${name}${reset}  ${dim}${alive}/${total} 活跃${reset}${pend_str}  ${st_str}$( [[ -n "$sup" ]] && echo "  ${magenta}◆${sup}${reset}" )"
        [[ -n "$goal" ]] && echo -e "       ${dim}${goal}${reset}"
    done
    echo ""
}

# ttmux swarm status <群>
_swarm_status() {
    local name="$1"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    # 巡检/查看顺手解锁依赖已满足的 pending 成员（静默）
    _swarm_activate "$name" --quiet >/dev/null 2>&1 || true
    local goal status sup created
    goal=$(_swarm_meta_get "$name" goal)
    status=$(_swarm_meta_get "$name" status)
    sup=$(_swarm_meta_get "$name" supervisor)
    created=$(_swarm_meta_get "$name" created)
    echo ""
    echo -e "  ${magenta}◆${reset} ${bold}蜂群: ${name}${reset}   ${dim}[${status:-planning}]${reset}"
    [[ -n "$goal" ]]    && echo -e "    ${dim}目标:${reset} ${goal}"
    [[ -n "$sup" ]]     && echo -e "    ${dim}指挥:${reset} ${magenta}${sup}${reset}"
    [[ -n "$created" ]] && echo -e "    ${dim}创建:${reset} ${dim}${created}${reset}"
    # 成员状态 + 依赖
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        local m dep
        m=$(_swarm_member_name "$name" "$sess")
        dep=$(_swarm_dep_get "$name" "$m")
        [[ -n "$dep" ]] && echo -e "    ${dim}└ ${m} 依赖→ ${dep}${reset}"
    done < <(_group_sessions "$name")
    # 复用任务组状态(逐会话 running/done)；还没有成员时不报错
    if _group_exists "$name"; then
        _status "$name" || true
    elif [[ -z "$(_swarm_pending_list "$name")" ]]; then
        echo -e "    ${dim}(还没有成员，用 a) 加成员)${reset}"
    fi
    # 挂起(pending)成员：等依赖解锁
    local p first=1
    while IFS= read -r p; do
        [[ -n "$p" ]] || continue
        if (( first )); then
            echo -e "  ${dim}── 挂起(等依赖) ──${reset}"
            first=0
        fi
        echo -e "  ${yellow}${icon_run:-⏳}${reset} ${bold}${name}-${p}${reset} ${yellow}挂起${reset}  ${dim}依赖→ $(_swarm_dep_get "$name" "$p")${reset}"
    done < <(_swarm_pending_list "$name")
    # 指挥已显式标记完成的成员(供解锁参考)
    local dm; dm=$(_swarm_done_list "$name" | paste -sd, - 2>/dev/null || true)
    [[ -n "$dm" ]] && echo -e "  ${dim}✔ 已标记完成: ${dm}${reset}"
    return 0
}

# ttmux swarm collect <群> [--json]
_swarm_collect() {
    local name="$1" fmt="${2:-text}"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if ! _group_exists "$name"; then
        msg_info "蜂群 ${bold}${name}${reset} 还没有成员"
        return 0
    fi
    _collect "$name" "$fmt" || true
    return 0
}

# ttmux swarm adopt <群> [--by <cc会话>] [--dir <目录>]
# cc 接管：写 supervisor + 拉起(或复用)一个交互式 cc 会话并注入 /cc-swarm --swarm <群>
_swarm_adopt() {
    local swarm="$1"; shift || true
    if ! _swarm_exists "$swarm"; then msg_err "蜂群不存在: ${swarm}"; return 1; fi
    local cc="" dir; dir="$(pwd)"
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --by)  cc="$2"; shift 2 ;;
            --dir) dir="$2"; shift 2 ;;
            *)     shift ;;
        esac
    done
    [[ -n "$cc" ]] || cc="cc-${swarm}"

    _swarm_meta_set "$swarm" supervisor "$cc"
    _swarm_meta_set "$swarm" status "running"

    local invoke="/cc-swarm --swarm ${swarm}"
    if _session_exists "$cc"; then
        # 复用已有 cc 会话：直接发指令
        "$TMUX_BIN" send-keys -t "$cc" "$invoke" C-m
        msg_ok "已让现有会话 ${bold}${cc}${reset} 接管蜂群 ${bold}${swarm}${reset}"
    else
        # 新建交互式 claude 会话作为指挥
        local claude_bin; claude_bin="$(command -v claude || echo claude)"
        "$TMUX_BIN" new-session -d -s "$cc" -x 220 -y 50
        _inject_env "$cc"
        "$TMUX_BIN" pipe-pane -t "$cc" -o "cat >> '${TTMUX_LOGS}/${cc}.log'"
        : > "${TTMUX_LOGS}/${cc}.log"
        # 用初始 prompt 直接拉起 cc-swarm 监护(交互式，便于审批/追加指令)
        "$TMUX_BIN" send-keys -t "$cc" "cd '${dir}' && ${claude_bin} '${invoke}'" C-m
        msg_ok "已拉起指挥会话 ${bold}${cc}${reset} 接管蜂群 ${bold}${swarm}${reset}"
    fi
    echo -e "   ${dim}附加查看:  ttmux a ${cc}${reset}"
    echo -e "   ${dim}若指挥未自动开始，附加后手动发:  ${invoke}${reset}"
}

# ttmux swarm done <群> [成员]
#   无成员 -> 标记整群完成(不杀会话)。
#   带成员 -> 标记该成员完成(指挥判定后打标)，并级联解锁等它的下游 pending 成员。
_swarm_done() {
    local name="$1" member="${2:-}"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if [[ -n "$member" ]]; then
        _swarm_member_mark_done "$name" "$member"
        msg_ok "成员 ${bold}${name}-${member}${reset} 已标记完成 ${dim}(会话不动)${reset}"
        # 标记后顺手解锁下游(依赖它的挂起成员)
        _swarm_activate "$name" || true
        return 0
    fi
    _swarm_meta_set "$name" status "done"
    msg_ok "蜂群 ${bold}${name}${reset} 已标记完成"
}

# ttmux swarm archive <群> — 杀会话、保留元数据、置 archived
_swarm_archive() {
    local name="$1"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if _group_exists "$name"; then
        _kill_group "$name"   # 优雅退出 agent + 杀会话 + 清任务元数据 + 删 .group 文件
    fi
    _swarm_meta_set "$name" status "archived"
    msg_ok "蜂群 ${bold}${name}${reset} 已归档 ${dim}(会话已清，元数据保留)${reset}"
}

# ttmux swarm rm <群> — 彻底删除(杀会话 + 删全部元数据)
_swarm_rm() {
    local name="$1"
    if ! _swarm_exists "$name"; then msg_err "蜂群不存在: ${name}"; return 1; fi
    if ! _confirm "确定彻底删除蜂群 ${bold}${name}${reset}(含会话与元数据)?"; then
        msg_info "已取消"; return 0
    fi
    _group_exists "$name" && _kill_group "$name" >/dev/null 2>&1 || true
    rm -rf "$(_swarm_dir "$name")"
    msg_ok "蜂群 ${bold}${name}${reset} 已删除"
}

# ══════════════════════════════════════════
# ── 交互式：两层蜂群界面 ──
# ══════════════════════════════════════════

# 选一个蜂群（提示打到 stderr，选中名打到 stdout）
_pick_swarm() {
    local prompt="${1:-选择蜂群}"
    local swarms=()
    shopt -s nullglob
    for d in "${TTMUX_SWARMS}"/*/; do
        swarms+=("$(basename "$d")")
    done
    if [[ ${#swarms[@]} -eq 0 ]]; then
        msg_info "没有蜂群" >&2
        return 1
    fi
    if [[ ${#swarms[@]} -eq 1 ]]; then
        echo "${swarms[0]}"; return 0
    fi
    echo "" >&2
    echo -e "  ${bold}${prompt}:${reset}" >&2
    local i=1
    for s in "${swarms[@]}"; do
        echo -e "    ${cyan}${i}${reset}) ${s}  ${dim}[$(_swarm_meta_get "$s" status)]${reset}" >&2
        ((i++)) || true
    done
    echo "" >&2
    read -r -p "  编号: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#swarms[@]} )); then
        echo "${swarms[$((choice-1))]}"
    else
        return 1
    fi
}

# 第一层：新建蜂群
_interactive_swarm_new() {
    read -r -p "  蜂群名称: " sname </dev/tty
    [[ -n "$sname" ]] || return
    read -r -p "  目标 (可空): " sgoal </dev/tty
    echo ""
    if [[ -n "$sgoal" ]]; then
        _swarm_new "$sname" --goal "$sgoal"
    else
        _swarm_new "$sname"
    fi
    # 顺手问要不要进去加成员
    echo ""
    read -r -p "  现在进入该蜂群加成员? [Y/n]: " yn </dev/tty
    case "${yn:-y}" in
        n|N) ;;
        *) _interactive_swarm_detail "$sname" ;;
    esac
}

# 第二层：加成员
_interactive_swarm_add_member() {
    local swarm="$1"
    read -r -p "  成员名称: " mname </dev/tty
    [[ -n "$mname" ]] || return
    echo -e "  ${bold}类型:${reset}  ${cyan}1${reset}) shell 命令   ${cyan}2${reset}) Claude Agent"
    read -r -p "  选择 [2]: " mt </dev/tty
    echo ""
    if [[ "${mt:-2}" == "1" ]]; then
        read -r -p "  命令: " mcmd </dev/tty
        [[ -n "$mcmd" ]] || { msg_warn "命令为空，取消"; return; }
        read -r -p "  依赖成员 (逗号分隔, 可空): " mdep </dev/tty
        if [[ -n "$mdep" ]]; then
            _swarm_add "$swarm" "$mname" --type task --depends-on "$mdep" "$mcmd"
        else
            _swarm_add "$swarm" "$mname" --type task "$mcmd"
        fi
    else
        read -r -p "  任务描述: " mtask </dev/tty
        [[ -n "$mtask" ]] || { msg_warn "任务为空，取消"; return; }
        read -r -p "  工作目录 [$(pwd)]: " mdir </dev/tty
        mdir="${mdir:-$(pwd)}"
        read -r -p "  权限 (auto/plan/default) [auto]: " mperm </dev/tty
        mperm="${mperm:-auto}"
        read -r -p "  依赖成员 (逗号分隔, 可空): " mdep </dev/tty
        local args=("$swarm" "$mname" --type agent --dir "$mdir" --perm "$mperm")
        [[ -n "$mdep" ]] && args+=(--depends-on "$mdep")
        args+=("$mtask")
        _swarm_add "${args[@]}"
    fi
}

# 第二层：对某成员追加指令
_interactive_swarm_send() {
    local swarm="$1"
    local members=()
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        members+=("$sess")
    done < <(_group_sessions "$swarm")
    if [[ ${#members[@]} -eq 0 ]]; then msg_info "该蜂群还没有成员"; return; fi
    echo ""
    echo -e "  ${bold}成员:${reset}"
    local i=1
    for m in "${members[@]}"; do
        local run; _session_exists "$m" && run=" ${yellow}运行中${reset}" || run=" ${dim}已结束${reset}"
        echo -e "    ${cyan}${i}${reset}) $(_swarm_member_name "$swarm" "$m")${run}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  选择成员编号: " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#members[@]} )); then
        read -r -p "  追加指令: " msg </dev/tty
        [[ -n "$msg" ]] && _task_send "${members[$((choice-1))]}" "$msg"
    else
        msg_err "无效选择"
    fi
}

# 选一个成员标记完成 -> 解锁下游
_interactive_swarm_mark_done() {
    local swarm="$1"
    local members=()
    while IFS= read -r sess; do
        [[ -n "$sess" ]] || continue
        members+=("$(_swarm_member_name "$swarm" "$sess")")
    done < <(_group_sessions "$swarm")
    if [[ ${#members[@]} -eq 0 ]]; then msg_info "该蜂群还没有成员"; return; fi
    echo ""
    echo -e "  ${bold}成员:${reset}"
    local i=1
    for m in "${members[@]}"; do
        local mk=""; _swarm_member_marked_done "$swarm" "$m" && mk=" ${dim}✔已标记${reset}"
        echo -e "    ${cyan}${i}${reset}) ${m}${mk}"
        ((i++)) || true
    done
    echo ""
    read -r -p "  标记哪个成员完成(编号): " choice </dev/tty
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#members[@]} )); then
        _swarm_done "$swarm" "${members[$((choice-1))]}"
    else
        msg_err "无效选择"
    fi
}

# 第二层主循环：蜂群详情 / 成员管理
_interactive_swarm_detail() {
    local swarm="$1"
    while true; do
        clear
        _swarm_status "$swarm"
        echo ""
        echo -e "  ${bold}蜂群 ${swarm} ─ 成员管理${reset}"
        echo -e "    ${cyan}a${reset}) 加成员            ${cyan}m${reset}) 追加指令"
        echo -e "    ${cyan}f${reset}) 标记成员完成      ${cyan}u${reset}) 解锁挂起成员"
        echo -e "    ${cyan}c${reset}) 等待并收集        ${cyan}d${reset}) cc 接管"
        echo -e "    ${cyan}k${reset}) 清理整群          ${cyan}b${reset}) 返回上层"
        echo ""
        read -r -p "  选择: " act </dev/tty
        echo ""
        case "$act" in
            a) _interactive_swarm_add_member "$swarm" || true; _interactive_pause ;;
            m) _interactive_swarm_send "$swarm" || true; _interactive_pause ;;
            f) _interactive_swarm_mark_done "$swarm" || true; _interactive_pause ;;
            u) _swarm_activate "$swarm" || true; _interactive_pause ;;
            c) _do_wait_group "$swarm" 300 || true; echo ""; _swarm_collect "$swarm" text || true; _interactive_pause ;;
            k)
                if _confirm "清理整群 ${bold}${swarm}${reset} (杀全部成员会话)?"; then
                    _swarm_archive "$swarm" || true
                fi
                _interactive_pause; return ;;
            d) _swarm_adopt "$swarm" || true; _interactive_pause ;;
            b|q|"") return ;;
            *) msg_warn "无效选择"; _interactive_pause ;;
        esac
    done
}

# 第一层主循环：蜂群管理
_interactive_swarm() {
    while true; do
        clear
        echo ""
        echo -e "  ${bold}任务编排 ${magenta}(蜂群 / swarm)${reset}"
        echo -e "  ${dim}$(printf '─%.0s' {1..44})${reset}"
        _swarm_ls
        echo -e "    ${cyan}n${reset}) 新建蜂群          ${cyan}e${reset}) 进入蜂群 ▸"
        echo -e "    ${cyan}d${reset}) cc 接管蜂群       ${cyan}x${reset}) 归档/删除蜂群"
        echo -e "    ${cyan}b${reset}) 返回主菜单"
        echo ""
        read -r -p "  选择: " act </dev/tty
        echo ""
        case "$act" in
            n) _interactive_swarm_new || true; _interactive_pause ;;
            e)
                local s; s=$(_pick_swarm "进入蜂群") || { _interactive_pause; continue; }
                _interactive_swarm_detail "$s" || true ;;
            d)
                local s; s=$(_pick_swarm "cc 接管") || { _interactive_pause; continue; }
                _swarm_adopt "$s" || true; _interactive_pause ;;
            x)
                local s; s=$(_pick_swarm "归档/删除") || { _interactive_pause; continue; }
                echo -e "  ${cyan}1${reset}) 归档(留元数据)  ${cyan}2${reset}) 彻底删除  ${cyan}0${reset}) 取消"
                read -r -p "  选择: " xa </dev/tty
                case "$xa" in
                    1) _swarm_archive "$s" || true ;;
                    2) _swarm_rm "$s" || true ;;
                esac
                _interactive_pause ;;
            b|q|"") return ;;
            *) msg_warn "无效选择"; _interactive_pause ;;
        esac
    done
}
