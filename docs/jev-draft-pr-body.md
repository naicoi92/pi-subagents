## Summary

**Draft — chưa merge-ready.** Thay quyết định child launch bằng một Jev Choice cho tuple `(agent, persona, model, effort)`; model và effort không được chọn độc lập.

```text
single launch / workflow runs.run
  catalog tuple do operator khai báo
  guardrail lọc candidate hợp lệ
  Jev chọn một tuple
    lỗi → dừng, hỏi operator; không main-agent fallback
    hợp lệ → ghép role prompt → audit → child launch
```

- Guardrail: credentials, model scope, capability ceiling, supported effort, `maxThinking`.
- 78 role adaptation tiếng Việt có provenance Agency Agents; chưa phải full upstream prompt đã audit.
- Audit chứa tuple, task digest, duration và classifier usage hợp lệ; không ghi raw task/provider error.

## Evidence

- **Before:** Chạy `test/unit/jev-decisions.test.ts` trước implementation thất bại với `ERR_MODULE_NOT_FOUND` cho `src/agents/jev-decisions.ts`. Đây là RED do module chưa tồn tại, không phải baseline chứng minh bug routing cũ.
  **After:** Cùng unit test **9/9 pass**; chứng minh joint Choice, guardrail, timeout và invalid response.
- **Before:** Hint `agent: "scout"` do caller truyền.
  **After:** Test `AC-4 persona-launch` chứng minh mock child nhận `worker`, `mock/test-model:high` và role Code Reviewer do Jev stub chọn. `AC-7 workflow-child` chứng minh workflow child đi qua cùng boundary. **4/4 integration test pass**, dùng classifier/child mock, không phải E2E Jev thật.
- **Typecheck:** `npm run typecheck` pass; `git diff --check` pass.
- **Full unit suite:** `npm run test:unit` → **4024 tests: 3984 pass, 23 fail, 17 skipped**. Chưa chạy baseline để phân loại tất cả failure; không khẳng định mọi failure đều do môi trường hoặc fixture cũ.

**Gate còn chặn:** migration regression fixtures; schema/docs cho direct chain/tasks đang bị từ chối; async/nested/scheduled/resume verification; classifier usage accounting trong tool totals; tách audit failure khỏi classification failure; catalog production và E2E Jev/child thật. Chi tiết: [trạng thái implementation](jev-implementation-status.md).

## Merge Danger

**Door:** two-way

Có thể revert code; không migration dữ liệu phá hủy. Chưa cài thay extension đang dùng.

**Blast Radius:** Delegation

Cutover thay contract launch toàn executor: thiếu `jev.candidates` hoặc public classifier API sẽ chặn child launch; `agent/model` caller truyền chỉ còn hint/đầu vào bị thay bằng tuple Jev. Direct composite chain/tasks bị từ chối. Async/nested và các đường điều khiển chưa verify đầy đủ.

Task gửi tới Jev provider đã cấu hình; operator phải chọn provider tin cậy. Không merge draft khi regression suite và runtime E2E chưa đạt.
