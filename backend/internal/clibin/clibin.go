// Package clibin 内嵌 ttmux CLI 二进制，让 roam 成为单一自包含二进制：
// 当 PATH 上找不到 ttmux 时，把内嵌的二进制解压到 <home>/bin/ttmux 并启用。
//
// 构建时由 CI/脚本把对应 os/arch 的 ttmux 覆盖到本目录的 ttmux（gitignored 为占位文本，
// 仓库里只是 ROAM_CLI_PLACEHOLDER 占位，保证无构建也能编译）。
package clibin

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"os"
	"path/filepath"
)

//go:embed ttmux
var binBytes []byte

var placeholder = []byte("ROAM_CLI_PLACEHOLDER")

// Embedded 报告是否内嵌了真实 ttmux 二进制（而非占位）。
func Embedded() bool {
	return !bytes.HasPrefix(binBytes, placeholder) && len(binBytes) > len(placeholder)
}

// Ensure 把内嵌的 ttmux 解压到 baseDir/bin/ttmux（内容变化才重写），返回可执行文件路径。
// 无真实内嵌时返回 ""。
func Ensure(baseDir string) string {
	if !Embedded() {
		return ""
	}
	dir := filepath.Join(baseDir, "bin")
	path := filepath.Join(dir, "ttmux")
	sum := sha256.Sum256(binBytes)
	tag := hex.EncodeToString(sum[:])[:12]
	stamp := path + ".sha"
	if cur, err := os.ReadFile(stamp); err == nil && string(cur) == tag {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(path, binBytes, 0o755); err != nil {
		return ""
	}
	_ = os.WriteFile(stamp, []byte(tag), 0o644)
	return path
}
