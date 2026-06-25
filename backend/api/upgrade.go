package api

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runGit(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// UpgradeCheck GET /upgrade/check — fetch from remote and report whether the
// current branch has new commits upstream.
func (a *API) UpgradeCheck(c *gin.Context) {
	root, err := repoRoot()
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": false}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()

	branchOut, err := runGit(ctx, root, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": false}})
		return
	}
	branch := strings.TrimSpace(branchOut)

	runGit(ctx, root, "fetch", "--prune")

	// 用实际配置的上游分支（支持 fork 等非 origin 远端），回退到 origin/<branch>
	remote := ""
	if upOut, err := runGit(ctx, root, "rev-parse", "--abbrev-ref", branch+"@{upstream}"); err == nil {
		remote = strings.TrimSpace(upOut)
	} else {
		remote = "origin/" + branch
	}
	if _, err := runGit(ctx, root, "rev-parse", "--verify", remote); err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": false, "branch": branch}})
		return
	}

	behindOut, err := runGit(ctx, root, "rev-list", "--count", "HEAD.."+remote)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": false, "branch": branch}})
		return
	}
	behind, _ := strconv.Atoi(strings.TrimSpace(behindOut))

	if behind == 0 {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": false, "branch": branch}})
		return
	}

	commits := []gitCommit{}
	if logOut, err := runGit(ctx, root, "log", "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar", "HEAD.."+remote); err == nil {
		for _, line := range strings.Split(logOut, "\n") {
			if p := strings.Split(line, "\x1f"); len(p) >= 5 {
				commits = append(commits, gitCommit{Hash: p[0], Short: p[1], Subject: p[2], Author: p[3], When: p[4]})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"available": true,
		"branch":    branch,
		"behind":    behind,
		"commits":   commits,
	}})
}

// runBuild 在 dir 下执行构建命令，返回合并的 stdout+stderr。
func runBuild(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// UpgradeApply POST /upgrade/apply — pull, build, then restart.
func (a *API) UpgradeApply(c *gin.Context) {
	root, err := repoRoot()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"code": "NOT_GIT_REPO"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()

	// 1. git pull
	out, err := runGit(ctx, root, "pull")
	if err != nil {
		gitFail(c, "UPGRADE_PULL_FAILED", out, err)
		return
	}

	// 2. build frontend
	feDir := filepath.Join(root, "frontend")
	if _, err := os.Stat(filepath.Join(feDir, "node_modules")); os.IsNotExist(err) {
		if out, err := runBuild(ctx, feDir, "npm", "install"); err != nil {
			gitFail(c, "UPGRADE_NPM_INSTALL_FAILED", out, err)
			return
		}
	}
	if out, err := runBuild(ctx, feDir, "npx", "vite", "build"); err != nil {
		gitFail(c, "UPGRADE_FRONTEND_BUILD_FAILED", out, err)
		return
	}

	// 3. build backend
	beDir := filepath.Join(root, "backend")
	if out, err := runBuild(ctx, beDir, "go", "build", "-o", "ttmux-web", "./cmd"); err != nil {
		gitFail(c, "UPGRADE_BACKEND_BUILD_FAILED", out, err)
		return
	}

	// 4. restart
	startScript := filepath.Join(root, "start.sh")
	if _, serr := os.Stat(startScript); serr == nil {
		go func() {
			time.Sleep(500 * time.Millisecond)
			cmd := exec.Command("bash", startScript)
			cmd.Dir = root
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			if err := cmd.Start(); err != nil {
				log.Printf("upgrade: restart failed: %v", err)
			}
		}()
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "output": strings.TrimSpace(out)}})
}
