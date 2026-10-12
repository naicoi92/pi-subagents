# Trạng thái Jev cutover — WIP

## Đã lưu

- Fork GitHub `naicoi92/pi-subagents`, clone `/Users/naicoi/Projects/pi-subagents`, branch `feat/jev-decisions`.
- Joint Choice cho tuple operator khai báo: agent/persona/model/effort.
- Guardrail credentials, model scope, capability ceiling, supported effort, maxThinking trước Choice.
- Public classifier API của host; timeout, abort, invalid response fail closed; không chat fallback.
- Persona adaptation 78 role chuyên môn từ catalog đã pin; không phải full upstream prompt.
- Single launch và workflow child được nối tại executor. Audit entry chứa tuple, task digest, duration, usage hợp lệ.

## Verify

- Typecheck: PASS (`npm run typecheck`).
- Jev unit: 9/9 PASS.
- Jev child-launch integration mock: 4/4 PASS. Child nhận model:effort và persona; Jev lỗi không launch; UI hỏi operator; runs.run gọi Jev.
- Full unit: 4024 tests, 3984 pass, 23 fail, 17 skipped. Log `/tmp/pi-subagents-jev-unit.log`.
- `git diff --check`: PASS.
- Dependency install: npm do package-lock và CI đã khóa; audit báo 1 high vulnerability, chưa auto-fix.

## Chặn hoàn tất

- Full regression suite chưa pass. Một số fixture vẫn dùng contract main chọn agent/model và thiếu Jev catalog/classifier API; phải migrate test sang contract mới, không thêm legacy bypass để làm xanh.
- Chưa chạy baseline để phân loại fail liên quan môi trường vs cutover (Herdr, npm timeout, native preload).
- Direct composite chain/tasks đang từ chối để tránh bypass Jev; cần chốt chuyển/removal và cập nhật schema/docs/test đồng bộ. Không gọi đây là final implementation.
- Chưa verify async launch thật, nested child classifier availability, scheduled/resume paths.
- Chưa accounting classifier usage vào tool totals; hiện usage mới nằm trong audit.
- Audit append failure đang vào cùng error path; cần riêng classification/audit failure handling.
- Host devDependency Pi 0.87 không có classifier API; runtime dùng structural capability check. Cần verify host Pi-Bolt thật, không tự upgrade dependency toàn repo.
- Chưa cấu hình catalog tuple production của operator; không tự chọn model/cost budget thay operator.
- Chưa E2E Jev thật và child thật. Integration mock không thay E2E.
- Operator đã yêu cầu commit/push và mở Draft PR vào `main` của fork. Draft để review WIP, không phải phê duyệt merge; các gate bên trên vẫn chặn hoàn tất.
