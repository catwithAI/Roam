package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

func postJSON(t *testing.T, r *gin.Engine, url string, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	return w
}

func TestFileMove(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.POST("/file/move", a.FileMove)

	dir := t.TempDir()
	src := filepath.Join(dir, "a.txt")
	os.WriteFile(src, []byte("x"), 0o644)
	destDir := filepath.Join(dir, "sub")
	os.Mkdir(destDir, 0o755)

	// target 是已存在目录 → 移入目录内
	w := postJSON(t, r, "/file/move", gin.H{"path": src, "target": destDir})
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	moved := filepath.Join(destDir, "a.txt")
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("src still exists")
	}

	// 目标已存在同名 → 409
	os.WriteFile(src, []byte("y"), 0o644)
	w = postJSON(t, r, "/file/move", gin.H{"path": src, "target": moved})
	if w.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", w.Code, w.Body.String())
	}

	// 目录移入自身 → 400
	w = postJSON(t, r, "/file/move", gin.H{"path": destDir, "target": filepath.Join(destDir, "inner")})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", w.Code, w.Body.String())
	}
}

func TestFileTouch(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &API{}
	r := gin.New()
	r.POST("/file/touch", a.FileTouch)

	dir := t.TempDir()
	w := postJSON(t, r, "/file/touch", gin.H{"dir": dir, "name": "new.md"})
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	if fi, err := os.Stat(filepath.Join(dir, "new.md")); err != nil || fi.Size() != 0 {
		t.Fatalf("empty file not created: %v", err)
	}

	// 已存在 → 409
	w = postJSON(t, r, "/file/touch", gin.H{"dir": dir, "name": "new.md"})
	if w.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", w.Code, w.Body.String())
	}

	// 带路径成分的名字 → 400
	w = postJSON(t, r, "/file/touch", gin.H{"dir": dir, "name": "../evil"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", w.Code, w.Body.String())
	}
}
