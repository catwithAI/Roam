package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// clearEnv 清掉可能从外部 shell 继承的 ROAM_*/TTMUX_* 覆盖，保证测试可复现。
func clearEnv(t *testing.T) {
	for _, k := range []string{
		"ROAM_WEB_PASSWORD", "TTMUX_WEB_PASSWORD", "ROAM_WEB_BIND", "TTMUX_WEB_BIND",
		"ROAM_WEB_TLS", "TTMUX_WEB_TLS", "ROAM_WEB_TLS_SAN", "TTMUX_WEB_TLS_SAN",
		"ROAM_WEB_TOTP_SECRET", "TTMUX_WEB_TOTP_SECRET", "ROAM_WEB_2FA", "TTMUX_WEB_2FA",
		"ROAM_WEB_LOCK_AFTER", "TTMUX_WEB_LOCK_AFTER", "ROAM_WEB_LOCK_SECS", "TTMUX_WEB_LOCK_SECS",
	} {
		t.Setenv(k, "")
	}
}

// Load 在文件缺失时应从内嵌模板生成，并带默认值、空口令。
func TestLoadCreatesFromTemplate(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("config not created: %v", err)
	}
	if c.Web.Password != "" {
		t.Errorf("fresh config should have empty password, got %q", c.Web.Password)
	}
	if c.Web.Bind == "" || c.Web.LockAfter == 0 || c.Web.LockSecs == 0 {
		t.Errorf("defaults not applied: %+v", c.Web)
	}
}

// SavePassword 只改 password: 行，保留其余注释与字段；再次 Load 应读到新值。
func TestSavePasswordPreservesComments(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if _, err := Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
	before, _ := os.ReadFile(path)
	commentsBefore := strings.Count(string(before), "#")

	if err := SavePassword(path, `p@ss"w\ord`); err != nil {
		t.Fatalf("SavePassword: %v", err)
	}
	after, _ := os.ReadFile(path)
	if strings.Count(string(after), "#") != commentsBefore {
		t.Errorf("comments changed: before=%d after=%d", commentsBefore, strings.Count(string(after), "#"))
	}
	c, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if c.Web.Password != `p@ss"w\ord` {
		t.Errorf("password roundtrip failed, got %q", c.Web.Password)
	}
}

// 环境变量覆盖文件值（ROAM_* 主键 + 旧 TTMUX_* 兼容）。
func TestEnvOverride(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	t.Setenv("ROAM_WEB_BIND", "127.0.0.1:9999")
	t.Setenv("TTMUX_WEB_LOCK_AFTER", "3")
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Web.Bind != "127.0.0.1:9999" {
		t.Errorf("ROAM_WEB_BIND override failed: %q", c.Web.Bind)
	}
	if c.Web.LockAfter != 3 {
		t.Errorf("legacy TTMUX_WEB_LOCK_AFTER override failed: %d", c.Web.LockAfter)
	}
}
